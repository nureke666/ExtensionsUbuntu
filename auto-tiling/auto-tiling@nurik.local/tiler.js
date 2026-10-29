// Tracks windows, keeps one BSP tree per workspace and monitor, and moves
// windows into the slots the trees compute.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Tree, findNeighbor} from './tree.js';

// Fraction of a split that one resize key press moves the border by.
const RESIZE_STEP = 0.05;
// Size of a window that is switched to floating, relative to the work area.
const FLOATING_WIDTH = 0.6;
const FLOATING_HEIGHT = 0.7;
const MOVE_GRAB_OPS = [
    Meta.GrabOp.MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
    Meta.GrabOp.KEYBOARD_MOVING,
];
// Longest time the focused window waits for windows it would cover (see _relayout).
const SETTLE_TIMEOUT_MS = 500;

function contains(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height;
}

function containsRect(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height;
}

function sameRect(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function byCreation(a, b) {
    return a.get_stable_sequence() - b.get_stable_sequence();
}

export class Tiler {
    constructor(settings) {
        this._settings = settings;
        // Meta.Workspace -> Map(monitor index -> Tree)
        this._trees = new Map();
        // Tracked window -> the Tree it is tiled in, or null while it floats.
        this._windows = new Map();
        // Windows the user switched to floating.
        this._floating = new Set();
        this._disabledWorkspaces = new Set();
        // Actors of new windows that have not drawn their first frame yet.
        this._pendingActors = new Set();
        // New windows split the last focused tiled window.
        this._lastFocused = null;
        this._grabbedWindow = null;
        this._relayoutId = 0;
        // The focused window's move held back until covered windows have moved.
        this._settle = null;
        this._isHidden = window => window.minimized;

        global.display.connectObject(
            'window-created', (_display, window) => this._onWindowCreated(window),
            'window-entered-monitor', (_display, _monitor, window) => this._place(window),
            'notify::focus-window', () => this._onFocusChanged(),
            'grab-op-begin', (_display, window) => this._onGrabBegin(window),
            'grab-op-end', (_display, window, op) => this._onGrabEnd(window, op),
            'workareas-changed', () => this._queueRelayout(),
            this);
        global.workspace_manager.connectObject(
            'workspace-removed', () => this._pruneWorkspaces(), this);
        settings.connectObject('changed', (_settings, key) => this._onSettingChanged(key), this);

        // Creation order makes the result the same on every enable.
        global.display.list_all_windows().sort(byCreation).forEach(window => this._track(window));
    }

    destroy() {
        if (this._relayoutId) {
            GLib.source_remove(this._relayoutId);
            this._relayoutId = 0;
        }
        this._cancelSettle();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const actor of this._pendingActors)
            actor.disconnectObject(this);
        for (const window of this._windows.keys())
            window.disconnectObject(this);
        // Windows stay where they are.
        this._pendingActors.clear();
        this._windows.clear();
        this._trees.clear();
        this._floating.clear();
        this._disabledWorkspaces.clear();
        this._lastFocused = null;
        this._grabbedWindow = null;
    }

    // Actions bound to keys.

    focus(direction) {
        const focused = global.display.focus_window;
        const workspace = global.workspace_manager.get_active_workspace();
        const candidates = new Map();
        for (const [window, tree] of this._windows) {
            if (tree && window !== focused && !window.minimized && window.located_on_workspace(workspace))
                candidates.set(window, window.get_frame_rect());
        }
        if (!candidates.size)
            return;

        const target = focused
            ? findNeighbor(focused.get_frame_rect(), candidates, direction)
            : candidates.keys().next().value;
        target?.activate(global.get_current_time());
    }

    swap(direction) {
        const window = this._focusedTiled();
        if (!window)
            return;

        const tree = this._windows.get(window);
        const rects = this._layout(tree, window.get_workspace(), window.get_monitor());
        const from = rects.get(window);
        if (!from)
            return;
        rects.delete(window);
        const target = findNeighbor(from, rects, direction);
        if (target) {
            tree.swap(window, target);
            this._queueRelayout();
        }
    }

    resize(direction) {
        const window = this._focusedTiled();
        if (!window)
            return;
        this._windows.get(window).resize(window, direction, RESIZE_STEP);
        this._queueRelayout();
    }

    toggleSplit() {
        const window = this._focusedTiled();
        if (!window)
            return;
        this._windows.get(window).toggleSplit(window);
        this._queueRelayout();
    }

    equalize() {
        const workspace = global.workspace_manager.get_active_workspace();
        this._trees.get(workspace)?.forEach(tree => tree.equalize());
        this._queueRelayout();
    }

    toggleFloating() {
        const window = global.display.focus_window;
        if (!window || !this._windows.has(window))
            return;

        if (this._windows.get(window)) {
            this._floating.add(window);
            this._place(window);
            this._centerFloating(window);
        } else if (this._floating.has(window)) {
            this._floating.delete(window);
            this._place(window);
        }
        // Anything else floats by rule (dialogs, fixed-size windows, ...).
    }

    toggleTiling() {
        const workspace = global.workspace_manager.get_active_workspace();
        const enable = this._disabledWorkspaces.has(workspace);
        if (enable)
            this._disabledWorkspaces.delete(workspace);
        else
            this._disabledWorkspaces.add(workspace);

        [...this._windows.keys()]
            .filter(window => window.get_workspace() === workspace)
            .sort(byCreation)
            .forEach(window => this._place(window));

        const icon = new Gio.ThemedIcon({name: enable ? 'view-grid-symbolic' : 'window-new-symbolic'});
        Main.osdWindowManager.show(-1, icon, enable ? 'Тайлинг включён' : 'Тайлинг выключен');
    }

    // Window tracking.

    _onWindowCreated(window) {
        const actor = window.get_compositor_private();
        if (!actor) {
            this._track(window);
            return;
        }
        // Until the first frame the client may still change the window's
        // type, parent and size; tiling it earlier gets undone.
        this._pendingActors.add(actor);
        actor.connectObject(
            'first-frame', () => {
                this._pendingActors.delete(actor);
                actor.disconnectObject(this);
                this._track(window);
            },
            'destroy', () => this._pendingActors.delete(actor),
            this);
    }

    _track(window) {
        if (this._windows.has(window))
            return;

        this._windows.set(window, null);
        window.connectObject(
            'unmanaged', () => this._untrack(window),
            'workspace-changed', () => this._place(window),
            'notify::minimized', () => this._queueRelayout(),
            'notify::fullscreen', () => this._queueRelayout(),
            'notify::maximized-horizontally', () => this._queueRelayout(),
            'notify::maximized-vertically', () => this._queueRelayout(),
            this);
        this._place(window);
    }

    _untrack(window) {
        this._windows.get(window)?.remove(window);
        window.disconnectObject(this);
        this._windows.delete(window);
        this._floating.delete(window);
        if (this._lastFocused === window)
            this._lastFocused = null;
        if (this._grabbedWindow === window)
            this._grabbedWindow = null;
        this._queueRelayout();
    }

    // Puts the window into the tree it belongs to now, or takes it out of
    // tiling when it should float.
    _place(window) {
        if (!this._windows.has(window))
            return;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const tree = this._shouldTile(window) ? this._treeFor(workspace, monitor) : null;
        const current = this._windows.get(window);
        if (current === tree)
            return;

        current?.remove(window);
        if (tree) {
            const target = this._lastFocused !== window &&
                this._windows.get(this._lastFocused) === tree ? this._lastFocused : null;
            tree.insert(window, target, this._workArea(workspace, monitor), this._isHidden);
        }
        this._windows.set(window, tree);
        if (tree && global.display.focus_window === window)
            this._lastFocused = window;
        this._queueRelayout();
    }

    _shouldTile(window) {
        const workspace = window.get_workspace();
        if (!workspace || this._disabledWorkspaces.has(workspace) || window.get_monitor() < 0)
            return false;
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        if (window.get_transient_for() || window.is_attached_dialog())
            return false;
        if (window.is_skip_taskbar() || window.is_on_all_workspaces() || !window.allows_resize())
            return false;
        if (this._floating.has(window))
            return false;

        const floatingApps = this._settings.get_strv('floating-apps');
        const ids = [window.get_wm_class(), window.get_wm_class_instance(), window.get_gtk_application_id()];
        return !ids.some(id => id && floatingApps.includes(id));
    }

    _treeFor(workspace, monitor) {
        let monitors = this._trees.get(workspace);
        if (!monitors) {
            monitors = new Map();
            this._trees.set(workspace, monitors);
        }
        let tree = monitors.get(monitor);
        if (!tree) {
            tree = new Tree();
            monitors.set(monitor, tree);
        }
        return tree;
    }

    _pruneWorkspaces() {
        const manager = global.workspace_manager;
        const alive = new Set();
        for (let i = 0; i < manager.get_n_workspaces(); i++)
            alive.add(manager.get_workspace_by_index(i));
        for (const workspace of [...this._trees.keys()]) {
            if (!alive.has(workspace))
                this._trees.delete(workspace);
        }
        for (const workspace of [...this._disabledWorkspaces]) {
            if (!alive.has(workspace))
                this._disabledWorkspaces.delete(workspace);
        }
    }

    _onFocusChanged() {
        const window = global.display.focus_window;
        if (window && this._windows.get(window))
            this._lastFocused = window;
    }

    _focusedTiled() {
        const window = global.display.focus_window;
        return window && this._windows.get(window) ? window : null;
    }

    _onSettingChanged(key) {
        if (key === 'gap-inner' || key === 'gap-outer')
            this._queueRelayout();
        else if (key === 'floating-apps')
            [...this._windows.keys()].sort(byCreation).forEach(window => this._place(window));
    }

    // Mouse: dropping a tiled window onto another one swaps them; any other
    // move or resize snaps the window back into its slot.

    _onGrabBegin(window) {
        if (this._windows.get(window))
            this._grabbedWindow = window;
    }

    _onGrabEnd(window, op) {
        if (window !== this._grabbedWindow)
            return;
        this._grabbedWindow = null;

        const tree = this._windows.get(window);
        if (tree && MOVE_GRAB_OPS.includes(op)) {
            const [x, y] = global.get_pointer();
            const rects = this._layout(tree, window.get_workspace(), window.get_monitor());
            for (const [other, rect] of rects) {
                if (other !== window && contains(rect, x, y)) {
                    tree.swap(window, other);
                    break;
                }
            }
        }
        this._queueRelayout();
    }

    // Geometry.

    _gaps() {
        return {
            inner: this._settings.get_uint('gap-inner'),
            outer: this._settings.get_uint('gap-outer'),
        };
    }

    _workArea(workspace, monitor) {
        return workspace.get_work_area_for_monitor(monitor);
    }

    _layout(tree, workspace, monitor) {
        return tree.layout(this._workArea(workspace, monitor), this._gaps(), this._isHidden);
    }

    _queueRelayout() {
        if (this._relayoutId)
            return;
        // Coalesces a burst of window events into one pass.
        this._relayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._relayoutId = 0;
            this._relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    // GNOME 46 stops sending frames to a window that is completely covered,
    // and many clients (Chrome, Electron, GTK 4) then never draw at the new
    // size they were given, so they stay where they were until uncovered. The
    // focused window is on top: when its new slot would cover a window that
    // still has to move (a swap does that), it moves only after that window
    // has taken its new place.
    _relayout() {
        this._cancelSettle();

        const moves = [];
        for (const [workspace, monitors] of this._trees) {
            for (const [monitor, tree] of monitors) {
                if (!tree.isEmpty)
                    moves.push(...this._pendingMoves(this._layout(tree, workspace, monitor)));
            }
        }

        const focused = global.display.focus_window;
        const focusedRect = moves.find(([window]) => window === focused)?.[1];
        // Geometry of the windows the focused one would cover, taken before
        // they move (a pure move can apply at once).
        const covered = new Map();
        for (const [window] of moves) {
            const frame = window.get_frame_rect();
            if (focusedRect && window !== focused && containsRect(focusedRect, frame))
                covered.set(window, frame);
        }
        for (const [window, rect] of moves) {
            if (window !== focused || !covered.size)
                this._move(window, rect);
        }
        if (covered.size)
            this._moveAfter(focused, focusedRect, covered);
    }

    // Windows of `rects` that are not in their slot yet, as [window, rect].
    _pendingMoves(rects) {
        const moves = [];
        for (const [window, rect] of rects) {
            // A fully maximized or fullscreen window covers the others and
            // keeps its slot for when it is restored.
            if (window === this._grabbedWindow || window.fullscreen ||
                window.get_maximized() === Meta.MaximizeFlags.BOTH)
                continue;
            if (!sameRect(window.get_frame_rect(), rect))
                moves.push([window, rect]);
        }
        return moves;
    }

    _move(window, rect) {
        // Half-maximized (edge-tiled) windows refuse to resize otherwise.
        if (window.get_maximized())
            window.unmaximize(window.get_maximized());
        window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
    }

    // Moves `window` to `rect` once every window in `before` (window -> its
    // geometry before moving) has changed its geometry, meaning the client
    // drew at the new size, or after SETTLE_TIMEOUT_MS.
    _moveAfter(window, rect, before) {
        const others = [...before.keys()];
        const finish = () => {
            this._cancelSettle();
            if (this._windows.get(window))
                this._move(window, rect);
        };
        const check = () => {
            if (others.every(other => !this._windows.has(other) ||
                !sameRect(other.get_frame_rect(), before.get(other))))
                finish();
        };

        // Signal owner, so that cancelling leaves the window's other handlers alone.
        const owner = {};
        for (const other of others)
            other.connectObject('size-changed', check, 'position-changed', check, owner);
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_TIMEOUT_MS, () => {
            this._settle.timeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
        this._settle = {owner, windows: others, timeoutId};
        check();
    }

    _cancelSettle() {
        if (!this._settle)
            return;
        for (const window of this._settle.windows)
            window.disconnectObject(this._settle.owner);
        if (this._settle.timeoutId)
            GLib.source_remove(this._settle.timeoutId);
        this._settle = null;
    }

    _centerFloating(window) {
        const area = this._workArea(window.get_workspace(), window.get_monitor());
        const width = Math.round(area.width * FLOATING_WIDTH);
        const height = Math.round(area.height * FLOATING_HEIGHT);
        window.move_resize_frame(false,
            area.x + Math.round((area.width - width) / 2),
            area.y + Math.round((area.height - height) / 2),
            width, height);
    }
}
