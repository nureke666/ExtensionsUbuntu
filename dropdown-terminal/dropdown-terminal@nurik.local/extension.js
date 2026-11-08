// Dropdown Terminal: Super+Enter shows a terminal at the top of the screen,
// the next press hides it. The terminal is an ordinary app window, recognised
// by its application id; the extension only shows, hides and places it.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// How long a press waits for the terminal it started before it may start another.
const SPAWN_TIMEOUT_S = 15;

export default class DropdownTerminalExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._window = null;
        this._spawnTimeoutId = 0;
        // Actors of new windows that have not drawn their first frame yet.
        this._pendingActors = new Set();
        this._idleIds = new Set();

        global.display.connectObject(
            'window-created', (_display, window) => this._onWindowCreated(window),
            'notify::focus-window', () => this._onFocusChanged(),
            this);
        this._settings.connectObject(
            'changed::width', () => this._onSizeChanged(),
            'changed::height', () => this._onSizeChanged(),
            this);
        Main.wm.addKeybinding('toggle', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._toggle());

        // A terminal from before a lock or a re-enable is picked up as it is.
        const existing = global.display.list_all_windows().find(window => this._matches(window));
        if (existing)
            this._adopt(existing);
    }

    disable() {
        Main.wm.removeKeybinding('toggle');
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const actor of this._pendingActors)
            actor.disconnectObject(this);
        this._pendingActors.clear();
        this._idleIds.forEach(id => GLib.source_remove(id));
        this._idleIds.clear();
        // The terminal stays open as an ordinary window.
        if (this._window) {
            this._window.disconnectObject(this);
            this._window.unmake_above();
            this._window.unstick();
            this._window = null;
        }
        this._clearSpawn();
        this._settings = null;
    }

    _toggle() {
        const window = this._window;
        if (!window)
            this._spawn();
        else if (window.minimized)
            this._show(window);
        else if (global.display.focus_window === window)
            window.minimize();
        else
            window.activate(global.get_current_time());
    }

    _spawn() {
        // The terminal may take a few seconds to start; a second press must
        // not start another one.
        if (this._spawnTimeoutId)
            return;
        Util.spawn(this._settings.get_strv('command'));
        this._spawnTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SPAWN_TIMEOUT_S, () => {
            this._spawnTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearSpawn() {
        if (this._spawnTimeoutId) {
            GLib.source_remove(this._spawnTimeoutId);
            this._spawnTimeoutId = 0;
        }
    }

    _matches(window) {
        const appId = this._settings.get_string('app-id');
        return window.get_window_type() === Meta.WindowType.NORMAL && !window.get_transient_for() &&
            (window.get_gtk_application_id() === appId || window.get_wm_class() === appId);
    }

    _onWindowCreated(window) {
        if (this._window)
            return;
        const actor = window.get_compositor_private();
        if (!actor) {
            if (this._matches(window))
                this._adoptNew(window);
            return;
        }

        // A Wayland window gets its application id only after it is created,
        // and mutter places it when it maps: both are done by the first frame.
        this._pendingActors.add(actor);
        actor.connectObject(
            'first-frame', () => {
                this._pendingActors.delete(actor);
                actor.disconnectObject(this);
                // first-frame comes while a frame is painted, and restacking
                // then (make_above) aborts mutter, so this waits for idle.
                const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._idleIds.delete(id);
                    if (!this._window && window.get_compositor_private() && this._matches(window))
                        this._adoptNew(window);
                    return GLib.SOURCE_REMOVE;
                });
                this._idleIds.add(id);
            },
            'destroy', () => this._pendingActors.delete(actor),
            this);
    }

    _adoptNew(window) {
        this._clearSpawn();
        this._adopt(window);
        this._place(window);
        window.activate(global.get_current_time());
    }

    _adopt(window) {
        this._window = window;
        window.make_above();
        window.stick();
        window.connectObject('unmanaged', () => {
            window.disconnectObject(this);
            this._window = null;
        }, this);
    }

    // Brings the hidden terminal to the monitor under the pointer.
    _show(window) {
        window.stick();
        this._place(window);
        window.unminimize();
        window.activate(global.get_current_time());
    }

    // Top of the monitor's work area (by default the one under the pointer), centered.
    _place(window, monitor = global.display.get_current_monitor()) {
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const width = Math.round(area.width * this._settings.get_uint('width') / 100);
        const height = Math.round(area.height * this._settings.get_uint('height') / 100);
        if (window.get_maximized())
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        if (window.fullscreen)
            window.unmake_fullscreen();
        window.move_resize_frame(false,
            area.x + Math.round((area.width - width) / 2), area.y, width, height);
    }

    _onSizeChanged() {
        if (this._window && !this._window.minimized)
            this._place(this._window, this._window.get_monitor());
    }

    _onFocusChanged() {
        const window = this._window;
        const focused = global.display.focus_window;
        if (!window || window.minimized || !focused || focused === window ||
            !this._settings.get_boolean('hide-on-unfocus'))
            return;
        // Its own dialogs (preferences, "close this terminal?") keep it open.
        if (focused.get_transient_for() === window || this._matches(focused))
            return;
        window.minimize();
    }
}
