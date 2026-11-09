#!/usr/bin/env bash
# End-to-end check in a headless GNOME Shell with two monitors (nothing shows
# on screen, the real session is not touched): opens test windows, presses the
# keys with a virtual keyboard and checks where the windows end up.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="auto-tiling@nurik.local"

if [ "${1:-}" != inner ]; then
    T="$(mktemp -d)"
    # Services started on the test bus may leave FUSE mounts in the runtime dir.
    trap 'for m in "$T"/run/gvfs "$T"/run/doc; do fusermount3 -uz "$m" 2>/dev/null; done; rm -rf "$T"' EXIT
    ext="$T/data/gnome-shell/extensions"
    mkdir -p "$ext/unsafe-mode@test.local" "$ext/no-lock@test.local" "$T/config"
    cp -r "$here/$uuid" "$ext/"
    glib-compile-schemas "$ext/$uuid/schemas"
    # Turns on unsafe mode so the test can drive the shell through Eval, also
    # on the lock screen.
    cat > "$ext/unsafe-mode@test.local/metadata.json" <<'EOF'
{"uuid": "unsafe-mode@test.local", "name": "unsafe", "description": "test", "shell-version": ["46"],
 "session-modes": ["user", "unlock-dialog"]}
EOF
    # An extension that stops on the lock screen, like most do: GNOME then
    # disables and re-enables every extension enabled after it.
    echo '{"uuid": "no-lock@test.local", "name": "no-lock", "description": "test", "shell-version": ["46"]}' \
        > "$ext/no-lock@test.local/metadata.json"
    echo 'export default class { enable() {} disable() {} }' > "$ext/no-lock@test.local/extension.js"
    # GTK windows block up to 25 s on xdg-desktop-portal, which cannot work on
    # this bus; this stub fails at once instead.
    mkdir -p "$T/data/dbus-1/services"
    printf '[D-BUS Service]\nName=org.freedesktop.portal.Desktop\nExec=/bin/false\n' \
        > "$T/data/dbus-1/services/org.freedesktop.portal.Desktop.service"
    cat > "$ext/unsafe-mode@test.local/extension.js" <<'EOF'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
EOF
    # A private runtime dir: the shell keeps its crash guard file there, and
    # the real session's one must not be touched.
    export XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_RUNTIME_DIR="$T/run" T
    # Test windows skip the accessibility bus and gvfs: nothing runs them here.
    export NO_AT_BRIDGE=1 GIO_USE_VFS=local GIO_USE_VOLUME_MONITOR=unix
    mkdir -m 700 "$XDG_RUNTIME_DIR"
    # The second session is the next login: a new bus and shell, the same dconf.
    dbus-run-session -- "$0" inner session 2>"$T/session.log"
    first=$?
    dbus-run-session -- "$0" inner next-login 2>>"$T/session.log"
    second=$?
    if grep -E "JS ERROR|auto-tiling" "$T/shell.log"; then
        echo "FAIL errors in the shell log"
        first=1
    fi
    [ $first -eq 0 ] && [ $second -eq 0 ] && echo "OK" || echo "FAIL"
    [ $first -eq 0 ] && [ $second -eq 0 ]
    exit $?
fi
phase=$2

eval_js() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}
wait_for() {
    for _ in $(seq 40); do
        eval_js "$1" | grep -qF "(true, 'true')" && return 0
        sleep 0.25
    done
    return 1
}
failed=0
check() {
    if wait_for "$2"; then
        echo "ok   $1"
    else
        echo "FAIL $1"
        eval_js "at.dump()"
        failed=1
    fi
}
open_window() {
    APP_ID="${APP_ID:-}" WAYLAND_DISPLAY=at-e2e GDK_BACKEND=wayland DISPLAY= python3 "$here/tests/win.py" "$@" \
        >/dev/null 2>&1 &
    wait_for "!!at.win(\"$1\")" || echo "window $1 did not open"
}

# Ubuntu's session mode turns on Tiling Assistant, the dock and desktop icons:
# the first two take the same keys and change the work area, and the desktop
# icons read ~/Desktop and start gvfs.
[ "$phase" = session ] &&
gsettings set org.gnome.shell enabled-extensions "['$uuid', 'unsafe-mode@test.local', 'no-lock@test.local']"
gsettings set org.gnome.shell disabled-extensions \
    "['tiling-assistant@ubuntu.com', 'ubuntu-dock@ubuntu.com', 'ding@rastersoft.com']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"

# Starts the shell (again, for a new login) and adds the helpers for the
# checks. Monitor 1 is right of monitor 0.
start_shell() {
    gnome-shell --headless --wayland --wayland-display=at-e2e \
        --virtual-monitor 1920x1080 --virtual-monitor 1280x800 >> "$T/shell.log" 2>&1 &
    shell=$!
    for _ in $(seq 60); do
        eval_js 1 | grep -q true && break
        sleep 0.5
    done
    eval_js "$(tr '\n' ' ' <<'EOF'
const C = imports.gi.Clutter, G = imports.gi.GLib;
const seat = C.get_default_backend().get_default_seat();
const kb = seat.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);
const ptr = seat.create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
Main.overview.hide();
globalThis.at = {
    ext: () => Main.extensionManager.lookup("auto-tiling@nurik.local"),
    tiler: () => at.ext().stateObj._tiler,
    settings: () => at.ext().stateObj._settings,
    wmKeys: () => new imports.gi.Gio.Settings({schema_id: "org.gnome.desktop.wm.keybindings"}),
    gnomeKeys: key => at.wmKeys().get_strv(key),
    windows: () => global.display.list_all_windows().filter(w => w.get_window_type() === 0 && !w.is_skip_taskbar()),
    win: t => global.display.list_all_windows().find(w => w.title === t),
    r: t => at.win(t).get_frame_rect(),
    rect: w => { const f = w.get_frame_rect(); return [f.x, f.y, f.width, f.height].join(","); },
    rects: titles => titles.map(t => t + ":" + at.rect(at.win(t))).join(";"),
    layout: () => at.windows().map(w => w.title + ":" + at.rect(w)).sort().join(";"),
    m: t => at.win(t).get_monitor(),
    focus: () => global.display.focus_window?.title,
    activate: t => { at.win(t).activate(global.get_current_time()); return true; },
    inSlot: t => {
        const w = at.win(t), tree = w && at.tiler()._windows.get(w);
        const slot = tree && at.tiler()._layout(tree).get(w), f = w?.get_frame_rect();
        return !!slot && slot.x === f.x && slot.y === f.y && slot.width === f.width && slot.height === f.height;
    },
    floating: t => at.tiler()._windows.get(at.win(t)) === null,
    atSlot: t => {
        const w = at.win(t), tree = w && at.tiler()._windows.get(w);
        const slot = tree && at.tiler()._layout(tree).get(w), f = w?.get_frame_rect();
        return !!slot && slot.x === f.x && slot.y === f.y;
    },
    key: (...codes) => {
        const send = (c, s) => kb.notify_key(G.get_monotonic_time(), c, s);
        codes.forEach(c => send(c, C.KeyState.PRESSED));
        codes.reverse().forEach(c => send(c, C.KeyState.RELEASED));
        return true;
    },
    pointer: (x, y) => { ptr.notify_absolute_motion(G.get_monotonic_time(), x, y); return true; },
    dump: () => `auto-tiling state ${at.ext()?.state} ${at.ext()?.error ?? ""} | ` +
        global.display.list_all_windows().filter(w => w.get_window_type() === 0).map(w => {
        const f = w.get_frame_rect();
        return `${w.title} m${w.get_monitor()} ${f.x},${f.y} ${f.width}x${f.height} max=${w.get_maximized()}`;
    }).join(" | "),
};
true
EOF
)" >/dev/null
    wait_for 'at.ext()?.state === 1' || echo "auto-tiling did not start"
    # The shell starts in the overview, where windows are not drawn and so
    # never get their first frame. A hide() during the startup animation can
    # leave all windows hidden, so it waits for the startup to end.
    wait_for '!Main.layoutManager._startingUp' || echo "shell did not finish starting"
    wait_for '(Main.overview.hide(), !Main.overview.visible && !Main.overview.animationInProgress && global.window_group.visible)' ||
        echo "overview did not close"
}
start_shell

SUPER=125 SHIFT=42 CTRL=29 ALT=56 LEFT=105 RIGHT=106 UP=103 EQUAL=13 R=19 F=33

# The next login: the apps open in another order and take their old slots.
if [ "$phase" = next-login ]; then
    eval_js 'at.pointer(500, 500)' >/dev/null
    for n in R Q P; do open_window $n; done
    check "the layout comes back after the next login" "at.rects(['P', 'Q', 'R']) === '$(cat "$T/before")'"
    open_window U
    check "a new app still splits the focused window" 'at.inSlot("U") && at.inSlot("P")'
    kill $(jobs -p) 2>/dev/null
    wait 2>/dev/null
    exit $failed
fi

eval_js 'at.pointer(500, 500)' >/dev/null
for n in A B C; do open_window $n; done
check "three windows: A | (B / C)" \
    'at.inSlot("A") && at.inSlot("B") && at.inSlot("C") && at.r("A").x < at.r("B").x && at.r("B").x === at.r("C").x && at.r("B").y < at.r("C").y'

open_window D max
check "a window that opens maximized is tiled" \
    'at.inSlot("D") && !at.win("D").get_maximized() && at.inSlot("C")'

eval_js 'at.win("C").make_fullscreen(); true' >/dev/null
check "a fullscreen window keeps its slot" 'at.win("C").fullscreen && !at.floating("C")'
eval_js 'at.win("C").unmake_fullscreen(); true' >/dev/null
check "and goes back into it" '!at.win("C").fullscreen && at.inSlot("C")'

eval_js 'at.win("B").maximize(3); at.win("B").change_workspace_by_index(1, false); true' >/dev/null
check "a maximized window moved to another workspace stays tiled" \
    '!at.floating("B") && at.win("B").get_workspace().index() === 1'
eval_js 'at.win("B").change_workspace_by_index(0, false); at.win("B").unmaximize(3); true' >/dev/null
check "and comes back into the layout" 'at.inSlot("B") && at.inSlot("C")'

eval_js "at.activate(\"D\") && at.key($SUPER, $LEFT)" >/dev/null
check "Super+Left focuses the window on the left" 'at.focus() === "C"'

eval_js "at.activate(\"D\") && at.key($SUPER, $SHIFT, $RIGHT)" >/dev/null
check "Super+Shift+Right at the edge moves the window to the next monitor" \
    'at.m("D") === 1 && at.inSlot("D") && at.inSlot("C")'

eval_js 'at.pointer(2500, 400)' >/dev/null
open_window E
check "windows on the second monitor are tiled" \
    'at.m("E") === 1 && at.inSlot("E") && at.inSlot("D") && at.r("D").x < at.r("E").x'

eval_js "at.activate(\"E\") && at.key($SUPER, $LEFT)" >/dev/null
check "Super+Left goes on to the window on the left" 'at.focus() === "D"'

eval_js "at.key($SUPER, $CTRL, $RIGHT)" >/dev/null
check "Super+Ctrl+Right widens the window" 'at.r("D").width > at.r("E").width + 20'
eval_js "at.key($SUPER, $EQUAL)" >/dev/null
check "Super+= evens out the second monitor" \
    'Math.abs(at.r("D").width - at.r("E").width) <= 1 && at.inSlot("D")'

eval_js 'at.pointer(500, 500)' >/dev/null
open_window F fixed
check "a fixed-size window floats" 'at.floating("F") && at.m("F") === 0'
eval_js "at.activate(\"F\") && at.key($SUPER, $SHIFT, $RIGHT)" >/dev/null
check "Super+Shift+Right moves a floating window to the next monitor" 'at.m("F") === 1 && at.floating("F")'

eval_js 'at.win("A").make_above(); true' >/dev/null
check "an always-on-top window floats" 'at.floating("A") && at.inSlot("B") && at.inSlot("C")'
eval_js 'at.win("A").unmake_above(); true' >/dev/null
check "and tiles again without it" 'at.inSlot("A") && at.inSlot("B")'

eval_js 'at.settings().set_strv("focus-left", ["<Super><Alt>Left"]); true' >/dev/null
check "a new key is taken from GNOME at once" \
    '!at.gnomeKeys("switch-to-workspace-left").includes("<Super><Alt>Left")'
eval_js "at.activate(\"E\") && at.key($SUPER, $ALT, $LEFT)" >/dev/null
check "and works without re-enabling" 'at.focus() === "D"'
eval_js 'at.settings().reset("focus-left"); true' >/dev/null
check "the old key goes back to GNOME" 'at.gnomeKeys("switch-to-workspace-left").includes("<Super><Alt>Left")'

# A GNOME key the user sets while ours is taken from it stays as the user set
# it: fullscreen on Super+F is taken, the user moves fullscreen to F11.
restart_extension() {
    eval_js 'Main.extensionManager.disableExtension("auto-tiling@nurik.local"); true' >/dev/null
    wait_for 'at.ext().state !== 1' || echo "extension did not stop"
    eval "${1:-true}"
    eval_js 'Main.extensionManager.enableExtension("auto-tiling@nurik.local"); true' >/dev/null
    wait_for 'at.ext().state === 1' || echo "extension did not start"
}
restart_extension "eval_js 'at.wmKeys().set_strv(\"toggle-fullscreen\", [\"<Super>f\"]); true' >/dev/null"
check "Super+F is taken from GNOME's fullscreen" 'at.gnomeKeys("toggle-fullscreen").length === 0'
eval_js 'at.wmKeys().set_strv("toggle-fullscreen", ["F11"]); true' >/dev/null
eval_js 'Main.extensionManager.disableExtension("auto-tiling@nurik.local"); true' >/dev/null
wait_for 'at.ext().state !== 1' || echo "extension did not stop"
check "fullscreen set to F11 meanwhile stays F11 when disabled, other keys come back" \
    'at.gnomeKeys("toggle-fullscreen").join() === "F11" && at.gnomeKeys("move-to-monitor-left").includes("<Super><Shift>Left")'
eval_js 'Main.extensionManager.enableExtension("auto-tiling@nurik.local"); true' >/dev/null
wait_for 'at.ext().state === 1' || echo "extension did not start"
check "and when enabled again" 'at.gnomeKeys("toggle-fullscreen").join() === "F11"'

# A window that cannot be as narrow as its slot (Chrome: 500 px) gets room
# from its neighbour instead of overlapping it.
eval_js 'at.windows().forEach(w => w.delete(0)); true' >/dev/null
wait_for 'at.windows().length === 0' || echo "windows did not close"
eval_js 'at.pointer(500, 500)' >/dev/null
for n in G H I; do open_window $n; done
open_window J wide
check "a window wider than its slot gets room, nothing overlaps" \
    'at.r("J").width > at.r("I").width + 100 && at.inSlot("J") && at.inSlot("I") && at.r("I").x + at.r("I").width < at.r("J").x'

# A maximized window teaches no minimum: with no outer gap it starts where its
# slot does, and its maximized size must not stick to it.
eval_js 'at.windows().forEach(w => w.delete(0)); at.settings().set_uint("gap-outer", 0); true' >/dev/null
wait_for 'at.windows().length === 0' || echo "windows did not close"
open_window X
open_window Y
eval_js 'at.win("X").maximize(3); true' >/dev/null
wait_for 'at.win("X").get_maximized() === 3' || echo "X did not maximize"
sleep 0.5
eval_js 'at.win("X").unmaximize(3); true' >/dev/null
wait_for 'at.inSlot("X")' || echo "X did not go back"
eval_js 'at.activate("X")' >/dev/null
open_window Z
check "after a maximize the window still shares its slot" \
    'at.inSlot("X") && at.inSlot("Z") && Math.abs(at.r("X").width - at.r("Z").width) <= 1'
eval_js 'at.settings().reset("gap-outer"); true' >/dev/null

# A window that cannot fill its slot, on another workspace, does not hold back
# a swap here (it is not drawn there, so it would never answer).
eval_js 'at.windows().forEach(w => w.delete(0)); true' >/dev/null
wait_for 'at.windows().length === 0' || echo "windows did not close"
open_window L
open_window M small
eval_js 'global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); true' >/dev/null
wait_for 'global.workspace_manager.get_active_workspace_index() === 1' || echo "workspace did not switch"
open_window N
open_window O
wait_for 'at.inSlot("N") && at.inSlot("O") && at.r("N").x < at.r("O").x' || echo "N and O not tiled"
eval_js "at.activate('N') && at.key($SUPER, $SHIFT, $RIGHT)" >/dev/null
sleep 0.3
if eval_js 'at.inSlot("N") && at.inSlot("O") && at.r("N").x > at.r("O").x' | grep -qF "(true, 'true')"; then
    echo "ok   a swap is not held back by a window on another workspace"
else
    echo "FAIL a swap is not held back by a window on another workspace"
    eval_js "at.dump()"
    failed=1
fi

# An app that brings its window up right after the user left its workspace
# (Claude, Telegram). activate() called here switches like it: inside mutter.
at_ws() { echo "global.workspace_manager.get_active_workspace_index() === $1"; }
pull_back='at.ws(0).activate(global.get_current_time()); at.app("O"); true'
eval_js 'at.ws = i => global.workspace_manager.get_workspace_by_index(i); true' >/dev/null
eval_js 'at.app = t => at.win(t).activate(global.display.get_current_time_roundtrip()); true' >/dev/null
eval_js "$pull_back" >/dev/null
sleep 0.3
check "a window does not take the user back to the workspace just left" "$(at_ws 0) && at.focus() !== 'O'"
sleep 1.2
eval_js 'at.app("O"); true' >/dev/null
sleep 0.3
check "later the window brings its workspace up as in GNOME" "$(at_ws 1) && at.focus() === 'O'"
eval_js 'at.ws(0).activate(global.get_current_time()); at.ws(1).activate(global.get_current_time()); true' >/dev/null
sleep 0.3
check "the user going back at once stays back" "$(at_ws 1)"
sleep 1.2
eval_js 'at.settings().set_boolean("keep-workspace", false); true' >/dev/null
eval_js "$pull_back" >/dev/null
sleep 0.3
check "with the setting off the window takes the user back" "$(at_ws 1) && at.focus() === 'O'"
eval_js 'at.settings().reset("keep-workspace"); true' >/dev/null

eval_js 'at.windows().forEach(w => w.delete(0)); global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); true' >/dev/null
wait_for 'at.windows().length === 0 && global.workspace_manager.get_active_workspace_index() === 0' ||
    echo "did not go back to workspace 1"

# Windows sized in whole cells (terminals) keep their size when swapped, draw
# nothing, and mutter waited for a frame to move them: they stayed on top of
# each other.
open_window K1 cells
open_window K2 cells
wait_for 'at.atSlot("K1") && at.atSlot("K2") && at.r("K1").x < at.r("K2").x' || echo "K1 and K2 not tiled"
eval_js "at.activate('K1') && at.key($SUPER, $SHIFT, $RIGHT)" >/dev/null
check "windows sized in whole cells swap places" 'at.atSlot("K1") && at.atSlot("K2") && at.r("K1").x > at.r("K2").x'
eval_js 'at.windows().forEach(w => w.delete(0)); true' >/dev/null
wait_for 'at.windows().length === 0' || echo "windows did not close"

# Screen lock: GNOME disables and re-enables every extension enabled after one
# that stops on the lock screen. Re-enabling auto-tiling here puts it last.
eval_js 'Main.extensionManager.disableExtension("auto-tiling@nurik.local"); true' >/dev/null
wait_for 'at.ext().state !== 1' || echo "extension did not stop"
eval_js 'Main.extensionManager.enableExtension("auto-tiling@nurik.local"); true' >/dev/null
wait_for 'at.ext().state === 1' || echo "extension did not start"
eval_js 'at.windows().forEach(w => w.delete(0)); true' >/dev/null
wait_for 'at.windows().length === 0' || echo "windows did not close"
eval_js 'at.pointer(500, 500)' >/dev/null
# The layout goes on workspace 2; workspace 1 is emptied before the lock, so
# GNOME removes it and workspace 2 becomes number 1.
open_window W
eval_js 'global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time()); true' >/dev/null
wait_for 'global.workspace_manager.get_active_workspace_index() === 1' || echo "workspace did not switch"
for n in P Q R; do open_window $n; done
eval_js "at.activate('R') && at.key($SUPER, $R) && at.key($SUPER, $CTRL, $LEFT)" >/dev/null
check "a layout to remember: P | (Q R)" \
    'at.inSlot("R") && at.r("Q").y === at.r("R").y && at.r("Q").width !== at.r("R").width'
APP_ID=test-same open_window T1
APP_ID=test-same open_window T2
eval_js "(() => { const left = at.r('T1').x < at.r('T2').x; at.activate('T2'); return at.key($SUPER, $SHIFT, left ? $LEFT : $UP); })()" >/dev/null
check "two windows of one app swapped" 'at.inSlot("T2") && (at.r("T2").x < at.r("T1").x || at.r("T2").y < at.r("T1").y)'
open_window S
eval_js "at.activate('S') && at.key($SUPER, $F)" >/dev/null
check "S floats" 'at.floating("S")'
eval_js 'at.win("W").delete(0); true' >/dev/null
check "the empty workspace is gone, the layout is on workspace 1 now" \
    'global.workspace_manager.get_active_workspace_index() === 0 && at.windows().length === 6'
eval_js 'globalThis.before = at.layout(); globalThis.oldTiler = at.tiler(); true' >/dev/null
sleep 1.5
eval_js 'Main.screenShield.lock(false); true' >/dev/null
wait_for 'Main.sessionMode.currentMode === "unlock-dialog"' || echo "the screen did not lock"
eval_js 'Main.screenShield.deactivate(false); true' >/dev/null
wait_for 'Main.sessionMode.currentMode !== "unlock-dialog"' || echo "the screen did not unlock"
check "the lock re-enabled auto-tiling" 'at.ext().state === 1 && at.tiler() !== oldTiler'
check "and nothing moved, S still floats" 'at.floating("S") && at.layout() === before'

# Logout: every window closes (the next login is the second session). Closed
# windows are not saved, so T1, T2 keep empty slots that give their space away.
eval_js 'at.win("T1").delete(0); at.win("T2").delete(0); at.win("S").delete(0); true' >/dev/null
wait_for 'at.windows().length === 3 && ["P", "Q", "R"].every(at.inSlot)' || echo "windows did not close"
eval_js 'at.rects(["P", "Q", "R"])' | sed -E "s/^\(true, '\"(.*)\"'\)$/\1/" > "$T/before"
eval_js 'at.windows().forEach(w => w.delete(0)); true' >/dev/null
wait_for 'at.windows().length === 0' || echo "windows did not close"

kill $(jobs -p) 2>/dev/null
wait 2>/dev/null
exit $failed
