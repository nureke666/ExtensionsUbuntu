#!/usr/bin/env bash
# End-to-end check in a headless GNOME Shell with two monitors (nothing shows
# on screen, the real session is not touched): presses Super+Enter with a
# virtual keyboard and checks the terminal window: where it is, whether it is
# shown, that it stays out of Alt+Tab, and what runs in it (tmux or a shell).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="dropdown-terminal@nurik.local"

if [ "${1:-}" != inner ]; then
    T="$(mktemp -d)"
    # tmux of the test runs in $T and must not outlive it.
    trap 'TMUX_TMPDIR="$T/tmux" tmux -L dropdown kill-server 2>/dev/null
          for m in "$T"/run/gvfs "$T"/run/doc; do fusermount3 -uz "$m" 2>/dev/null; done
          rm -rf "$T"' EXIT
    ext="$T/data/gnome-shell/extensions"
    mkdir -p "$ext/unsafe-mode@test.local" "$ext/no-lock@test.local" "$T/config" "$T/tmux" \
        "$T/data/dbus-1/services"
    cp -r "$here/$uuid" "$ext/"
    glib-compile-schemas "$ext/$uuid/schemas"
    # Turns on unsafe mode so the test can drive the shell through Eval, also
    # on the lock screen.
    cat > "$ext/unsafe-mode@test.local/metadata.json" <<'EOF'
{"uuid": "unsafe-mode@test.local", "name": "unsafe", "description": "test", "shell-version": ["46"],
 "session-modes": ["user", "unlock-dialog"]}
EOF
    cat > "$ext/unsafe-mode@test.local/extension.js" <<'EOF'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
EOF
    # An extension that stops on the lock screen, like most do: GNOME then
    # disables and re-enables every extension enabled after it.
    echo '{"uuid": "no-lock@test.local", "name": "no-lock", "description": "test", "shell-version": ["46"]}' \
        > "$ext/no-lock@test.local/metadata.json"
    echo 'export default class { enable() {} disable() {} }' > "$ext/no-lock@test.local/extension.js"
    # GTK apps wait 25 s for xdg-desktop-portal, which does not start on a
    # bare session bus, and gvfs metadata would still be writing into $T when
    # the test removes it; these stubs fail at once instead.
    for name in org.freedesktop.portal.Desktop org.gtk.vfs.Metadata; do
        printf '[D-BUS Service]\nName=%s\nExec=/bin/false\n' "$name" > "$T/data/dbus-1/services/$name.service"
    done
    # Own runtime dir: the shell keeps its crash guard file there, and the
    # real session's one must not be touched. Likewise tmux and the a11y bus.
    export XDG_RUNTIME_DIR="$T/run" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" T
    export TMUX_TMPDIR="$T/tmux" NO_AT_BRIDGE=1 GIO_USE_VFS=local
    unset SESSION_MANAGER TMUX TMUX_PANE
    mkdir -m 700 -p "$XDG_RUNTIME_DIR"
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
shell_check() {
    if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failed=1; fi
}
SUPER=125 RETURN=28
press() {
    eval_js "dt.key($SUPER, $RETURN)" >/dev/null
}
schemas="$XDG_DATA_HOME/gnome-shell/extensions/$uuid/schemas"
dset() {
    gsettings --schemadir "$schemas" set org.gnome.shell.extensions.dropdown-terminal "$@"
}
tmuxd() {
    tmux -L dropdown "$@" 2>/dev/null
}

# Ubuntu's session mode turns on Tiling Assistant, the dock and the desktop
# icons; the icons restart on a bare session and take the focus.
gsettings set org.gnome.shell enabled-extensions "['$uuid', 'unsafe-mode@test.local', 'no-lock@test.local']"
gsettings set org.gnome.shell disabled-extensions \
    "['tiling-assistant@ubuntu.com', 'ubuntu-dock@ubuntu.com', 'ding@rastersoft.com']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
gsettings set org.gnome.mutter dynamic-workspaces false
gsettings set org.gnome.desktop.wm.preferences num-workspaces 2

gnome-shell --headless --wayland --wayland-display=dt-e2e \
    --virtual-monitor 1920x1080 --virtual-monitor 1280x800 > "$T/shell.log" 2>&1 &
for _ in $(seq 60); do
    eval_js 1 | grep -q true && break
    sleep 0.5
done

# Helpers for the checks. Monitor 1 is right of monitor 0.
eval_js "$(tr '\n' ' ' <<EOF
const C = imports.gi.Clutter, G = imports.gi.GLib, M = imports.gi.Meta;
const seat = C.get_default_backend().get_default_seat();
const kb = seat.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);
const ptr = seat.create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
globalThis.dt = {
    ext: () => Main.extensionManager.lookup("$uuid"),
    term: () => global.display.list_all_windows().find(w => w.get_gtk_application_id() === "org.nurik.DropdownTerminal"),
    win: t => global.display.list_all_windows().find(w => w.title === t),
    shown: () => {
        const w = dt.term();
        return !!w && !w.minimized && global.display.focus_window === w && w.above &&
            w.is_on_all_workspaces() && w.is_skip_taskbar() &&
            w.get_compositor_private().translation_y === 0 && w.get_compositor_private().opacity === 255;
    },
    hidden: () => !!dt.term() && dt.term().minimized,
    atTop: m => {
        const w = dt.term(), f = w.get_frame_rect(), a = Main.layoutManager.getWorkAreaForMonitor(m);
        const width = Math.round(a.width * 0.7), height = Math.round(a.height * 0.45);
        const near = (x, y) => Math.abs(x - y) <= 2;
        return w.get_monitor() === m && f.y === a.y && near(f.width, width) && near(f.height, height) &&
            near(f.x, a.x + Math.round((a.width - width) / 2));
    },
    key: (...codes) => {
        const send = (c, s) => kb.notify_key(G.get_monotonic_time(), c, s);
        codes.forEach(c => send(c, C.KeyState.PRESSED));
        codes.reverse().forEach(c => send(c, C.KeyState.RELEASED));
        return true;
    },
    pointer: (x, y) => { ptr.notify_absolute_motion(G.get_monotonic_time(), x, y); return true; },
    dump: () => global.display.list_all_windows().filter(w => w.get_window_type() === 0).map(w => {
        const f = w.get_frame_rect(), a = w.get_compositor_private();
        return \`\${w.title} \${w.get_gtk_application_id()} m\${w.get_monitor()} \${f.x},\${f.y} \${f.width}x\${f.height}\` +
            \` min=\${w.minimized} above=\${w.above} all=\${w.is_on_all_workspaces()} skip=\${w.is_skip_taskbar()}\` +
            \` focus=\${global.display.focus_window === w} ty=\${a?.translation_y} op=\${a?.opacity}\`;
    }).join(" | "),
};
true
EOF
)" >/dev/null

# Keys do nothing until the overview the shell starts in has closed.
wait_for '!Main.layoutManager._startingUp' || echo "shell did not finish starting"
wait_for '(Main.overview.hide(), !Main.overview.visible && !Main.overview.animationInProgress && global.window_group.visible)' ||
    echo "overview did not close"

eval_js 'dt.pointer(500, 500)' >/dev/null
press
check "Super+Enter slides the terminal down: top, centered, 70% x 45%, above, on all workspaces" \
    'dt.shown() && dt.atTop(0)'
# GNOME leaves windows that skip the taskbar out of Alt+Tab and the dash; a
# window without a frame draws no shadow, so its buffer is its frame.
check "it has no frame and is out of the taskbar and Alt+Tab" \
    '(() => { const w = dt.term(), b = w.get_buffer_rect(), f = w.get_frame_rect(); return w.is_skip_taskbar() && b.width === f.width && b.height === f.height; })()'
shell_check "tmux (the default) runs the session \"dropdown\" on a server of its own" \
    'tmuxd has-session -t dropdown'

press
check "the next press slides it away" 'dt.hidden()'
press
check "and back" 'dt.shown() && dt.atTop(0)'

press
eval_js 'global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); true' >/dev/null
press
check "it comes on the workspace you are on" \
    'dt.shown() && dt.term().located_on_workspace(global.workspace_manager.get_active_workspace()) && global.workspace_manager.get_active_workspace_index() === 1'

press
eval_js 'dt.pointer(2500, 300)' >/dev/null
press
check "and on the monitor under the pointer" 'dt.shown() && dt.atTop(1)'

WAYLAND_DISPLAY=dt-e2e GDK_BACKEND=wayland DISPLAY= python3 "$here/tests/win.py" >/dev/null 2>&1 &
check "another window takes the focus" 'global.display.focus_window?.title === "other"'
press
check "a press brings the terminal back to the front instead of hiding it" 'dt.shown()'

dset hide-on-unfocus true
eval_js 'dt.win("other").activate(global.get_current_time()); true' >/dev/null
check "hide-on-unfocus slides it away when another window gets the focus" 'dt.hidden()'
dset hide-on-unfocus false

eval_js 'dt.pointer(500, 500)' >/dev/null
press
wait_for 'dt.shown()' || echo "terminal did not show"
eval_js 'dt.term().delete(global.get_current_time()); true' >/dev/null
check "closing the window closes the terminal" '!dt.term()'
shell_check "the tmux session outlives the window" 'tmuxd has-session -t dropdown'
press
check "a press starts the terminal again" 'dt.shown() && dt.atTop(0)'
shell_check "and it is back in the same tmux session" '[ "$(tmuxd list-clients -t dropdown | wc -l)" = 1 ]'

dset session plain
eval_js 'dt.term().delete(global.get_current_time()); true' >/dev/null
wait_for '!dt.term()' || echo "terminal did not close"
tmuxd kill-server
press
check "with session = plain a press starts a plain shell" 'dt.shown()'
shell_check "with no tmux" '! tmuxd has-session -t dropdown'

# The terminal closing in ways that once broke things: while it slides away,
# with hide-on-unfocus on, and while the extension is off (enabling then
# crashed the shell on the dead window). Other windows open cleanly after.
wait_for 'dt.shown()' || echo "terminal did not show"
press
eval_js 'dt.term().delete(global.get_current_time()); true' >/dev/null
check "a terminal closed while sliding away is gone" '!dt.term()'
dset hide-on-unfocus true
press
wait_for 'dt.shown()' || echo "terminal did not show"
eval_js 'dt.term().delete(global.get_current_time()); true' >/dev/null
check "a terminal closed with hide-on-unfocus on is gone" '!dt.term()'
dset hide-on-unfocus false
WAYLAND_DISPLAY=dt-e2e GDK_BACKEND=wayland DISPLAY= python3 "$here/tests/win.py" >/dev/null 2>&1 &
wait_for 'global.display.list_all_windows().filter(w => w.title === "other").length === 2' || echo "window did not open"
press
wait_for 'dt.shown()' || echo "terminal did not show"
eval_js "Main.extensionManager.disableExtension(\"$uuid\"); true" >/dev/null
wait_for 'dt.ext().state !== 1' || echo "extension did not stop"
eval_js 'dt.term().delete(global.get_current_time()); true' >/dev/null
wait_for '!dt.term()' || echo "terminal did not close"
eval_js "Main.extensionManager.enableExtension(\"$uuid\"); true" >/dev/null
wait_for 'dt.ext().state === 1' || echo "extension did not enable"
press
check "a terminal closed while the extension was off is forgotten, a press starts a new one" \
    'dt.shown() && dt.atTop(0)'

eval_js "Main.extensionManager.disableExtension(\"$uuid\"); true" >/dev/null
check "disabling leaves the terminal open as an ordinary window" \
    'dt.ext().state !== 1 && !dt.term().above && !dt.term().is_skip_taskbar() && !dt.term().is_on_all_workspaces()'
eval_js "Main.extensionManager.enableExtension(\"$uuid\"); true" >/dev/null
wait_for 'dt.ext().state === 1' || echo "extension did not enable"
check "enabling takes it back" 'dt.term().above && dt.term().is_skip_taskbar() && dt.atTop(0)'

# On the lock screen GNOME re-enables us when no-lock (enabled before us now)
# stops; the terminal must stay above and out of the list meanwhile, or
# Auto Tiling, which also runs there, would tile it.
eval_js "Main.extensionManager.disableExtension(\"$uuid\"); true" >/dev/null
wait_for 'dt.ext().state !== 1' || echo "extension did not stop"
eval_js "Main.extensionManager.enableExtension(\"$uuid\"); true" >/dev/null
wait_for 'dt.ext().state === 1 && dt.atTop(0)' || echo "extension did not enable"
eval_js 'globalThis.seq = dt.term().get_stable_sequence(); globalThis.oldSettings = dt.ext().stateObj._settings; true' >/dev/null
eval_js 'Main.screenShield.lock(false); true' >/dev/null
wait_for 'Main.sessionMode.currentMode === "unlock-dialog"' || echo "the screen did not lock"
check "while locked it is re-enabled and the terminal stays above, out of the list" \
    'dt.ext().state === 1 && dt.ext().stateObj._settings !== oldSettings && dt.term().above && dt.term().is_skip_taskbar()'
eval_js 'Main.screenShield.deactivate(false); true' >/dev/null
wait_for 'Main.sessionMode.currentMode !== "unlock-dialog"' || echo "the screen did not unlock"
check "and the terminal is the same one, still at the top" \
    'dt.term().get_stable_sequence() === seq && dt.term().above && dt.term().is_skip_taskbar() && dt.atTop(0)'

kill $(jobs -p) 2>/dev/null
tmuxd kill-server
wait 2>/dev/null
# Up to the shell's own shutdown: what its last garbage collection says then
# is not seen by anyone.
if sed '/Shutting down GNOME Shell/,$d' "$T/shell.log" |
    grep -E "JS ERROR|Bail out|CRITICAL|crashed|Dropdown Terminal:|dropdown-terminal@nurik.local"; then
    echo "FAIL errors in the shell log"
    failed=1
fi
[ $failed -eq 0 ] && echo "OK" || echo "FAIL"
exit $failed
