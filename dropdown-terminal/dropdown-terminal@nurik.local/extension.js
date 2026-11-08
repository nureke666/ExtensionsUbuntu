// Dropdown Terminal: Super+Enter slides a borderless terminal down from the top
// of the screen, the next press slides it back up. The terminal (terminal.js)
// runs as a Wayland client of the extension's own, so its window is known
// from the start and kept out of the taskbar and Alt+Tab.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SLIDE_MS = 160;

// The module outlives disable and enable (GNOME re-enables extensions on
// screen lock), so the running terminal is kept here.
let client = null;      // Meta.WaylandClient of terminal.js
let subprocess = null;  // its process, while it runs
let terminal = null;    // its window

export default class DropdownTerminalExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Sliding away: a press now brings it back.
        this._hiding = false;
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

        // The terminal from before a disable is taken back and put in place:
        // meanwhile a tiling extension may have moved it.
        if (terminal) {
            this._adopt(terminal);
            if (!terminal.minimized)
                this._place(terminal, terminal.get_monitor());
        }
    }

    disable() {
        // GNOME may call disable twice in a row when several extensions change at once.
        if (!this._settings)
            return;
        Main.wm.removeKeybinding('toggle');
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const actor of this._pendingActors) {
            actor.disconnectObject(this);
            actor.opacity = 255;
        }
        this._pendingActors.clear();
        this._idleIds.forEach(id => GLib.source_remove(id));
        this._idleIds.clear();
        if (terminal) {
            terminal.disconnectObject(this);
            const actor = terminal.get_compositor_private();
            if (actor) {
                actor.remove_all_transitions();
                actor.translation_y = 0;
                actor.opacity = 255;
            }
            // Turned off for real, the terminal stays open as an ordinary
            // window. Not on the lock screen: GNOME enables us again right away.
            if (!Main.sessionMode.isLocked) {
                client.show_in_window_list(terminal);
                terminal.unmake_above();
                terminal.unstick();
            }
        }
        this._settings = null;
    }

    _toggle() {
        if (!terminal)
            this._spawn();
        else if (terminal.minimized || this._hiding)
            this._show(terminal);
        else if (global.display.focus_window === terminal)
            this._hide(terminal);
        else
            terminal.activate(global.get_current_time());
    }

    _spawn() {
        // Starting already: the window comes in a moment.
        if (subprocess)
            return;
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.set_cwd(GLib.get_home_dir());
        const newClient = Meta.WaylandClient.new(global.context, launcher);
        let process;
        try {
            process = newClient.spawnv(global.display, ['gjs', '-m', `${this.path}/terminal.js`]);
        } catch (e) {
            Main.notifyError('Dropdown Terminal: терминал не запустился', e.message);
            return;
        }
        client = newClient;
        subprocess = process;
        process.wait_async(null, () => {
            if (subprocess === process)
                subprocess = null;
        });
    }

    _onWindowCreated(window) {
        if (!client?.owns_window(window) || terminal)
            return;
        // Out of the taskbar, Alt+Tab and the tiling before anyone sees it.
        client.hide_from_window_list(window);
        const actor = window.get_compositor_private();
        if (!actor) {
            this._adoptNew(window);
            return;
        }
        // Hidden until it is in place at the top; mutter maps it in the middle.
        actor.opacity = 0;
        this._pendingActors.add(actor);
        actor.connectObject(
            'first-frame', () => {
                this._pendingActors.delete(actor);
                actor.disconnectObject(this);
                // first-frame comes while a frame is painted, and restacking
                // then (make_above) aborts mutter, so this waits for idle.
                const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._idleIds.delete(id);
                    if (window.get_compositor_private())
                        this._adoptNew(window);
                    return GLib.SOURCE_REMOVE;
                });
                this._idleIds.add(id);
            },
            'destroy', () => this._pendingActors.delete(actor),
            this);
    }

    _adoptNew(window) {
        this._adopt(window);
        this._place(window);
        window.activate(global.get_current_time());
        this._slideIn(window);
    }

    _adopt(window) {
        terminal = window;
        client.hide_from_window_list(window);
        window.make_above();
        window.stick();
        window.connectObject('unmanaged', () => {
            window.disconnectObject(this);
            terminal = null;
        }, this);
    }

    // Brings the hidden terminal to the monitor under the pointer.
    _show(window) {
        this._hiding = false;
        window.stick();
        this._place(window);
        const actor = window.get_compositor_private();
        if (actor && window.minimized)
            Main.wm.skipNextEffect(actor);
        window.unminimize();
        window.activate(global.get_current_time());
        this._slideIn(window);
    }

    _hide(window) {
        const actor = window.get_compositor_private();
        if (!actor) {
            this._minimize(window);
            return;
        }
        actor.remove_all_transitions();
        this._hiding = true;
        actor.ease({
            translation_y: -this._slideDistance(window),
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._hiding = false;
                Main.wm.skipNextEffect(actor);
                this._minimize(window);
                actor.translation_y = 0;
            },
        });
    }

    // Mutter does not minimize a window that is out of the window list (there
    // would be no way back), so it goes in for this one call only; nothing is
    // drawn in between.
    _minimize(window) {
        client.show_in_window_list(window);
        window.minimize();
        client.hide_from_window_list(window);
    }

    _slideIn(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;
        actor.remove_all_transitions();
        actor.opacity = 255;
        actor.translation_y = -this._slideDistance(window);
        actor.ease({
            translation_y: 0,
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // From its place to just above the top of its monitor's work area.
    _slideDistance(window) {
        const area = Main.layoutManager.getWorkAreaForMonitor(window.get_monitor());
        const frame = window.get_frame_rect();
        return frame.y - area.y + frame.height;
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
        if (terminal && !terminal.minimized)
            this._place(terminal, terminal.get_monitor());
    }

    _onFocusChanged() {
        const focused = global.display.focus_window;
        if (!terminal || terminal.minimized || !focused || focused === terminal ||
            !this._settings.get_boolean('hide-on-unfocus'))
            return;
        // Its own dialogs keep it open.
        if (focused.get_transient_for() === terminal || client?.owns_window(focused))
            return;
        this._hide(terminal);
    }
}
