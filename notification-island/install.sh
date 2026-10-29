#!/usr/bin/env bash
# Installs the Notification Island GNOME Shell extension for the current user
# and adds it to the enabled list. It loads after the next login (Wayland).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="notification-island@nurik.local"
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"

mkdir -p "$dest"
cp "$here/$uuid/metadata.json" "$here/$uuid/extension.js" "$here/$uuid/stylesheet.css" "$dest/"

enabled="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$enabled" != *"'$uuid'"* ]]; then
    if [[ "$enabled" == "@as []" || "$enabled" == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$uuid']"
    else
        gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$uuid']"
    fi
fi
gsettings set org.gnome.shell disable-user-extensions false

echo "Готово: файлы в $dest, расширение включено."
echo "Выйди из системы и зайди снова, чтобы GNOME его загрузил."
