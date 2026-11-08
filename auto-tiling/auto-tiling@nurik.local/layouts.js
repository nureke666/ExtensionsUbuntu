// Keeps the layouts across logins in the 'saved-layouts' setting. A saved
// window comes back as a placeholder slot that takes no space; the next
// window of the same app opened on that workspace and monitor takes it.
//
// GNOME also disables and re-enables extensions inside a session (locking the
// screen does it). Then the layouts are kept in memory by workspace object
// (GNOME renumbers workspaces when it removes an empty one) and every window
// goes back to its own slot by its stable sequence.

import GLib from 'gi://GLib';

import {Tree} from './tree.js';

// Snapshots are written this long after the change, coalescing bursts.
const SAVE_DELAY_MS = 1000;
// A slot whose app was not opened for this many logins is forgotten.
const MAX_AGE = 1;

// The module lives as long as the shell process, across disable and enable.
let loadedThisSession = false;
// Set on disable for the next enable: {trees: Map(workspace key -> Map(monitor
// index -> tree data)), saved, last}.
let sessionStash = null;

export class Placeholder {
    // `seq` is the stable sequence of the window that had the slot in this
    // session, or null for a slot from an earlier login.
    constructor(app, age, seq = null) {
        this.app = app;
        this.age = age;
        this.seq = seq;
    }
}

export function appId(window) {
    return window.get_gtk_application_id() || window.get_wm_class() ||
        window.get_wm_class_instance() || '';
}

function leafData(id) {
    return id instanceof Placeholder
        ? {app: id.app, age: id.age, seq: id.seq}
        : {app: appId(id), age: 0, seq: id.get_stable_sequence()};
}

export class LayoutStore {
    // `liveSeqs`: stable sequences of the windows that exist now;
    // `monitors`: names of the connected monitors (see Tiler._monitorName).
    constructor(settings, liveSeqs, monitors) {
        this._settings = settings;
        // Saved layouts not restored yet: key -> tree data with {app, age, seq} leaves.
        this._saved = new Map();
        // What was saved last, for layouts of monitors that are gone.
        this._last = {};
        this._pending = null;
        this._saveId = 0;
        // Layouts from before a disable in this session, by workspace object.
        this._stash = new Map();
        if (sessionStash)
            this._unstash(liveSeqs);
        else if (this.enabled)
            this._load(liveSeqs, monitors);
    }

    get enabled() {
        return this._settings.get_boolean('remember-layout');
    }

    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        this._write();
    }

    // Gives a new, empty tree its layout from before a disable in this
    // session, else the saved layout of `key`.
    restore(tree, key) {
        let data = this._stash.get(tree.workspace)?.get(tree.monitor);
        if (data) {
            this._stash.get(tree.workspace).delete(tree.monitor);
        } else {
            data = this._saved.get(key);
            this._saved.delete(key);
        }
        if (data)
            tree.root = Tree.fromData(data, leaf => new Placeholder(leaf.app, leaf.age, leaf.seq ?? null)).root;
    }

    // Keeps the layouts in memory for the next enable in this session.
    // `trees`: Map(workspace key -> Map(monitor index -> Tree)).
    stash(trees) {
        const stashed = new Map();
        for (const [workspace, monitors] of trees) {
            const layouts = new Map();
            for (const [monitor, tree] of monitors) {
                const data = tree.toData(leafData);
                if (data)
                    layouts.set(monitor, data);
            }
            stashed.set(workspace, layouts);
        }
        sessionStash = {trees: stashed, saved: this._saved, last: this._last};
    }

    // Takes the snapshot now and writes it a moment later. Called when a
    // window is placed or the user changes a layout, never when a window
    // closes: at logout every window closes, and the layout before that stays.
    // `keep(key)` tells which saved layouts stay when their tree is empty now
    // (a monitor that was unplugged and whose windows moved away).
    save(trees, keep) {
        if (!this.enabled)
            return;
        const data = {};
        for (const [key, tree] of trees) {
            const node = tree.toData(leafData);
            if (node)
                data[key] = node;
        }
        for (const [key, node] of this._saved)
            data[key] ??= node;
        for (const [key, node] of Object.entries(this._last)) {
            if (!(key in data) && keep(key))
                data[key] = node;
        }
        this._last = data;
        this._pending = JSON.stringify(data);
        this._saveId ||= GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Forgets everything, for when remembering is turned off.
    clear() {
        this._saved.clear();
        this._last = {};
        this._pending = null;
        this._settings.reset('saved-layouts');
    }

    _unstash(liveSeqs) {
        loadedThisSession = true;
        const remember = this.enabled;
        // A window closed while disabled does not come back, nor do slots of
        // an earlier login when remembering was turned off meanwhile.
        const keepLeaf = leaf => (leaf.seq === null ? remember : liveSeqs.has(leaf.seq)) ? leaf : null;
        for (const [workspace, layouts] of sessionStash.trees) {
            const kept = new Map();
            for (const [monitor, data] of layouts) {
                const tree = Tree.fromData(data, keepLeaf);
                if (!tree.isEmpty)
                    kept.set(monitor, tree.toData(leaf => leaf));
            }
            this._stash.set(workspace, kept);
        }
        if (remember) {
            this._saved = sessionStash.saved;
            this._last = sessionStash.last;
        }
        sessionStash = null;
    }

    _load(liveSeqs, monitors) {
        const newLogin = !loadedThisSession;
        loadedThisSession = true;
        let data;
        try {
            data = JSON.parse(this._settings.get_string('saved-layouts') || '{}');
        } catch (e) {
            logError(e, 'Auto Tiling: saved layouts ignored');
            return;
        }
        // `ages`: whether this login counts against the layout's slots; not
        // for a monitor that is not connected, its apps could not be opened.
        const keepLeaf = ages => leaf => {
            if (typeof leaf?.app !== 'string' || !leaf.app)
                return null;
            const age = Number(leaf.age) || 0;
            const seq = Number.isInteger(leaf.seq) ? leaf.seq : null;
            // A new login: windows are new, only the app can match. One more
            // login without the app; a too old slot is dropped.
            if (newLogin) {
                const newAge = ages ? age + 1 : age;
                return newAge <= MAX_AGE ? {app: leaf.app, age: newAge, seq: null} : null;
            }
            // Re-enabled in this session: a window that still exists gets its
            // own slot back, one that was closed does not come back.
            if (seq !== null && !liveSeqs.has(seq))
                return null;
            return {app: leaf.app, age, seq};
        };
        for (const [key, node] of Object.entries(data ?? {})) {
            try {
                const tree = Tree.fromData(node, keepLeaf(monitors.has(key.slice(key.indexOf(':') + 1))));
                if (!tree.isEmpty)
                    this._saved.set(key, tree.toData(leaf => leaf));
            } catch (e) {
                logError(e, `Auto Tiling: saved layout ${key} ignored`);
            }
        }
        this._last = Object.fromEntries(this._saved);
        // Written back at once, so that a re-enable in this session reads the
        // aged layouts and no stable sequences of the last session.
        if (newLogin)
            this._settings.set_string('saved-layouts', JSON.stringify(this._last));
    }

    _write() {
        if (this._pending !== null && this._pending !== this._settings.get_string('saved-layouts'))
            this._settings.set_string('saved-layouts', this._pending);
        this._pending = null;
    }
}
