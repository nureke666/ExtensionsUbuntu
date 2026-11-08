// Settings window: what runs inside, size, look and the key.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SESSIONS = [
    ['tmux', 'tmux', 'Сессия остаётся: закрыл окно (Alt+F4) — при следующем Super+Enter всё на месте; ' +
        'exit закрывает и сессию. Колёсико листает вывод; копировать в буфер — выделяй с Shift.'],
    ['plain', 'Оболочка', 'Как в любом терминале: закрыл окно — всё внутри закрылось.'],
];

export default class DropdownTerminalPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // The window keeps the settings alive for the bindings.
        window._settings = settings;
        window.set_default_size(600, 660);
        const page = new Adw.PreferencesPage({title: 'Выпадающий терминал', icon_name: 'utilities-terminal-symbolic'});
        page.add(sessionGroup(settings));
        page.add(windowGroup(settings));
        page.add(keyGroup(settings, window));
        window.add(page);
    }
}

function sessionGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Что внутри',
        description: 'Работает со следующего запуска терминала.',
    });
    const row = new Adw.ComboRow({
        title: 'Сессия',
        model: Gtk.StringList.new(SESSIONS.map(([, title]) => title)),
        use_subtitle: false,
    });
    const sync = () => {
        const index = SESSIONS.findIndex(([value]) => value === settings.get_string('session'));
        if (row.selected !== index)
            row.selected = Math.max(index, 0);
        row.subtitle = SESSIONS[row.selected][2];
    };
    sync();
    settings.connect('changed::session', sync);
    row.connect('notify::selected', () => {
        settings.set_string('session', SESSIONS[row.selected][0]);
        row.subtitle = SESSIONS[row.selected][2];
    });
    group.add(row);
    return group;
}

function spinRow(settings, key, title, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 5);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function windowGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'Окно'});
    group.add(spinRow(settings, 'width', 'Ширина, % экрана', 20, 100));
    group.add(spinRow(settings, 'height', 'Высота, % экрана', 15, 100));
    group.add(spinRow(settings, 'opacity', 'Непрозрачность фона, %', 50, 100));
    const hide = new Adw.SwitchRow({
        title: 'Прятать, когда фокус уходит',
        subtitle: 'Кликнул в другое окно — терминал уезжает наверх',
    });
    settings.bind('hide-on-unfocus', hide, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(hide);
    return group;
}

function keyGroup(settings, window) {
    const group = new Adw.PreferencesGroup({title: 'Клавиша'});
    const row = new Adw.ActionRow({title: 'Показать или спрятать', activatable: true});
    const label = new Gtk.ShortcutLabel({disabled_text: 'Выключено', valign: Gtk.Align.CENTER});
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Вернуть Super+Enter',
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset('toggle'));
    row.add_suffix(label);
    row.add_suffix(reset);
    const update = () => {
        label.accelerator = settings.get_strv('toggle')[0] ?? '';
        reset.visible = settings.get_user_value('toggle') !== null;
    };
    update();
    settings.connect('changed::toggle', update);
    row.connect('activated', () => captureShortcut(window, accel => settings.set_strv('toggle', accel)));
    group.add(row);
    return group;
}

// Asks for a new shortcut: Esc cancels, Backspace turns it off.
function captureShortcut(parent, done) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parent,
        default_width: 420,
        default_height: 240,
        resizable: false,
        content: new Adw.StatusPage({
            title: 'Новое сочетание',
            description: 'Нажми его.\nEsc — отмена, Backspace — выключить.',
            icon_name: 'input-keyboard-symbolic',
        }),
    });
    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask();
        if (!mask && keyval === Gdk.KEY_Escape) {
            dialog.close();
            return true;
        }
        if (!mask && keyval === Gdk.KEY_BackSpace) {
            done([]);
            dialog.close();
            return true;
        }
        const base = latinKeyval(dialog.get_display(), keycode, keyval);
        const isFunctionKey = base >= Gdk.KEY_F1 && base <= Gdk.KEY_F35;
        // A key with no modifier or Shift only would be taken from every app.
        const weak = mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK;
        if (!Gtk.accelerator_valid(base, mask) || (weak && !isFunctionKey))
            return true;
        done([Gtk.accelerator_name(base, mask)]);
        dialog.close();
        return true;
    });
    dialog.add_controller(controller);
    // Lets the dialog see keys GNOME Shell would otherwise take.
    dialog.connect('map', () => dialog.get_surface()?.inhibit_system_shortcuts?.(null));
    dialog.present();
}

// The key's symbol on a Latin layout and without Shift applied.
function latinKeyval(display, keycode, keyval) {
    const [ok, keys, keyvals] = display.map_keycode(keycode);
    if (ok) {
        for (let i = 0; i < keys.length; i++) {
            if (keys[i].level === 0 && keyvals[i] > 0x20 && keyvals[i] < 0x100)
                return Gdk.keyval_to_lower(keyvals[i]);
        }
    }
    return Gdk.keyval_to_lower(keyval);
}
