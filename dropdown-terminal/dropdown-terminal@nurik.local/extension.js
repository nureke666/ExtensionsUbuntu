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
// Longest wait for the window to take its new size before it slides in.
const PLACE_TIMEOUT_MS = 300;
// Longest wait for the first frame of a window that may have drawn it already.
const DRAWN_TIMEOUT_MS = 500;

// The module outlives disable and enable (GNOME re-enables an extension when
// one enabled before it is turned off, also on screen lock), so the running
// terminal is kept here. The handlers below are the module's, not the
// extension's: they stay connected while it is disabled, so a terminal that
// exits meanwhile is forgotten and never touched again.
const state = {
    client: null,      // Meta.WaylandClient of the running terminal.js
    subprocess: null,  // its process
    window: null,      // its window
};
const moduleOwner = {};
// Clients of terminals that have exited, kept so that GJS never collects one
// while mutter may still have windows of it.
const retiredClients = [];

function trackWindow(window) {
    if (state.window === window)
        return;
    state.window = window;
    window.connectObject('unmanaged', () => {
        window.disconnectObject(moduleOwner);
        if (state.window === window)
            state.window = null;
    }, moduleOwner);
}

// Both checked on the spot, not left to signals: a callback may come late,
// or not at all when GJS is collecting garbage at that moment.
// Whether terminal.js still runs; mutter warns on calls to the client of a
// process that has exited.
function alive() {
    if (state.client && state.subprocess?.get_identifier() === null) {
        retiredClients.push(state.client);
        state.client = null;
        state.subprocess = null;
    }
    return !!state.client;
}

// The terminal window, if it is still there.
function current() {
    if (state.window && !global.display.list_all_windows().includes(state.window))
        state.window = null;
    return state.window;
}

function owns(window) {
    return alive() && state.client.owns_window(window);
}

function setListed(window, listed) {
    if (!alive())
        return;
    if (listed)
        state.client.show_in_window_list(window);
    else
        state.client.hide_from_window_list(window);
}

function sameRect(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export default class DropdownTerminalExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Sliding away: a press now brings it back.
        this._hiding = false;
        this._pendingActors = new Set();
        this._idleIds = new Set();
        this._focusIdleId = 0;
        this._waitPlaced = null;

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

        // The terminal from before a disable is taken back and put in place
        // (meanwhile a tiling extension may have moved it). A window that came
        // just before the disable and was never placed is placed now.
        const window = current() ?? global.display.list_all_windows().find(owns);
        if (!window?.get_compositor_private())
            return;
        if (state.window === window) {
            this._adopt(window);
            if (!window.minimized)
                this._place(window, window.get_monitor());
        } else {
            this._adoptWhenDrawn(window);
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
        if (this._focusIdleId)
            GLib.source_remove(this._focusIdleId);
        this._cancelWaitPlaced();
        const window = current();
        if (window) {
            const actor = window.get_compositor_private();
            if (actor) {
                actor.remove_all_transitions();
                actor.translation_y = 0;
                actor.opacity = 255;
            }
            // Turned off for real, the terminal stays open as an ordinary
            // window. Not on the lock screen: there GNOME enables us again
            // right away, and Auto Tiling, also running there, would tile it.
            if (!Main.sessionMode.isLocked) {
                setListed(window, true);
                window.unmake_above();
                window.unstick();
            }
        }
        this._settings = null;
    }

    _toggle() {
        const window = current();
        if (!window)
            this._spawn();
        else if (window.minimized || this._hiding)
            this._show(window);
        else if (global.display.focus_window === window)
            this._hide(window);
        else
            window.activate(global.get_current_time());
    }

    _spawn() {
        if (alive()) {
            // Running but without a placed window: take it, else it is still starting.
            const window = global.display.list_all_windows().find(owns);
            if (window)
                this._adoptWhenDrawn(window);
            return;
        }
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.set_cwd(GLib.get_home_dir());
        const client = Meta.WaylandClient.new(global.context, launcher);
        let process;
        try {
            process = client.spawnv(global.display, ['gjs', '-m', `${this.path}/terminal.js`]);
        } catch (e) {
            Main.notifyError('Dropdown Terminal: терминал не запустился', e.message);
            return;
        } finally {
            // The launcher keeps its copy of the terminal's end of the Wayland
            // socket until closed: then the connection outlives the process
            // (after `exit` the dead window stayed) until GJS collects it.
            launcher.close();
        }
        state.client = client;
        state.subprocess = process;
        process.wait_async(null, () => alive());
    }

    _onWindowCreated(window) {
        if (current() || !owns(window))
            return;
        // Out of the taskbar, Alt+Tab and the tiling before anyone sees it.
        setListed(window, false);
        this._adoptWhenDrawn(window);
    }

    // Takes the window once it has drawn its first frame: mutter places it
    // then and would undo our place. One that came while we were disabled may
    // have drawn it already, so a short timeout takes it anyway.
    _adoptWhenDrawn(window) {
        const actor = window.get_compositor_private();
        if (!actor) {
            this._adoptNew(window);
            return;
        }
        if (this._pendingActors.has(actor))
            return;
        // Hidden until it is in place at the top; mutter maps it in the middle.
        actor.opacity = 0;
        this._pendingActors.add(actor);
        let timeoutId = 0;
        const adopt = () => {
            if (!this._pendingActors.delete(actor))
                return;
            actor.disconnectObject(this);
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                this._idleIds.delete(timeoutId);
            }
            // first-frame comes while a frame is painted, and restacking
            // then (make_above) aborts mutter, so this waits for idle.
            const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idleIds.delete(id);
                if (!current() && window.get_compositor_private() && owns(window))
                    this._adoptNew(window);
                return GLib.SOURCE_REMOVE;
            });
            this._idleIds.add(id);
        };
        actor.connectObject(
            'first-frame', adopt,
            'destroy', () => this._pendingActors.delete(actor),
            this);
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAWN_TIMEOUT_MS, () => {
            this._idleIds.delete(timeoutId);
            timeoutId = 0;
            adopt();
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(timeoutId);
    }

    _adoptNew(window) {
        this._adopt(window);
        const target = this._place(window);
        window.activate(global.get_current_time());
        this._slideIn(window, target);
    }

    _adopt(window) {
        trackWindow(window);
        setListed(window, false);
        window.make_above();
        window.stick();
    }

    // Brings the hidden terminal to the monitor under the pointer.
    _show(window) {
        this._hiding = false;
        window.stick();
        const target = this._place(window);
        const actor = window.get_compositor_private();
        if (actor && window.minimized)
            Main.wm.skipNextEffect(actor);
        window.unminimize();
        window.activate(global.get_current_time());
        this._slideIn(window, target);
    }

    _hide(window) {
        const actor = window.get_compositor_private();
        if (!actor) {
            this._minimize(window);
            return;
        }
        this._cancelWaitPlaced();
        actor.remove_all_transitions();
        this._hiding = true;
        actor.ease({
            translation_y: -this._slideDistance(window),
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._hiding = false;
                actor.translation_y = 0;
                // Closed meanwhile: nothing left to minimize.
                if (current() !== window)
                    return;
                Main.wm.skipNextEffect(actor);
                this._minimize(window);
            },
        });
    }

    // Mutter does not minimize a window that is out of the window list (there
    // would be no way back), so it goes in for this one call only; nothing is
    // drawn in between.
    _minimize(window) {
        if (current() !== window || !alive())
            return;
        setListed(window, true);
        window.minimize();
        setListed(window, false);
    }

    // Slides the window in from above once it has the place `target` (on
    // Wayland a new size comes with the client's next frame; sliding before
    // that would show it a moment at its old place, maybe on another monitor).
    _slideIn(window, target) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;
        actor.remove_all_transitions();
        this._cancelWaitPlaced();
        const start = () => {
            this._cancelWaitPlaced();
            if (current() !== window || !window.get_compositor_private())
                return;
            actor.opacity = 255;
            actor.translation_y = -this._slideDistance(window);
            actor.ease({
                translation_y: 0,
                duration: SLIDE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };
        if (sameRect(window.get_frame_rect(), target)) {
            start();
            return;
        }
        actor.opacity = 0;
        const owner = {};
        const check = () => {
            if (sameRect(window.get_frame_rect(), target))
                start();
        };
        window.connectObject('size-changed', check, 'position-changed', check, owner);
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACE_TIMEOUT_MS, () => {
            this._waitPlaced.timeoutId = 0;
            start();
            return GLib.SOURCE_REMOVE;
        });
        this._waitPlaced = {window, owner, timeoutId};
    }

    _cancelWaitPlaced() {
        const wait = this._waitPlaced;
        if (!wait)
            return;
        this._waitPlaced = null;
        wait.window.disconnectObject(wait.owner);
        if (wait.timeoutId)
            GLib.source_remove(wait.timeoutId);
    }

    // From its place to just above the top of its monitor's work area.
    _slideDistance(window) {
        const frame = window.get_frame_rect();
        const monitor = window.get_monitor();
        if (monitor < 0)
            return frame.height;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        return frame.y - area.y + frame.height;
    }

    // Top of the monitor's work area (by default the one under the pointer),
    // centered. Returns the rect.
    _place(window, monitor = -1) {
        if (monitor < 0)
            monitor = global.display.get_current_monitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const width = Math.round(area.width * this._settings.get_uint('width') / 100);
        const height = Math.round(area.height * this._settings.get_uint('height') / 100);
        const rect = {x: area.x + Math.round((area.width - width) / 2), y: area.y, width, height};
        if (window.get_maximized())
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        if (window.fullscreen)
            window.unmake_fullscreen();
        window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        return rect;
    }

    _onSizeChanged() {
        const window = current();
        if (window && !window.minimized)
            this._place(window, window.get_monitor());
    }

    // Looked at in an idle: a closing terminal loses the focus before it is
    // unmanaged, and must not be hidden then.
    _onFocusChanged() {
        if (this._focusIdleId)
            return;
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            this._hideOnUnfocus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideOnUnfocus() {
        const window = current();
        const focused = global.display.focus_window;
        if (!window || window.minimized || this._hiding || !focused || focused === window ||
            !this._settings.get_boolean('hide-on-unfocus'))
            return;
        // Its own dialogs keep it open.
        if (focused.get_transient_for() === window || owns(focused))
            return;
        this._hide(window);
    }
}
