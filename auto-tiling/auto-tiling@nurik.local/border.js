// Draws a colored border around the focused window.

import Meta from 'gi://Meta';
import St from 'gi://St';

const BORDERED_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

export class FocusBorder {
    constructor(settings) {
        this._settings = settings;
        this._window = null;

        // Lives among the window actors so that it is stacked right above the
        // focused window and below anything covering it, and hides with them
        // in the overview.
        this._actor = new St.Widget({reactive: false, visible: false});
        global.window_group.add_child(this._actor);
        this._updateStyle();

        global.display.connectObject(
            'notify::focus-window', () => this._setWindow(global.display.focus_window),
            'restacked', () => this._update(),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._update(), this);
        settings.connectObject('changed', (_settings, key) => {
            if (!key.startsWith('border-'))
                return;
            this._updateStyle();
            this._update();
        }, this);

        this._setWindow(global.display.focus_window);
    }

    destroy() {
        this._setWindow(null);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._actor.destroy();
        this._actor = null;
    }

    _setWindow(window) {
        if (this._window !== window) {
            this._window?.disconnectObject(this);
            this._window = window;
            window?.connectObject(
                'position-changed', () => this._update(),
                'size-changed', () => this._update(),
                'workspace-changed', () => this._update(),
                'notify::minimized', () => this._update(),
                'notify::fullscreen', () => this._update(),
                'notify::maximized-horizontally', () => this._update(),
                'notify::maximized-vertically', () => this._update(),
                'unmanaged', () => this._setWindow(null),
                this);
        }
        this._update();
    }

    _updateStyle() {
        const width = this._settings.get_uint('border-width');
        const radius = this._settings.get_uint('border-radius');
        const color = this._settings.get_string('border-color');
        // The border sits outside the window, so its corners are rounder by
        // its width to stay concentric with the window's.
        this._actor.set_style(
            `border: ${width}px solid ${color}; border-radius: ${radius + width}px;`);
    }

    _update() {
        if (!this._actor)
            return;

        const window = this._window;
        const windowActor = window?.get_compositor_private();
        if (!this._settings.get_boolean('border-enabled') || !windowActor ||
            windowActor.get_parent() !== global.window_group || !this._shouldShow(window)) {
            this._actor.hide();
            return;
        }

        const width = this._settings.get_uint('border-width');
        const rect = window.get_frame_rect();
        this._actor.set_position(rect.x - width, rect.y - width);
        this._actor.set_size(rect.width + 2 * width, rect.height + 2 * width);
        global.window_group.set_child_above_sibling(this._actor, windowActor);
        this._actor.show();
    }

    _shouldShow(window) {
        return BORDERED_TYPES.includes(window.get_window_type()) &&
            !window.minimized && !window.fullscreen &&
            window.get_maximized() !== Meta.MaximizeFlags.BOTH &&
            window.located_on_workspace(global.workspace_manager.get_active_workspace());
    }
}
