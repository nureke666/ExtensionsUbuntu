#!/usr/bin/env bash
# Installs the Auto Tiling GNOME Shell extension for the current user, turns
# off Ubuntu's Tiling Assistant (both would fight over the same keys) and adds
# Auto Tiling to the enabled list. It loads after the next login (Wayland).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="auto-tiling@nurik.local"
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$here/$uuid/." "$dest/"
glib-compile-schemas "$dest/schemas"

# Tiling Assistant puts its overridden GNOME settings back when disabled.
if gnome-extensions list --enabled | grep -qx 'tiling-assistant@ubuntu.com'; then
    gnome-extensions disable tiling-assistant@ubuntu.com
fi

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

echo "Готово: файлы в $dest, расширение включено, Tiling Assistant выключен."
echo "Выйди из системы и зайди снова, чтобы GNOME загрузил Auto Tiling."
