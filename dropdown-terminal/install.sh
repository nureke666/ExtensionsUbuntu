#!/usr/bin/env bash
# Installs the Dropdown Terminal GNOME Shell extension for the current user and
# adds it to the enabled list. It loads after the next login (Wayland).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="dropdown-terminal@nurik.local"
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$here/$uuid/." "$dest/"
glib-compile-schemas "$dest/schemas"

python3 -I - "$uuid" <<'EOF'
import ast
import subprocess
import sys

uuid = sys.argv[1]

def get(key):
    out = subprocess.run(['gsettings', 'get', 'org.gnome.shell', key],
                         check=True, capture_output=True, text=True).stdout
    return ast.literal_eval(out.replace('@as ', ''))

def put(key, value):
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', key, str(value)], check=True)

enabled = get('enabled-extensions')
if uuid not in enabled:
    put('enabled-extensions', enabled + [uuid])
# An earlier `gnome-extensions disable` keeps it listed as disabled, which wins.
disabled = get('disabled-extensions')
if uuid in disabled:
    put('disabled-extensions', [x for x in disabled if x != uuid])
EOF
gsettings set org.gnome.shell disable-user-extensions false

# With Auto Tiling installed, the terminal is one of its floating apps, so it
# never lands in the layout, not even for a frame before it goes on top.
tiling="$HOME/.local/share/gnome-shell/extensions/auto-tiling@nurik.local/schemas"
if [ -d "$tiling" ]; then
    app_id="$(gsettings --schemadir "$dest/schemas" get org.gnome.shell.extensions.dropdown-terminal app-id)"
    python3 -I - "$tiling" "${app_id//\'/}" <<'EOF'
import ast
import subprocess
import sys

schemas, app_id = sys.argv[1:]
cmd = ['gsettings', '--schemadir', schemas]
key = ['org.gnome.shell.extensions.auto-tiling', 'floating-apps']
out = subprocess.run(cmd + ['get'] + key, check=True, capture_output=True, text=True).stdout
apps = ast.literal_eval(out.replace('@as ', ''))
if app_id not in apps:
    subprocess.run(cmd + ['set'] + key + [str(apps + [app_id])], check=True)
EOF
fi

echo "Готово: файлы в $dest, расширение включено."
echo "Выйди из системы и зайди снова, чтобы GNOME его загрузил."
