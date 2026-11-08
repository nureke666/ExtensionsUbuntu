#!/usr/bin/env bash
# End-to-end check in a headless GNOME Shell with two monitors (nothing shows
# on screen, the real session is not touched): presses Super+Enter with a
# virtual keyboard and checks where gnome-terminal is and whether it is shown.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="dropdown-terminal@nurik.local"

if [ "${1:-}" != inner ]; then
    T="$(mktemp -d)"
    trap 'fusermount -u "$T/run/gvfs" 2>/dev/null; rm -rf "$T"' EXIT
    ext="$T/data/gnome-shell/extensions"
    mkdir -p "$ext/unsafe-mode@test.local" "$T/config"
    cp -r "$here/$uuid" "$ext/"
    glib-compile-schemas "$ext/$uuid/schemas"
    # Turns on unsafe mode so the test can drive the shell through Eval.
    cat > "$ext/unsafe-mode@test.local/metadata.json" <<'EOF'
{"uuid": "unsafe-mode@test.local", "name": "unsafe", "description": "test", "shell-version": ["46"]}
EOF
    cat > "$ext/unsafe-mode@test.local/extension.js" <<'EOF'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
EOF
    # GTK apps (gnome-terminal too) wait 25 s for xdg-desktop-portal, which
    # does not start on a bare session bus; this one fails at once instead.
    mkdir -p "$T/data/dbus-1/services"
    cat > "$T/data/dbus-1/services/org.freedesktop.portal.Desktop.service" <<'EOF'
[D-BUS Service]
Name=org.freedesktop.portal.Desktop
Exec=/bin/false
EOF
    # Own runtime dir: the shell keeps its crash guard file there, and the
    # real session's one must not be touched.
    export XDG_RUNTIME_DIR="$T/run"
    mkdir -m 700 -p "$XDG_RUNTIME_DIR"
    export XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" T
    dbus-run-session -- "$0" inner 2>"$T/session.log"
    exit $?
fi

eval_js() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}
wait_for() {
    for _ in $(seq "$(( ${2:-10} * 4 ))"); do
        eval_js "$1" | grep -qF "(true, 'true')" && return 0
        sleep 0.25
    done
    return 1
}
failed=0
check() {
    local start=$SECONDS
    if wait_for "$2" "${3:-10}"; then
        echo "ok   $1${VERBOSE:+ ($((SECONDS - start)) s)}"
    else
        echo "FAIL $1"
        eval_js "dt.dump()"
        failed=1
    fi
}
press() {
    eval_js "dt.key($SUPER, $RETURN)" >/dev/null
}

app_id=org.nurik.DropdownTerminal
# gnome-terminal sizes itself in whole character cells.
tolerance=30
schemas="$XDG_DATA_HOME/gnome-shell/extensions/$uuid/schemas"
dset() {
    gsettings --schemadir "$schemas" set org.gnome.shell.extensions.dropdown-terminal "$@"
}

# Ubuntu's session mode turns on Tiling Assistant, the dock and the desktop
# icons; the icons restart on a bare session and take the focus.
gsettings set org.gnome.shell enabled-extensions "['$uuid', 'unsafe-mode@test.local']"
gsettings set org.gnome.shell disabled-extensions \
    "['tiling-assistant@ubuntu.com', 'ubuntu-dock@ubuntu.com', 'ding@rastersoft.com']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
gsettings set org.gnome.mutter dynamic-workspaces false
gsettings set org.gnome.desktop.wm.preferences num-workspaces 2
# Here gnome-terminal would pick X11 and wait for Xwayland to start.
dset command "['env', 'GDK_BACKEND=wayland', 'gnome-terminal', '--app-id', '$app_id']"

# GTK apps would wait 25 s for the accessibility bus too. The variables of
# the session the test is started from do not belong here.
export NO_AT_BRIDGE=1
# No gvfs: it would mount itself into the test's runtime dir.
export GIO_USE_VFS=local
unset SESSION_MANAGER GNOME_TERMINAL_SCREEN GNOME_TERMINAL_SERVICE
gnome-shell --headless --wayland --wayland-display=dt-e2e \
    --virtual-monitor 1920x1080 --virtual-monitor 1280x800 > "$T/shell.log" 2>&1 &
shell=$!
for _ in $(seq 60); do
    eval_js 1 | grep -q true && break
    sleep 0.5
done

# Helpers for the checks. Monitor 1 is right of monitor 0.
eval_js "$(tr '\n' ' ' <<EOF
const C = imports.gi.Clutter, G = imports.gi.GLib;
const seat = C.get_default_backend().get_default_seat();
const kb = seat.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);
const ptr = seat.create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
Main.overview.hide();
globalThis.dt = {
    terms: () => global.display.list_all_windows().filter(w =>
        w.get_window_type() === 0 && w.get_gtk_application_id() === "$app_id"),
    term: () => dt.terms()[0],
    win: t => global.display.list_all_windows().find(w => w.title === t),
    shown: () => {
        const w = dt.term();
        return !!w && !w.minimized && global.display.focus_window === w && w.above && w.is_on_all_workspaces();
    },
    hidden: () => !!dt.term() && dt.term().minimized,
    atTop: m => {
        const w = dt.term(), f = w.get_frame_rect(), a = Main.layoutManager.getWorkAreaForMonitor(m);
        const near = (x, y) => Math.abs(x - y) <= $tolerance;
        return w.get_monitor() === m && f.y === a.y && near(f.width, a.width) &&
            near(f.height, Math.round(a.height * 0.45)) && near(f.x, a.x);
    },
    key: (...codes) => {
        const send = (c, s) => kb.notify_key(G.get_monotonic_time(), c, s);
        codes.forEach(c => send(c, C.KeyState.PRESSED));
        codes.reverse().forEach(c => send(c, C.KeyState.RELEASED));
        return true;
    },
    pointer: (x, y) => { ptr.notify_absolute_motion(G.get_monotonic_time(), x, y); return true; },
    dump: () => global.display.list_all_windows().filter(w => w.get_window_type() === 0).map(w => {
        const f = w.get_frame_rect();
        return \`\${w.title} \${w.get_gtk_application_id()} m\${w.get_monitor()} \${f.x},\${f.y} \${f.width}x\${f.height}\` +
            \` min=\${w.minimized} above=\${w.above} all=\${w.is_on_all_workspaces()} focus=\${global.display.focus_window === w}\`;
    }).join(" | "),
};
true
EOF
)" >/dev/null

SUPER=125 RETURN=28
uuid_js="\"$uuid\""

# Keys do nothing until the overview the shell starts in has closed.
wait_for '!Main.overview.visible && !Main.overview.animationInProgress' || echo "overview did not close"
eval_js 'dt.pointer(500, 500)' >/dev/null
press
check "Super+Enter opens the terminal at the top, above, on all workspaces" \
    'dt.shown() && dt.atTop(0)'

press
check "the next press hides it" 'dt.hidden()'
press
check "and shows it again" 'dt.shown() && dt.atTop(0)'

press
eval_js 'global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); true' >/dev/null
press
check "it shows on the workspace you are on" \
    'dt.shown() && dt.term().located_on_workspace(global.workspace_manager.get_active_workspace()) && global.workspace_manager.get_active_workspace_index() === 1'

press
eval_js 'dt.pointer(2500, 300)' >/dev/null
press
check "it shows on the monitor under the pointer" 'dt.shown() && dt.atTop(1)'

WAYLAND_DISPLAY=dt-e2e GDK_BACKEND=wayland DISPLAY= python3 "$here/tests/win.py" >/dev/null 2>&1 &
check "another window takes the focus" 'global.display.focus_window?.title === "other"'
press
check "a press brings the terminal back to the front instead of hiding it" 'dt.shown()'

dset hide-on-unfocus true
eval_js 'dt.win("other").activate(global.get_current_time()); true' >/dev/null
check "hide-on-unfocus hides it when another window gets the focus" 'dt.hidden()'
dset hide-on-unfocus false

eval_js 'dt.term().delete(global.get_current_time()); true' >/dev/null
check "the terminal closes" '!dt.term()'
press
check "after closing, a press starts a new one" 'dt.shown() && dt.atTop(1)'

eval_js "Main.extensionManager.disableExtension($uuid_js); true" >/dev/null
check "disabling leaves the terminal open as an ordinary window" \
    "Main.extensionManager.lookup($uuid_js).state !== 1 && dt.terms().length === 1 && !dt.term().above"
eval_js "Main.extensionManager.enableExtension($uuid_js); true" >/dev/null
wait_for "Main.extensionManager.lookup($uuid_js).state === 1 && \"toggle\" in Main.wm._allowedKeybindings" ||
    echo "extension did not enable"
# A press on the focused terminal hides it.
eval_js 'dt.term().activate(global.get_current_time()); true' >/dev/null
wait_for 'global.display.focus_window === dt.term()' || echo "terminal did not take the focus"
press
check "after re-enabling, the running terminal is picked up, not a second one" \
    'dt.hidden() && dt.terms().length === 1 && dt.term().above'

kill $(jobs -p) 2>/dev/null
wait 2>/dev/null
if grep -E "JS ERROR|Bail out|libmutter-CRITICAL" "$T/shell.log"; then
    echo "FAIL errors in the shell log"
    failed=1
fi
[ $failed -eq 0 ] && echo "OK" || echo "FAIL"
exit $failed
