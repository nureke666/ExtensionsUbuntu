#!/usr/bin/env bash
# End-to-end check in a headless GNOME Shell with two monitors (nothing shows
# on screen, the real session is not touched): opens test windows, presses the
# keys with a virtual keyboard and checks where the windows end up.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="auto-tiling@nurik.local"

if [ "${1:-}" != inner ]; then
    T="$(mktemp -d)"
    trap 'rm -rf "$T"' EXIT
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
    export XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" T
    dbus-run-session -- "$0" inner 2>"$T/session.log"
    exit $?
fi

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
    WAYLAND_DISPLAY=at-e2e GDK_BACKEND=wayland DISPLAY= python3 "$here/tests/win.py" "$@" \
        >/dev/null 2>&1 &
    wait_for "!!at.win(\"$1\")" || echo "window $1 did not open"
}

# Ubuntu's session mode turns on Tiling Assistant and the dock; they would
# take the same keys and change the work area.
gsettings set org.gnome.shell enabled-extensions "['$uuid', 'unsafe-mode@test.local']"
gsettings set org.gnome.shell disabled-extensions "['tiling-assistant@ubuntu.com', 'ubuntu-dock@ubuntu.com']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"

gnome-shell --headless --wayland --wayland-display=at-e2e \
    --virtual-monitor 1920x1080 --virtual-monitor 1280x800 > "$T/shell.log" 2>&1 &
shell=$!
for _ in $(seq 60); do
    eval_js 1 | grep -q true && break
    sleep 0.5
done

# Helpers for the checks. Monitor 1 is right of monitor 0.
eval_js "$(tr '\n' ' ' <<'EOF'
const C = imports.gi.Clutter, G = imports.gi.GLib;
const seat = C.get_default_backend().get_default_seat();
const kb = seat.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);
const ptr = seat.create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
Main.overview.hide();
globalThis.at = {
    tiler: () => Main.extensionManager.lookup("auto-tiling@nurik.local").stateObj._tiler,
    win: t => global.display.list_all_windows().find(w => w.title === t),
    r: t => at.win(t).get_frame_rect(),
    m: t => at.win(t).get_monitor(),
    focus: () => global.display.focus_window?.title,
    activate: t => { at.win(t).activate(global.get_current_time()); return true; },
    inSlot: t => {
        const w = at.win(t), tree = w && at.tiler()._windows.get(w);
        const slot = tree && at.tiler()._layout(tree).get(w), f = w?.get_frame_rect();
        return !!slot && slot.x === f.x && slot.y === f.y && slot.width === f.width && slot.height === f.height;
    },
    floating: t => at.tiler()._windows.get(at.win(t)) === null,
    key: (...codes) => {
        const send = (c, s) => kb.notify_key(G.get_monotonic_time(), c, s);
        codes.forEach(c => send(c, C.KeyState.PRESSED));
        codes.reverse().forEach(c => send(c, C.KeyState.RELEASED));
        return true;
    },
    pointer: (x, y) => { ptr.notify_absolute_motion(G.get_monotonic_time(), x, y); return true; },
    dump: () => global.display.list_all_windows().filter(w => w.get_window_type() === 0).map(w => {
        const f = w.get_frame_rect();
        return `${w.title} m${w.get_monitor()} ${f.x},${f.y} ${f.width}x${f.height} max=${w.get_maximized()}`;
    }).join(" | "),
};
true
EOF
)" >/dev/null

SUPER=125 SHIFT=42 CTRL=29 LEFT=105 RIGHT=106 EQUAL=13

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

kill $(jobs -p) 2>/dev/null
wait 2>/dev/null
if grep -E "JS ERROR|auto-tiling" "$T/shell.log"; then
    echo "FAIL errors in the shell log"
    failed=1
fi
[ $failed -eq 0 ] && echo "OK" || echo "FAIL"
exit $failed
