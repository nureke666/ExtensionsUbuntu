// Auto Tiling: i3-style automatic tiling for GNOME Shell 46.
//
// The extension also runs on the lock screen (session-modes in metadata.json)
// so that locking does not disable it and throw the window layout away. Its
// key handlers only run in normal mode, and nothing else reacts while locked.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FocusBorder} from './border.js';
import {Keybindings} from './keybindings.js';
import {Tiler} from './tiler.js';

export default class AutoTilingExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._tiler = new Tiler(this._settings);
        this._border = new FocusBorder(this._settings);
        this._keybindings = new Keybindings(this._settings, this._tiler);
    }

    disable() {
        // GNOME may call disable twice in a row when several extensions change at once.
        if (!this._tiler)
            return;
        this._keybindings.destroy();
        this._keybindings = null;
        this._border.destroy();
        this._border = null;
        this._tiler.destroy();
        this._tiler = null;
        this._settings = null;
    }
}
