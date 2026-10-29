// Notification Island: shows notifications as a pill centered over the top
// panel instead of the stock banner. Critical notifications keep the stock
// banner, since only it can expand and show actions.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const SHOW_TIME_MS = 5000;
// Time left once the pointer leaves the island after hovering it.
const HOVER_LEAVE_TIME_MS = 2000;
const SHOW_ANIMATION_MS = 300;
const HIDE_ANIMATION_MS = 200;
// Collapsed scale the island grows from and shrinks back to.
const COLLAPSED_SCALE_X = 0.4;
const COLLAPSED_SCALE_Y = 0.7;
// Gap between the island and the top/bottom edges of the panel.
const PANEL_INSET = 3;
// Used when no panel reserves space at the top of the primary monitor.
const MIN_PANEL_HEIGHT = 20;
const FALLBACK_TOP = 6;
const FALLBACK_HEIGHT = 30;

// The notification daemon marks every body as markup; the island shows plain
// text on a single line.
function toPlainText(text, isMarkup) {
    if (!text)
        return '';

    let plain = text;
    if (isMarkup) {
        try {
            [, , plain] = Pango.parse_markup(text, -1, '');
        } catch {
            plain = text.replace(/<[^>]*>/g, '');
        }
    }
    return plain.replace(/\s*\n\s*/g, ' ').trim();
}

class Island {
    constructor() {
        this._notification = null;
        this._timeoutId = 0;

        this._icon = new St.Icon({
            style_class: 'notification-island-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({
            style_class: 'notification-island-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._body = new St.Label({
            style_class: 'notification-island-body',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        for (const label of [this._title, this._body])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const box = new St.BoxLayout({style_class: 'notification-island-box'});
        box.add_child(this._icon);
        box.add_child(this._title);
        box.add_child(this._body);

        this.pill = new St.Button({
            style_class: 'notification-island',
            child: box,
            can_focus: false,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            visible: false,
        });
        this.pill.set_pivot_point(0.5, 0.5);
        this.pill.connect('clicked', () => this._activate());
        this.pill.connect('notify::hover', () => this._onHoverChanged());

        // Spans the panel so the pill stays centered whatever its width; not
        // reactive, so clicks elsewhere on the panel pass through to it.
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });
        this.actor.add_child(this.pill);
    }

    show(notification) {
        if (this._notification !== notification) {
            this._releaseCurrent();
            this._notification = notification;
            notification.connectObject('destroy', () => {
                if (this._notification !== notification)
                    return;
                notification.disconnectObject(this);
                this._notification = null;
                this._hide();
            }, this);
        }

        // What the stock banner does when it shows a notification.
        notification.acknowledged = true;
        notification.playSound();

        this._sync();
        this._place();
        this._animateIn();
        this._restartTimeout(SHOW_TIME_MS);
    }

    destroy() {
        this._clearTimeout();
        // The notification stays in the notification list; only stop showing it.
        this._notification?.disconnectObject(this);
        this._notification = null;
        this.actor.destroy();
    }

    _sync() {
        const notification = this._notification;
        const gicon = notification.gicon ?? notification.source?.icon ?? null;
        this._icon.gicon = gicon;
        this._icon.visible = !!gicon;

        this._title.text = toPlainText(notification.title, false);

        const body = toPlainText(notification.body, notification.useBodyMarkup);
        this._body.text = body;
        this._body.visible = !!body;
    }

    _place() {
        const layout = Main.layoutManager;
        const monitor = layout.primaryMonitor;
        if (!monitor)
            return;

        // The work area starts below a top panel, so the gap is its height.
        // This also covers panels that replace the stock one (dash-to-panel).
        const workArea = layout.getWorkAreaForMonitor(layout.primaryIndex);
        const panelHeight = workArea.y - monitor.y;
        let y, height;
        if (panelHeight >= MIN_PANEL_HEIGHT) {
            y = monitor.y + PANEL_INSET;
            height = panelHeight - 2 * PANEL_INSET;
        } else {
            y = monitor.y + FALLBACK_TOP;
            height = FALLBACK_HEIGHT;
        }
        this.actor.set_position(monitor.x, y);
        this.actor.set_size(monitor.width, height);

        // Stay above panels that were (re)built after the extension started.
        layout.uiGroup.set_child_above_sibling(this.actor, null);
    }

    _animateIn() {
        const pill = this.pill;
        pill.remove_all_transitions();
        if (!pill.visible) {
            pill.opacity = 0;
            pill.scale_x = COLLAPSED_SCALE_X;
            pill.scale_y = COLLAPSED_SCALE_Y;
            pill.show();
        }
        pill.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: SHOW_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _hide() {
        this._clearTimeout();
        const pill = this.pill;
        pill.remove_all_transitions();
        if (!pill.visible) {
            this._finish();
            return;
        }
        pill.ease({
            opacity: 0,
            scale_x: COLLAPSED_SCALE_X,
            scale_y: COLLAPSED_SCALE_Y,
            duration: HIDE_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                pill.hide();
                this._finish();
            },
        });
    }

    _finish() {
        this._releaseCurrent();
        // Show whatever queued up meanwhile (e.g. while a window was fullscreen).
        Main.messageTray._updateState();
    }

    // Stop showing the current notification; transient ones expire, as they
    // do when the stock banner hides them.
    _releaseCurrent() {
        const notification = this._notification;
        if (!notification)
            return;

        this._notification = null;
        notification.disconnectObject(this);
        if (notification.isTransient)
            notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
    }

    _activate() {
        const notification = this._notification;
        if (!notification)
            return;

        notification.disconnectObject(this);
        this._notification = null;
        this._hide();
        notification.activate();
    }

    _onHoverChanged() {
        if (!this._notification)
            return;

        if (this.pill.hover)
            this._clearTimeout();
        else
            this._restartTimeout(HOVER_LEAVE_TIME_MS);
    }

    _restartTimeout(ms) {
        this._clearTimeout();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeoutId = 0;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}

export default class NotificationIslandExtension extends Extension {
    enable() {
        const island = new Island();
        this._island = island;
        Main.layoutManager.addTopChrome(island.actor, {
            affectsInputRegion: false,
            trackFullscreen: true,
        });
        // Only the visible pill takes input. trackFullscreen must stay off here,
        // or the layout manager would force the hidden pill visible.
        Main.layoutManager.trackChrome(island.pill, {
            affectsInputRegion: true,
            trackFullscreen: false,
        });

        // The tray still decides when a notification may be shown (do not
        // disturb, per-app banner setting, fullscreen); the island replaces
        // only the banner itself. _showNotification is looked up on every call,
        // so overriding it on the prototype also covers existing sources.
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(
            MessageTray.MessageTray.prototype,
            '_showNotification',
            original => function (...args) {
                const next = this._notificationQueue[0];
                if (!next || next.urgency === MessageTray.Urgency.CRITICAL) {
                    original.apply(this, args);
                    return;
                }
                this._notificationQueue.shift();
                this.emit('queue-changed');
                island.show(next);
            });
    }

    disable() {
        this._injectionManager.clear();
        this._injectionManager = null;
        this._island.destroy();
        this._island = null;
    }
}
