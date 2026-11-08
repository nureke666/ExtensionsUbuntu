// Settings window: gaps, border, layout memory, floating apps and keys.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const KEY_GROUPS = [
    ['Фокус', [
        ['focus-left', 'Окно слева'],
        ['focus-right', 'Окно справа'],
        ['focus-up', 'Окно сверху'],
        ['focus-down', 'Окно снизу'],
    ]],
    ['Поменять местами или перенести на другой монитор', [
        ['swap-left', 'Влево'],
        ['swap-right', 'Вправо'],
        ['swap-up', 'Вверх'],
        ['swap-down', 'Вниз'],
    ]],
    ['Сдвинуть границу окна', [
        ['resize-left', 'Влево'],
        ['resize-right', 'Вправо'],
        ['resize-up', 'Вверх'],
        ['resize-down', 'Вниз'],
    ]],
    ['Раскладка', [
        ['toggle-split', 'Сменить направление деления'],
        ['toggle-floating', 'Сделать окно плавающим или вернуть'],
        ['equalize', 'Выровнять размеры'],
        ['toggle-tiling', 'Выключить или включить тайлинг на столе'],
    ]],
];

export default class AutoTilingPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // The window keeps the settings alive for the bindings.
        window._settings = settings;
        window.set_default_size(640, 760);
        window.add(windowsPage(settings));
        window.add(appsPage(settings, window));
        window.add(keysPage(settings, window));
    }
}

function spinRow(settings, key, title, max) {
    const row = Adw.SpinRow.new_with_range(0, max, 1);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function windowsPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Окна', icon_name: 'view-grid-symbolic'});

    const gaps = new Adw.PreferencesGroup({title: 'Отступы'});
    gaps.add(spinRow(settings, 'gap-inner', 'Между окнами, px', 100));
    gaps.add(spinRow(settings, 'gap-outer', 'От краёв экрана, px', 100));
    page.add(gaps);

    const border = new Adw.PreferencesGroup({title: 'Рамка вокруг окна в фокусе'});
    const enabled = new Adw.SwitchRow({title: 'Показывать рамку'});
    settings.bind('border-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    border.add(enabled);
    const width = spinRow(settings, 'border-width', 'Толщина, px', 20);
    width.adjustment.lower = 1;
    const radius = spinRow(settings, 'border-radius', 'Скругление углов окна, px', 40);
    const color = new Adw.ActionRow({title: 'Цвет'});
    color.add_suffix(colorButton(settings, 'border-color'));
    for (const row of [width, color, radius]) {
        settings.bind('border-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
        border.add(row);
    }
    page.add(border);

    const layout = new Adw.PreferencesGroup({title: 'Раскладка'});
    const remember = new Adw.SwitchRow({
        title: 'Помнить раскладку между входами',
        subtitle: 'Приложение, открытое на том же столе и мониторе, встаёт на прежнее место',
    });
    settings.bind('remember-layout', remember, 'active', Gio.SettingsBindFlags.DEFAULT);
    layout.add(remember);
    page.add(layout);
    return page;
}

function colorButton(settings, key) {
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const load = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)) && !rgba.equal(button.rgba))
            button.rgba = rgba;
    };
    load();
    settings.connect(`changed::${key}`, load);
    button.connect('notify::rgba', () => {
        const value = button.rgba.to_string();
        const current = new Gdk.RGBA();
        if (!current.parse(settings.get_string(key)) || !current.equal(button.rgba))
            settings.set_string(key, value);
    });
    return button;
}

function appsPage(settings, window) {
    const page = new Adw.PreferencesPage({title: 'Плавающие', icon_name: 'focus-windows-symbolic'});
    const group = new Adw.PreferencesGroup({
        title: 'Плавающие приложения',
        description: 'Окна этих приложений не встают в раскладку, а открываются поверх ' +
            'остальных, как без тайлинга. Диалоги, окна «поверх всех» и окна, которые ' +
            'нельзя растянуть, плавают и без этого списка.',
    });
    page.add(group);

    const add = id => {
        id = id.trim().replace(/\.desktop$/, '');
        const list = settings.get_strv('floating-apps');
        if (id && !list.includes(id))
            settings.set_strv('floating-apps', [...list, id]);
    };

    const pick = new Adw.ActionRow({title: 'Добавить приложение…', activatable: true});
    pick.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
    pick.connect('activated', () => pickApp(window, app => add(app.get_id())));
    group.add(pick);

    let rows = [];
    const fill = () => {
        rows.forEach(row => group.remove(row));
        const ids = settings.get_strv('floating-apps');
        rows = ids.map(id => {
            const info = Gio.DesktopAppInfo.new(`${id}.desktop`);
            // App names are plain text ("Software & Updates"), not markup.
            const row = new Adw.ActionRow({
                title: info?.get_display_name() ?? id,
                subtitle: info ? '' : 'сравнивается с WM_CLASS и id приложения',
                use_markup: false,
            });
            row.add_prefix(info?.get_icon()
                ? new Gtk.Image({gicon: info.get_icon(), pixel_size: 32})
                : new Gtk.Image({icon_name: 'application-x-executable-symbolic', pixel_size: 32}));
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Убрать из списка',
                css_classes: ['flat'],
            });
            remove.connect('clicked', () =>
                settings.set_strv('floating-apps', settings.get_strv('floating-apps').filter(x => x !== id)));
            row.add_suffix(remove);
            group.add(row);
            return row;
        });
        if (!ids.length) {
            const empty = new Adw.ActionRow({title: 'Список пуст: все приложения тайлятся'});
            empty.add_css_class('dim-label');
            group.add(empty);
            rows.push(empty);
        }
    };
    fill();
    settings.connect('changed::floating-apps', fill);

    const advanced = new Adw.PreferencesGroup({
        title: 'Своё приложение по id',
        description: 'Если приложения нет в списке установленных: его WM_CLASS или id. ' +
            'Их видно в Looking Glass (Alt+F2, lg, вкладка Windows).',
    });
    const entry = new Adw.EntryRow({title: 'id или WM_CLASS', show_apply_button: true});
    entry.connect('apply', () => {
        add(entry.text);
        entry.text = '';
    });
    advanced.add(entry);
    page.add(advanced);
    return page;
}

// A searchable list of installed apps; `done(appInfo)` gets the chosen one.
function pickApp(parent, done) {
    const apps = Gio.AppInfo.get_all()
        .filter(app => app.should_show() && app.get_id())
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
    const search = new Gtk.SearchEntry({placeholder_text: 'Найти приложение', margin_bottom: 6});
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    for (const app of apps) {
        const row = new Adw.ActionRow({title: app.get_display_name(), activatable: true, use_markup: false});
        row.add_prefix(new Gtk.Image({gicon: app.get_icon() ?? null, pixel_size: 32}));
        row._app = app;
        list.append(row);
    }
    list.set_filter_func(row => row._app.get_display_name().toLowerCase()
        .includes(search.text.trim().toLowerCase()));
    search.connect('search-changed', () => list.invalidate_filter());

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, margin_top: 12,
        margin_bottom: 12, margin_start: 12, margin_end: 12});
    box.append(search);
    box.append(new Gtk.ScrolledWindow({child: list, vexpand: true}));
    const view = new Adw.ToolbarView({content: box});
    view.add_top_bar(new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: 'Добавить приложение'})}));
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parent,
        default_width: 420,
        default_height: 560,
        content: view,
    });
    list.connect('row-activated', (_list, row) => {
        done(row._app);
        dialog.close();
    });
    dialog.present();
    search.grab_focus();
}

function keysPage(settings, window) {
    const page = new Adw.PreferencesPage({title: 'Клавиши', icon_name: 'input-keyboard-symbolic'});
    for (const [title, keys] of KEY_GROUPS) {
        const group = new Adw.PreferencesGroup({title});
        for (const [key, name] of keys)
            group.add(shortcutRow(settings, key, name, window));
        page.add(group);
    }
    const note = new Adw.PreferencesGroup({
        description: 'Новые клавиши работают сразу. Если сочетание занято в GNOME, расширение ' +
            'забирает его, пока включено. При первой смене GNOME спросит, можно ли этому окну ' +
            'перехватывать сочетания: разреши, иначе Super+стрелки до него не дойдут.',
    });
    page.add(note);
    return page;
}

function shortcutRow(settings, key, title, window) {
    const row = new Adw.ActionRow({title, activatable: true});
    const label = new Gtk.ShortcutLabel({disabled_text: 'Выключено', valign: Gtk.Align.CENTER});
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Вернуть по умолчанию',
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(label);
    row.add_suffix(reset);

    const update = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
        reset.visible = settings.get_user_value(key) !== null;
    };
    update();
    settings.connect(`changed::${key}`, update);
    row.connect('activated', () => captureShortcut(window, title, accel => settings.set_strv(key, accel)));
    return row;
}

// Asks for a new shortcut: Esc cancels, Backspace turns the action off.
function captureShortcut(parent, title, done) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parent,
        default_width: 440,
        default_height: 260,
        resizable: false,
        content: new Adw.StatusPage({
            title,
            description: 'Нажми новое сочетание.\nEsc — отмена, Backspace — выключить.',
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
    // Lets the dialog see keys GNOME Shell would otherwise take (Super+arrows).
    dialog.connect('map', () => dialog.get_surface()?.inhibit_system_shortcuts?.(null));
    dialog.present();
}

// The key's symbol on a Latin layout (with ru+us, Super+К is saved as
// Super+r) and without Shift applied, as GNOME expects it.
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
