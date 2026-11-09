// tmux's copy-command (tmux.conf): hands the text on stdin to the running
// terminal (terminal.js), which puts it on the clipboard. wl-copy would map a
// window of its own for that, and Auto Tiling would tile it.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import System from 'system';

// tmux gives a socket, not a pipe, as stdin: /dev/stdin cannot be opened.
const input = new GioUnix.InputStream({fd: 0, close_fd: false});
const chunks = [];
for (let chunk; (chunk = input.read_bytes(65536, null)).get_size() > 0;)
    chunks.push(chunk.toArray());
const bytes = new Uint8Array(chunks.reduce((size, c) => size + c.length, 0));
chunks.reduce((at, c) => (bytes.set(c, at), at + c.length), 0);

try {
    Gio.DBus.session.call_sync('org.nurik.DropdownTerminal.Clipboard', '/org/nurik/DropdownTerminal/Clipboard',
        'org.nurik.DropdownTerminal.Clipboard', 'Copy', new GLib.Variant('(s)', [new TextDecoder().decode(bytes)]),
        null, Gio.DBusCallFlags.NO_AUTO_START, 5000, null);
} catch (e) {
    printerr(`Dropdown Terminal: not copied: ${e.message}`);
    System.exit(1);
}
