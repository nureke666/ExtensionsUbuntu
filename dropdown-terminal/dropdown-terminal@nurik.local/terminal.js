// The drop-down terminal itself: a borderless VTE window. The extension starts
// it as a Wayland client of its own, places, shows and hides its window.
// Run as `gjs -m terminal.js`; settings come from the extension's schema.

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Pango from 'gi://Pango';
import Vte from 'gi://Vte?version=2.91';

const dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const schemas = Gio.SettingsSchemaSource.new_from_directory(`${dir}/schemas`,
    Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
    settings_schema: schemas.lookup('org.gnome.shell.extensions.dropdown-terminal', false),
});
const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

// Catppuccin Mocha.
const FOREGROUND = '#cdd6f4';
const BACKGROUND = '#1e1e2e';
const PALETTE = [
    '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
    '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8',
];

function rgba(spec, alpha = 1) {
    const color = new Gdk.RGBA();
    color.parse(spec);
    color.alpha = alpha;
    return color;
}

// tmux runs on a server of its own (-L dropdown) with our config, so the
// user's other tmux sessions and ~/.tmux.conf stay untouched.
function command() {
    if (settings.get_string('session') === 'tmux' && GLib.find_program_in_path('tmux'))
        return ['tmux', '-L', 'dropdown', '-f', `${dir}/tmux.conf`, 'new-session', '-A', '-s', 'dropdown'];
    return [Vte.get_user_shell() || GLib.getenv('SHELL') || '/bin/bash'];
}

// Not unique on the bus: the extension knows its window by its own Wayland
// client, and the gnome-terminal of older versions used this id too.
const app = new Gtk.Application({
    application_id: 'org.nurik.DropdownTerminal',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    if (app.get_windows().length) {
        app.get_windows()[0].present();
        return;
    }
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Dropdown Terminal',
        decorated: false,
        default_width: 1000,
        default_height: 450,
    });
    // A translucent background needs a visual with alpha.
    const visual = window.get_screen().get_rgba_visual();
    if (visual)
        window.set_visual(visual);
    window.set_app_paintable(true);

    const terminal = new Vte.Terminal({
        scrollback_lines: 10000,
        audible_bell: false,
        cursor_blink_mode: Vte.CursorBlinkMode.OFF,
    });
    const applyLook = () => {
        terminal.set_colors(rgba(FOREGROUND), rgba(BACKGROUND, settings.get_uint('opacity') / 100),
            PALETTE.map(spec => rgba(spec)));
        terminal.set_font(Pango.FontDescription.from_string(desktop.get_string('monospace-font-name')));
    };
    applyLook();
    settings.connect('changed::opacity', applyLook);
    desktop.connect('changed::monospace-font-name', applyLook);

    const css = new Gtk.CssProvider();
    css.load_from_data(new TextEncoder().encode('vte-terminal { padding: 6px 10px; }'));
    terminal.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    // Ctrl+Shift+C/V copy and paste, Ctrl+plus/minus/0 zoom.
    terminal.connect('key-press-event', (_widget, event) => {
        const [, state] = event.get_state();
        const [, keyval] = event.get_keyval();
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        const ctrl = Gdk.ModifierType.CONTROL_MASK, shift = Gdk.ModifierType.SHIFT_MASK;
        const key = Gdk.keyval_to_lower(keyval);
        if (mods === (ctrl | shift) && key === Gdk.KEY_c) {
            terminal.copy_clipboard_format(Vte.Format.TEXT);
            return true;
        }
        if (mods === (ctrl | shift) && key === Gdk.KEY_v) {
            terminal.paste_clipboard();
            return true;
        }
        if ((mods & ctrl) && [Gdk.KEY_plus, Gdk.KEY_equal, Gdk.KEY_KP_Add].includes(key)) {
            terminal.font_scale = Math.min(3, terminal.font_scale * 1.1);
            return true;
        }
        if (mods === ctrl && [Gdk.KEY_minus, Gdk.KEY_KP_Subtract].includes(key)) {
            terminal.font_scale = Math.max(0.5, terminal.font_scale / 1.1);
            return true;
        }
        if (mods === ctrl && [Gdk.KEY_0, Gdk.KEY_KP_0].includes(key)) {
            terminal.font_scale = 1;
            return true;
        }
        return false;
    });

    terminal.connect('child-exited', () => app.quit());
    terminal.spawn_async(Vte.PtyFlags.DEFAULT, GLib.get_home_dir(), command(), null,
        GLib.SpawnFlags.SEARCH_PATH, null, -1, null, (_terminal, _pid, error) => {
            if (error) {
                printerr(`Dropdown Terminal: ${error.message}`);
                app.quit();
            }
        });

    window.add(terminal);
    window.show_all();
    terminal.grab_focus();
});
app.run([]);
