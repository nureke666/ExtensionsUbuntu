#!/usr/bin/env bash
# End-to-end check in a headless GNOME Shell (nothing shows on screen, the real
# session is not touched): opens tests/target.py, presses Alt+M with a virtual
# keyboard and checks that the window got an image paste and then Enter.
# The Russian layout is active, Alt is released 300 ms after M.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="screenshot-paste@nurik.local"
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

export XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" HERE="$here" T
dbus-run-session -- bash -c '
eval_js() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}
gsettings set org.gnome.shell enabled-extensions "[\"screenshot-paste@nurik.local\", \"unsafe-mode@test.local\"]"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
gsettings set org.gnome.desktop.input-sources sources "[(\"xkb\", \"ru\"), (\"xkb\", \"us\")]"

gnome-shell --headless --wayland --virtual-monitor 1280x800 --wayland-display=sp-test \
    > "$T/shell.log" 2>&1 &
shell=$!
for _ in $(seq 60); do
    eval_js 1 | grep -q true && break
    sleep 0.5
done

WAYLAND_DISPLAY=sp-test GDK_BACKEND=wayland DISPLAY= python3 "$HERE/tests/target.py" \
    > "$T/target.log" 2>&1 &
for _ in $(seq 20); do grep -q ready "$T/target.log" && break; sleep 0.5; done
eval_js "Main.overview.hide(); const w = global.display.list_all_windows().find(w => w.title === \"paste target\"); Main.activateWindow(w); w.title"
sleep 1

eval_js "
const C = imports.gi.Clutter, G = imports.gi.GLib;
const kb = C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE);
const key = (code, state) => kb.notify_key(G.get_monotonic_time(), code, state);
key(56, C.KeyState.PRESSED); key(50, C.KeyState.PRESSED); key(50, C.KeyState.RELEASED);
G.timeout_add(0, 300, () => { key(56, C.KeyState.RELEASED); return false; });
globalThis._spTestKb = kb; true"
sleep 3

eval_js "Main.extensionManager.disableExtension(\"screenshot-paste@nurik.local\")" >/dev/null
sleep 0.5

echo "--- target window:"; cat "$T/target.log"
echo "--- shell errors:"; grep -iE "JS ERROR|Screenshot Paste|keybinding .paste-screenshot" "$T/shell.log"
kill %2 $shell 2>/dev/null; wait 2>/dev/null

grep -qE "^paste [0-9]+x[0-9]+$" "$T/target.log" &&
    sed -n "/^paste /,\$p" "$T/target.log" | grep -qx enter &&
    ! grep -qE "JS ERROR|keybinding .paste-screenshot" "$T/shell.log"
' 2>"$T/session.log"
status=$?
[ $status -eq 0 ] && echo "OK: image pasted, then Enter" || echo "FAIL"
exit $status
