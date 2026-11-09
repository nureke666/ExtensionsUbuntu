// Keeps the user on the workspace they switched to. Some apps (Claude,
// Telegram) bring their window back right after the user leaves its
// workspace, and GNOME follows the window back there; that switch is undone.
//
// The user's own switches all go through GNOME Shell's JS (keys, gestures,
// the overview, panel and dash, Alt+Tab, notifications); an app bringing its
// window up switches inside mutter, past these methods.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

// How long after the user's switch a switch back counts as an app's (ms).
const GUARD_MS = 1000;
// At most this many undos per switch of the user, should two apps fight.
const MAX_UNDOS = 3;

export class WorkspaceGuard {
    constructor(settings) {
        this._settings = settings;
        const manager = global.workspace_manager;
        this._active = manager.get_active_workspace();
        // Depth of the user's switching calls in progress.
        this._byUser = 0;
        // The user's last switch: {from, to, time, undos}.
        this._last = null;
        this._undoing = false;
        this._laterId = 0;

        this._injections = new InjectionManager();
        const guard = this;
        const byUser = original => function (...args) {
            guard._byUser++;
            try {
                return original.call(this, ...args);
            } finally {
                guard._byUser--;
            }
        };
        for (const name of ['activate', 'activate_with_focus'])
            this._injections.overrideMethod(Meta.Workspace.prototype, name, byUser);
        for (const name of ['activate', 'activate_full', 'activate_window'])
            this._injections.overrideMethod(Shell.App.prototype, name, byUser);

        manager.connectObject(
            'active-workspace-changed', () => this._onSwitched(),
            'workspace-removed', () => {
                this._last = null;
                this._active = manager.get_active_workspace();
            },
            this);
    }

    destroy() {
        this._injections.clear();
        global.workspace_manager.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._last = null;
        this._active = null;
    }

    _onSwitched() {
        const from = this._active;
        const to = global.workspace_manager.get_active_workspace();
        this._active = to;
        if (this._undoing)
            return;
        const now = GLib.get_monotonic_time() / 1000;
        if (this._byUser) {
            this._last = {from, to, time: now, undos: 0};
            return;
        }
        const last = this._last;
        if (!last || to !== last.from || now - last.time > GUARD_MS || last.undos >= MAX_UNDOS ||
            this._laterId || !this._settings.get_boolean('keep-workspace'))
            return;
        last.undos++;
        // Undone once mutter is through with this switch (it focuses the
        // app's window after it), before the next frame is drawn.
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            if (this._last === last && this._active === last.from) {
                this._undoing = true;
                try {
                    last.to.activate(global.display.get_current_time_roundtrip());
                } finally {
                    this._undoing = false;
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}
