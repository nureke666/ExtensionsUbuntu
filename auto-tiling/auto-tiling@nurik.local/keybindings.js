// Binds the tiling actions to keys and, while enabled, takes those keys away
// from GNOME shortcuts that use them. The originals are kept in the
// 'overridden-settings' key and restored on disable or when our keys change.

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

// An entry of 'overridden-settings': {original, written}; `written` is null
// for entries saved by versions that kept only the original.
function unpackSaved(entry) {
    if (entry.get_type_string() !== '(vv)')
        return {original: entry, written: null};
    return {
        original: entry.get_child_value(0).get_variant(),
        written: entry.get_child_value(1).get_variant(),
    };
}

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
        // Mutter rebinds our keys by itself; the GNOME keys they clash with
        // are given back and taken again here.
        settings.connectObject('changed', (_settings, key) => {
            if (key in ACTIONS) {
                this._restoreOverrides();
                this._overrideConflicts();
            }
        }, this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        for (const name of Object.keys(ACTIONS))
            Main.wm.removeKeybinding(name);
        this._restoreOverrides();
    }

    // Each changed key is saved as (original, written): its value before we
    // changed it (DEFAULT_MARKER_TYPE when it was at its default) and the value
    // we wrote. Restoring puts the original back only while the key still holds
    // what we wrote, so a key the user set meanwhile (fullscreen moved to F11)
    // stays as the user set it.
    _overrideConflicts() {
        const saved = this._settings.get_value('overridden-settings').deepUnpack();
        const write = (schemaId, key, settings, value) => {
            const id = `${schemaId}/${key}`;
            // An original saved by an earlier run that never restored it (a
            // crash) is the true one, so it is kept.
            const original = saved[id] ? unpackSaved(saved[id]).original
                : settings.get_user_value(key) ?? GLib.Variant.new_maybe(new GLib.VariantType('b'), null);
            saved[id] = new GLib.Variant('(vv)', [original, value]);
            settings.set_value(key, value);
        };

        const ours = this._ourAccelerators();
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
                if (kept.length !== accelerators.length)
                    write(schemaId, key, settings, new GLib.Variant('as', kept));
            }
        }

        for (const [schemaId, key, type, value] of FORCED_SETTINGS) {
            const settings = lookupSettings(schemaId);
            if (settings)
                write(schemaId, key, settings, new GLib.Variant(type, value));
        }

        this._settings.set_value('overridden-settings', new GLib.Variant('a{sv}', saved));
    }

    _restoreOverrides() {
        const saved = this._settings.get_value('overridden-settings').deepUnpack();
        for (const [id, entry] of Object.entries(saved)) {
            const slash = id.lastIndexOf('/');
            const schemaId = id.slice(0, slash);
            const settings = lookupSettings(schemaId);
            const key = id.slice(slash + 1);
            if (!settings)
                continue;
            const {original, written} = unpackSaved(entry);
            const wrote = written ?? this._writtenByOldVersion(schemaId, key, settings, original);
            if (wrote && !settings.get_value(key).equal(wrote))
                continue;
            if (original.get_type_string() === DEFAULT_MARKER_TYPE)
                settings.reset(key);
            else
                settings.set_value(key, original);
        }
        this._settings.set_value('overridden-settings', new GLib.Variant('a{sv}', {}));
    }

    _ourAccelerators() {
        const ours = new Set();
        for (const name of Object.keys(ACTIONS)) {
            for (const accelerator of this._settings.get_strv(name))
                ours.add(normalizeAccelerator(accelerator));
        }
        return ours;
    }

    // Versions before (original, written) saved only the original; what they
    // wrote was the original without our keys, or the forced value.
    _writtenByOldVersion(schemaId, key, settings, original) {
        const forced = FORCED_SETTINGS.find(([s, k]) => s === schemaId && k === key);
        if (forced)
            return new GLib.Variant(forced[2], forced[3]);
        const base = original.get_type_string() === DEFAULT_MARKER_TYPE
            ? settings.get_default_value(key) : original;
        if (base.get_type_string() !== 'as')
            return null;
        const ours = this._ourAccelerators();
        return new GLib.Variant('as', base.deepUnpack().filter(a => !ours.has(normalizeAccelerator(a))));
    }
}
