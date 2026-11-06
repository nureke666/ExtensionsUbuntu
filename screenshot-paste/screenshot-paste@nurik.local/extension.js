// Alt+M: takes a screenshot of the whole screen, puts it in the clipboard,
// presses Ctrl+V in the focused field and then Enter.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

// evdev key codes (linux/input-event-codes.h). Codes, not keyvals: Ctrl+V
// then works the same with the Russian layout active.
const KEY_ENTER = 28;
const KEY_LEFTCTRL = 29;
const KEY_V = 47;

// Physically held modifiers would mix into our keys (Alt+Ctrl+V), so we wait
// until the user lets go of the shortcut. NumLock/CapsLock do not count.
const HELD_MODIFIERS = Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.MOD4_MASK |
    Clutter.ModifierType.SUPER_MASK;
const POLL_MS = 20;
const RELEASE_TIMEOUT_MS = 3000;

export default class ScreenshotPasteExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timeouts = new Set();
        this._busy = false;
        this._keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        Main.wm.addKeybinding('shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL,
            () => this._run().catch(e => logError(e, 'Screenshot Paste')));
    }

    disable() {
        Main.wm.removeKeybinding('shortcut');
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts = null;
        this._keyboard = null;
        this._settings = null;
    }

    async _run() {
        if (this._busy)
            return;
        this._busy = true;
        // Disabling mid-run swaps the device, which tells us to stop.
        const keyboard = this._keyboard;
        try {
            const stream = Gio.MemoryOutputStream.new_resizable();
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
            if (this._keyboard !== keyboard)
                return;
            St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD,
                'image/png', stream.steal_as_bytes());

            if (!await this._modifiersReleased()) {
                console.warn('Screenshot Paste: shortcut held too long, screenshot left in the clipboard');
                return;
            }
            if (this._keyboard !== keyboard)
                return;
            this._tap(KEY_LEFTCTRL, KEY_V);

            await this._sleep(this._settings.get_uint('enter-delay'));
            if (this._keyboard !== keyboard)
                return;
            this._tap(KEY_ENTER);
        } finally {
            this._busy = false;
        }
    }

    async _modifiersReleased() {
        for (let waited = 0; waited < RELEASE_TIMEOUT_MS; waited += POLL_MS) {
            const [, , mods] = global.get_pointer();
            if (!(mods & HELD_MODIFIERS))
                return true;
            await this._sleep(POLL_MS);
        }
        return false;
    }

    // Presses the keys in order, then releases them in reverse.
    _tap(...keys) {
        for (const key of keys)
            this._keyboard.notify_key(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._keyboard.notify_key(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timeouts.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        });
    }
}
