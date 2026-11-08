// Tracks windows, keeps one BSP tree per workspace and monitor, and moves
// windows into the slots the trees compute.
//
// With workspaces on the primary monitor only (the GNOME default), windows on
// the other monitors are on every workspace, so each of those monitors has one
// tree under ALL_WORKSPACES instead of one per workspace.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LayoutStore, Placeholder, appId} from './layouts.js';
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
// Tree key for the windows of a monitor that does not switch workspaces.
const ALL_WORKSPACES = 'all-workspaces';
const MONITOR_DIRECTIONS = {
    left: Meta.DisplayDirection.LEFT,
    right: Meta.DisplayDirection.RIGHT,
    up: Meta.DisplayDirection.UP,
    down: Meta.DisplayDirection.DOWN,
};

// User choices that must outlive a disable and enable inside the session
// (GNOME does that on screen lock); the module stays loaded meanwhile.
// Stable sequences of windows the user switched to floating:
const floatingSeqs = new Set();
// Workspaces (or ALL_WORKSPACES) where the user turned tiling off:
const disabledKeys = new Set();
// Stable sequence -> smallest size the window turned out to accept (see
// _learnMinSize); a re-enable would not see it again, the size does not change.
const minSizes = new Map();

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
        // Meta.Workspace or ALL_WORKSPACES -> Map(monitor index -> Tree)
        this._trees = new Map();
        // Tracked window -> the Tree it is tiled in, or null while it floats.
        this._windows = new Map();
        // Actors of new windows that have not drawn their first frame yet.
        this._pendingActors = new Set();
        // New windows split the last focused tiled window.
        this._lastFocused = null;
        this._grabbedWindow = null;
        this._relayoutId = 0;
        // The slot each tiled window should have (see _onFrameChanged).
        this._requested = new Map();
        // Window -> the last few sizes asked of it, "WxH" (see _learnMinSize).
        this._askedSizes = new Map();
        // Window -> monotonic times of slots asked again (see _mayAskAgain).
        this._reasks = new Map();
        // The focused window's move held back until covered windows have moved.
        this._settle = null;
        this._store = new LayoutStore(settings,
            new Set(global.display.list_all_windows().map(window => window.get_stable_sequence())),
            this._connectedMonitors());
        // Idle sources of new windows waiting to be unmaximized.
        this._unmaximizeIds = new Set();
        // Placeholders of saved layouts take no space until their app opens.
        this._isHidden = id => id instanceof Placeholder || id.minimized;

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
        this._unmaximizeIds.forEach(id => GLib.source_remove(id));
        this._unmaximizeIds.clear();
        this._store.stash(this._trees);
        this._store.destroy();
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
        this._requested.clear();
        this._askedSizes.clear();
        this._reasks.clear();
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

    // Swaps with the neighbour; at the edge of the monitor, and for a window
    // that is not tiled, moves the window to the next monitor, as GNOME's
    // Super+Shift+arrows did before we took them.
    swap(direction) {
        const window = global.display.focus_window;
        if (!window)
            return;

        const tree = this._windows.get(window);
        const rects = tree ? this._layout(tree) : new Map();
        const from = rects.get(window);
        rects.delete(window);
        const target = from && findNeighbor(from, rects, direction);
        if (target) {
            tree.swap(window, target);
            this._changed(tree);
            return;
        }
        // Not the desktop icons and other helper windows.
        if (!tree && window.is_skip_taskbar())
            return;
        const monitor = global.display.get_monitor_neighbor_index(
            tree?.monitor ?? window.get_monitor(), MONITOR_DIRECTIONS[direction]);
        if (monitor >= 0)
            this._moveToMonitor(window, monitor);
    }

    resize(direction) {
        const window = this._focusedTiled();
        if (!window)
            return;
        const tree = this._windows.get(window);
        this._dropPlaceholders(tree);
        const before = this._layout(tree);
        const undo = tree.resize(window, direction, RESIZE_STEP);
        // A press that runs into a window's minimum moves nothing; the split
        // must not drift towards its end unseen and jump there later.
        const after = this._layout(tree);
        if (undo && [...after].every(([id, rect]) => before.has(id) && sameRect(before.get(id), rect))) {
            undo();
            return;
        }
        this._changed(tree);
    }

    toggleSplit() {
        const window = this._focusedTiled();
        if (!window)
            return;
        const tree = this._windows.get(window);
        this._dropPlaceholders(tree);
        tree.toggleSplit(window);
        this._changed(tree);
    }

    equalize() {
        this._trees.get(this._currentKey())?.forEach(tree => {
            tree.equalize();
            this._changed(tree);
        });
    }

    toggleFloating() {
        const window = global.display.focus_window;
        if (!window || !this._windows.has(window))
            return;

        const tree = this._windows.get(window);
        if (tree) {
            floatingSeqs.add(window.get_stable_sequence());
            this._place(window);
            this._changed(tree);
            this._centerFloating(window);
        } else if (floatingSeqs.delete(window.get_stable_sequence())) {
            this._place(window);
        }
        // Anything else floats by rule (dialogs, fixed-size windows, ...).
    }

    toggleTiling() {
        const key = this._currentKey();
        const enable = disabledKeys.has(key);
        if (enable)
            disabledKeys.delete(key);
        else
            disabledKeys.add(key);

        [...this._windows.keys()]
            .filter(window => this._workspaceKey(window) === key)
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
                this._unmaximizeNew(window);
            },
            'destroy', () => this._pendingActors.delete(actor),
            this);
    }

    // Apps that remember being maximized (browsers, editors) and big windows
    // GNOME maximizes itself open over everything; a new window takes its slot
    // instead. Not inside first-frame: changing the window there can crash mutter.
    _unmaximizeNew(window) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._unmaximizeIds.delete(id);
            if (this._windows.get(window) && window.get_maximized() === Meta.MaximizeFlags.BOTH)
                window.unmaximize(Meta.MaximizeFlags.BOTH);
            return GLib.SOURCE_REMOVE;
        });
        this._unmaximizeIds.add(id);
    }

    _track(window) {
        if (this._windows.has(window))
            return;

        this._windows.set(window, null);
        window.connectObject(
            'unmanaged', () => this._untrack(window),
            'workspace-changed', () => this._place(window),
            'notify::minimized', () => this._queueRelayout(),
            'size-changed', () => this._onFrameChanged(window),
            'position-changed', () => this._onFrameChanged(window),
            'notify::resizeable', () => this._place(window),
            'notify::above', () => this._place(window),
            'notify::fullscreen', () => {
                this._place(window);
                this._queueRelayout();
            },
            'notify::maximized-horizontally', () => this._queueRelayout(),
            'notify::maximized-vertically', () => this._queueRelayout(),
            this);
        this._place(window);
    }

    // Mutter ignores a move to the rect a window still has while an earlier
    // move is not drawn yet; the client then draws that earlier size, and the
    // slot is asked for again. A size the client picked itself (a terminal
    // fitting whole cells, an app resizing itself) is left alone: asking again
    // would make the two pull the size back and forth.
    _onFrameChanged(window) {
        const requested = this._requested.get(window);
        const tree = this._windows.get(window);
        if (!requested || !tree || window === this._grabbedWindow)
            return;
        const frame = window.get_frame_rect();
        if (this._learnMinSize(window, frame, requested))
            this._queueRelayout();
        else if (!sameRect(frame, requested) && this._isStale(window, frame) && this._mayAskAgain(window))
            this._queueRelayout();
    }

    // Whether the frame has a size asked of the window before the current one.
    _isStale(window, frame) {
        const asked = this._askedSizes.get(window) ?? [];
        return asked.slice(0, -1).includes(`${frame.width}x${frame.height}`);
    }

    // At most a few repeated asks a second, should a client keep going back.
    _mayAskAgain(window) {
        const now = GLib.get_monotonic_time();
        const asks = (this._reasks.get(window) ?? []).filter(time => now - time < 2 * GLib.USEC_PER_SEC);
        if (asks.length >= 4)
            return false;
        this._reasks.set(window, [...asks, now]);
        return true;
    }

    // Some clients cannot be as small as their slot (Chrome is at least 500 px
    // wide) and would overlap a neighbour. A window that took the position
    // asked for but kept a bigger size gets that size as its minimum, and the
    // layout makes room for it. A window that later turns out smaller lowers
    // its minimum. Not learned: from maximized or fullscreen windows, and from
    // a size asked of the window before (a late frame for an older request,
    // e.g. when several windows open at once). Returns whether it changed.
    _learnMinSize(window, frame, requested) {
        if (window.get_maximized() || window.fullscreen)
            return false;
        const seq = window.get_stable_sequence();
        const old = minSizes.get(seq) ?? {width: 0, height: 0};
        const moved = frame.x === requested.x && frame.y === requested.y && !this._isStale(window, frame);
        const learn = (size, wanted, known) => {
            if (moved && size > wanted)
                return size;
            if (known && size < known)
                return size;
            return known;
        };
        const min = {
            width: learn(frame.width, requested.width, old.width),
            height: learn(frame.height, requested.height, old.height),
        };
        if (min.width === old.width && min.height === old.height)
            return false;
        minSizes.set(seq, min);
        return true;
    }

    _untrack(window) {
        this._windows.get(window)?.remove(window);
        window.disconnectObject(this);
        this._windows.delete(window);
        this._requested.delete(window);
        this._askedSizes.delete(window);
        this._reasks.delete(window);
        minSizes.delete(window.get_stable_sequence());
        floatingSeqs.delete(window.get_stable_sequence());
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

        const tree = this._shouldTile(window)
            ? this._treeFor(this._workspaceKey(window), window.get_monitor()) : null;
        const current = this._windows.get(window);
        if (current === tree)
            return;

        current?.remove(window);
        if (tree) {
            const placeholder = this._placeholderFor(tree, window);
            if (placeholder) {
                tree.replace(placeholder, window);
            } else {
                const target = this._lastFocused !== window &&
                    this._windows.get(this._lastFocused) === tree ? this._lastFocused : null;
                tree.insert(window, target, this._workArea(tree), this._isHidden);
            }
        }
        this._windows.set(window, tree);
        if (tree && global.display.focus_window === window)
            this._lastFocused = window;
        // A window that only leaves its tree is not saved (see LayoutStore.save).
        if (tree)
            this._save();
        this._queueRelayout();
    }

    // The tree key for the window: its workspace, ALL_WORKSPACES on a monitor
    // that does not switch workspaces, or null for a window the user pinned
    // to all workspaces (it floats).
    _workspaceKey(window) {
        if (!window.is_on_all_workspaces())
            return window.get_workspace();
        return Meta.prefs_get_workspaces_only_on_primary() && !window.is_on_primary_monitor()
            ? ALL_WORKSPACES : null;
    }

    // Where Super+= and Super+T act: the workspace of the focused window, or
    // ALL_WORKSPACES when it is on a monitor that does not switch workspaces.
    _currentKey() {
        const focused = global.display.focus_window;
        return (focused && this._windows.has(focused) && this._workspaceKey(focused)) ||
            global.workspace_manager.get_active_workspace();
    }

    _shouldTile(window) {
        const key = this._workspaceKey(window);
        if (!key || disabledKeys.has(key) || window.get_monitor() < 0)
            return false;
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        if (window.get_transient_for() || window.is_attached_dialog())
            return false;
        // Always-on-top windows (a drop-down terminal, a video) float over the rest.
        if (window.is_skip_taskbar() || window.above || !this._isResizable(window))
            return false;
        if (floatingSeqs.has(window.get_stable_sequence()))
            return false;

        const floatingApps = this._settings.get_strv('floating-apps');
        // The settings window adds .desktop ids; the tracker maps windows to
        // them (StartupWMClass and the like).
        const desktopId = Shell.WindowTracker.get_default().get_window_app(window)?.get_id()
            ?.replace(/\.desktop$/, '');
        const ids = [window.get_wm_class(), window.get_wm_class_instance(),
            window.get_gtk_application_id(), desktopId];
        return !ids.some(id => id && floatingApps.includes(id));
    }

    // allows_resize() is false for any maximized window, and a fullscreen one
    // reports no features at all, so it keeps whatever it is now.
    _isResizable(window) {
        return window.fullscreen ? Boolean(this._windows.get(window)) : window.resizeable;
    }

    _treeFor(key, monitor) {
        let monitors = this._trees.get(key);
        if (!monitors) {
            monitors = new Map();
            this._trees.set(key, monitors);
        }
        let tree = monitors.get(monitor);
        if (!tree) {
            // Remembers where it lives, for its work area.
            tree = Object.assign(new Tree(), {workspace: key, monitor});
            this._store.restore(tree, this._savedKey(tree));
            monitors.set(monitor, tree);
        }
        return tree;
    }

    _pruneWorkspaces() {
        const manager = global.workspace_manager;
        const alive = new Set([ALL_WORKSPACES]);
        for (let i = 0; i < manager.get_n_workspaces(); i++)
            alive.add(manager.get_workspace_by_index(i));
        for (const workspace of [...this._trees.keys()]) {
            if (!alive.has(workspace))
                this._trees.delete(workspace);
        }
        for (const workspace of [...disabledKeys]) {
            if (!alive.has(workspace))
                disabledKeys.delete(workspace);
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
        if (key === 'gap-inner' || key === 'gap-outer') {
            this._queueRelayout();
        } else if (key === 'remember-layout') {
            if (this._store.enabled) {
                this._save();
            } else {
                this._store.clear();
                for (const monitors of this._trees.values())
                    monitors.forEach(tree => this._dropPlaceholders(tree));
            }
        }
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
            const rects = this._layout(tree);
            for (const [other, rect] of rects) {
                if (other !== window && contains(rect, x, y)) {
                    tree.swap(window, other);
                    this._save();
                    break;
                }
            }
        }
        this._queueRelayout();
    }

    // Saving layouts.

    // After a change the user made by hand: saves and moves the windows.
    _changed(tree) {
        this._dropPlaceholders(tree);
        this._save();
        this._queueRelayout();
    }

    // Layouts of monitors that are gone (unplugged) stay saved for when they
    // come back.
    _save() {
        const connected = this._connectedMonitors();
        this._store.save(this._savedTrees(), key => !connected.has(key.slice(key.indexOf(':') + 1)));
    }

    _connectedMonitors() {
        const names = new Set();
        for (let i = 0; i < global.display.get_n_monitors(); i++)
            names.add(this._monitorName(i));
        return names;
    }

    // Saved layouts name a monitor by its size, as monitor numbers change when
    // one is plugged or unplugged; same-sized ones go by position.
    _monitorName(index) {
        const display = global.display;
        const own = display.get_monitor_geometry(index);
        const twins = [];
        for (let i = 0; i < display.get_n_monitors(); i++) {
            const other = display.get_monitor_geometry(i);
            if (other.width === own.width && other.height === own.height)
                twins.push(other);
        }
        twins.sort((a, b) => a.x - b.x || a.y - b.y);
        const n = twins.findIndex(other => other.x === own.x && other.y === own.y);
        return `${own.width}x${own.height}${n > 0 ? `#${n}` : ''}`;
    }

    // The slot this window had before a re-enable, else a slot of its app
    // from an earlier login.
    _placeholderFor(tree, window) {
        const app = appId(window);
        const seq = window.get_stable_sequence();
        const slots = tree.ids.filter(id => id instanceof Placeholder && id.app === app);
        return slots.find(slot => slot.seq === seq) ?? slots.find(slot => slot.seq === null);
    }

    // Once the user rearranges a tree by hand, its old layout is not wanted.
    _dropPlaceholders(tree) {
        for (const id of tree.ids) {
            if (id instanceof Placeholder)
                tree.remove(id);
        }
    }

    // Saved layouts are keyed by workspace number and monitor name.
    _savedKey(tree) {
        const workspace = tree.workspace === ALL_WORKSPACES ? 'all' : tree.workspace.index();
        return `${workspace}:${this._monitorName(tree.monitor)}`;
    }

    *_savedTrees() {
        const count = global.display.get_n_monitors();
        for (const monitors of this._trees.values()) {
            for (const tree of monitors.values()) {
                // A tree of a monitor that is gone (its windows moved away).
                if (tree.monitor < count)
                    yield [this._savedKey(tree), tree];
            }
        }
    }

    // Geometry.

    _gaps() {
        return {
            inner: this._settings.get_uint('gap-inner'),
            outer: this._settings.get_uint('gap-outer'),
        };
    }

    _workArea(tree) {
        const workspace = tree.workspace === ALL_WORKSPACES
            ? global.workspace_manager.get_active_workspace() : tree.workspace;
        return workspace.get_work_area_for_monitor(tree.monitor);
    }

    _layout(tree) {
        // Half the work area at most: a minimum learned on a bigger monitor
        // must not crowd out the rest here.
        const area = this._workArea(tree);
        const minSize = id => {
            const min = id instanceof Placeholder ? null : minSizes.get(id.get_stable_sequence());
            return min && {
                width: Math.min(min.width, Math.floor(area.width / 2)),
                height: Math.min(min.height, Math.floor(area.height / 2)),
            };
        };
        return tree.layout(area, this._gaps(), this._isHidden, minSize);
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
        for (const monitors of this._trees.values()) {
            for (const tree of monitors.values()) {
                if (!tree.isEmpty)
                    moves.push(...this._pendingMoves(this._layout(tree)));
            }
        }

        const focused = global.display.focus_window;
        const focusedRect = moves.find(([window]) => window === focused)?.[1];
        const workspace = global.workspace_manager.get_active_workspace();
        // Geometry of the windows the focused one would cover, taken before
        // they move (a pure move can apply at once). Only windows on this
        // workspace: one on another is not drawn and would only hold the
        // focused window back until the timeout.
        const covered = new Map();
        for (const [window] of moves) {
            const frame = window.get_frame_rect();
            if (focusedRect && window !== focused &&
                window.located_on_workspace(workspace) && containsRect(focusedRect, frame))
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
            // The slot the window should have now, also when it seems to have
            // it already (see _onFrameChanged).
            this._requested.set(window, rect);
            // Also when it is in place already: after a re-enable or a
            // maximize a late frame of this size must be known as old.
            this._remember(window, rect);
            if (!sameRect(window.get_frame_rect(), rect))
                moves.push([window, rect]);
        }
        return moves;
    }

    // Keeps the last sizes asked of the window, newest last.
    _remember(window, rect) {
        const size = `${rect.width}x${rect.height}`;
        const asked = (this._askedSizes.get(window) ?? []).filter(s => s !== size);
        asked.push(size);
        this._askedSizes.set(window, asked.slice(-4));
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
        const tree = this._windows.get(window);
        const finish = () => {
            this._cancelSettle();
            if (this._windows.get(window) === tree)
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

    // A tiled window is put inside the monitor's work area; it then enters
    // that monitor and _place() tiles it there. move_to_monitor() leaves a
    // window that is taller than the new work area where it was, but it keeps
    // floating, maximized and fullscreen windows as they are.
    _moveToMonitor(window, monitor) {
        if (!this._windows.get(window) || window.get_maximized() || window.fullscreen) {
            window.move_to_monitor(monitor);
            return;
        }
        // A held-back move to the old slot would pull the window back.
        this._cancelSettle();
        const area = window.get_work_area_for_monitor(monitor);
        const frame = window.get_frame_rect();
        const width = Math.min(frame.width, area.width);
        const height = Math.min(frame.height, area.height);
        window.move_resize_frame(false,
            area.x + Math.round((area.width - width) / 2),
            area.y + Math.round((area.height - height) / 2),
            width, height);
    }

    _centerFloating(window) {
        const area = window.get_work_area_current_monitor();
        const width = Math.round(area.width * FLOATING_WIDTH);
        const height = Math.round(area.height * FLOATING_HEIGHT);
        window.move_resize_frame(false,
            area.x + Math.round((area.width - width) / 2),
            area.y + Math.round((area.height - height) / 2),
            width, height);
    }
}
