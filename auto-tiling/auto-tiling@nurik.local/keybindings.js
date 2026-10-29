// Binds the tiling actions to keys and, while enabled, takes those keys away
// from GNOME shortcuts that use them. The originals are kept in the
// 'overridden-settings' key and restored on disable.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {normalizeAccelerator} from './accel.js';
import {Direction} from './tree.js';

const ACTIONS = {
    'focus-left': tiler => tiler.focus(Direction.LEFT),
    'focus-right': tiler => tiler.focus(Direction.RIGHT),
    'focus-up': tiler => tiler.focus(Direction.UP),
    'focus-down': tiler => tiler.focus(Direction.DOWN),
    'swap-left': tiler => tiler.swap(Direction.LEFT),
    'swap-right': tiler => tiler.swap(Direction.RIGHT),
    'swap-up': tiler => tiler.swap(Direction.UP),
    'swap-down': tiler => tiler.swap(Direction.DOWN),
    'resize-left': tiler => tiler.resize(Direction.LEFT),
    'resize-right': tiler => tiler.resize(Direction.RIGHT),
    'resize-up': tiler => tiler.resize(Direction.UP),
    'resize-down': tiler => tiler.resize(Direction.DOWN),
    'toggle-split': tiler => tiler.toggleSplit(),
    'toggle-floating': tiler => tiler.toggleFloating(),
    'equalize': tiler => tiler.equalize(),
    'toggle-tiling': tiler => tiler.toggleTiling(),
};

// GNOME shortcut lists that may hold the same keys as ours.
const SHORTCUT_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.shell.keybindings',
];

// Other GNOME settings that fight the tiler: [schema, key, type, value while enabled].
// Edge tiling would half-maximize a tiled window dropped at a screen edge.
const FORCED_SETTINGS = [
    ['org.gnome.mutter', 'edge-tiling', 'b', false],
];

// Saved in place of a value that was at its default, so restoring resets the
// key instead of writing the default into the user's dconf. No overridden key
// has type 'mb', so it cannot be mistaken for a real value.
const DEFAULT_MARKER_TYPE = 'mb';

function lookupSettings(schemaId) {
    const schema = Gio.SettingsSchemaSource.get_default().lookup(schemaId, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

export class Keybindings {
    constructor(settings, tiler) {
        this._settings = settings;
        this._overrideConflicts();
        for (const [name, action] of Object.entries(ACTIONS)) {
            Main.wm.addKeybinding(name, settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => action(tiler));
        }
    }

    destroy() {
        for (const name of Object.keys(ACTIONS))
            Main.wm.removeKeybinding(name);
        this._restoreOverrides();
    }

    _overrideConflicts() {
        // Values saved by an earlier run that never restored them (a crash)
        // are the true originals, so they are kept rather than overwritten.
        const saved = this._settings.get_value('overridden-settings').deepUnpack();
        const save = (schemaId, key, settings) => {
            const id = `${schemaId}/${key}`;
            if (!(id in saved)) {
                saved[id] = settings.get_user_value(key) ??
                    GLib.Variant.new_maybe(new GLib.VariantType('b'), null);
            }
        };

        const ours = new Set();
        for (const name of Object.keys(ACTIONS)) {
            for (const accelerator of this._settings.get_strv(name))
                ours.add(normalizeAccelerator(accelerator));
        }

        for (const schemaId of SHORTCUT_SCHEMAS) {
            const settings = lookupSettings(schemaId);
            if (!settings)
                continue;
            for (const key of settings.settings_schema.list_keys()) {
                const type = settings.settings_schema.get_key(key).get_value_type().dup_string();
                if (type !== 'as')
                    continue;
                const accelerators = settings.get_strv(key);
                const kept = accelerators.filter(a => !ours.has(normalizeAccelerator(a)));
                if (kept.length === accelerators.length)
                    continue;
                save(schemaId, key, settings);
                settings.set_strv(key, kept);
            }
        }

        for (const [schemaId, key, type, value] of FORCED_SETTINGS) {
            const settings = lookupSettings(schemaId);
            if (!settings)
                continue;
            save(schemaId, key, settings);
            settings.set_value(key, new GLib.Variant(type, value));
        }

        this._settings.set_value('overridden-settings', new GLib.Variant('a{sv}', saved));
    }

    _restoreOverrides() {
        const saved = this._settings.get_value('overridden-settings').deepUnpack();
        for (const [id, value] of Object.entries(saved)) {
            const slash = id.lastIndexOf('/');
            const settings = lookupSettings(id.slice(0, slash));
            const key = id.slice(slash + 1);
            if (!settings)
                continue;
            if (value.get_type_string() === DEFAULT_MARKER_TYPE)
                settings.reset(key);
            else
                settings.set_value(key, value);
        }
        this._settings.set_value('overridden-settings', new GLib.Variant('a{sv}', {}));
    }
}
