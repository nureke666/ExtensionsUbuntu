// The drop-down terminal itself: a borderless VTE window. The extension starts
// it as a Wayland client of its own, places, shows and hides its window.
// Run as `gjs -m terminal.js`; settings come from the extension's schema.

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Pango from 'gi://Pango';
import Vte from 'gi://Vte?version=2.91';

import {defaultFontName, watchDefaultFont} from './fonts.js';

const dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const schemas = Gio.SettingsSchemaSource.new_from_directory(`${dir}/schemas`,
    Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
    settings_schema: schemas.lookup('org.gnome.shell.extensions.dropdown-terminal', false),
});
function fontName() {
    return settings.get_string('font') || defaultFontName();
}

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

const COPY_IFACE = `<node><interface name="org.nurik.DropdownTerminal.Clipboard">
    <method name="Copy"><arg type="s" direction="in"/></method>
</interface></node>`;

// Kept here: once GJS collects it, the object is gone from the bus.
let copyService = null;

// What is selected in tmux reaches the clipboard through copy.js and this
// D-Bus method: the terminal has the focus, so it may set the clipboard.
function serveCopy(terminal) {
    copyService = Gio.DBusExportedObject.wrapJSObject(COPY_IFACE, {
        Copy(text) {
            Gtk.Clipboard.get_default(terminal.get_display()).set_text(text, -1);
        },
    });
    copyService.export(Gio.DBus.session, '/org/nurik/DropdownTerminal/Clipboard');
    // A newer terminal takes the name over from one still on its way out.
    Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.nurik.DropdownTerminal.Clipboard',
        Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE, null, null);
}

// Runs a tmux command on the terminal's tmux server.
function tmux(...args) {
    try {
        Gio.Subprocess.new(['tmux', '-L', 'dropdown', ...args],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        printerr(`Dropdown Terminal: ${e.message}`);
    }
}

// A mouse selection dragged onto tmux's status line or below it: VTE tells
// tmux the pointer is on the status line, and that stops tmux scrolling. tmux
// is told the last row of its pane instead, and VTE nothing.
function scrollDragPastBottom(terminal) {
    const TOP_PADDING = 6;
    const statusTop = () => TOP_PADDING + (terminal.get_row_count() - 1) * terminal.get_char_height();
    // Button 1 went down above the status line, without Shift (with Shift the
    // selection is VTE's own).
    let dragging = false;
    let last = '';
    terminal.connect('button-press-event', (_widget, event) => {
        const [, button] = event.get_button();
        const [, state] = event.get_state();
        const [, , y] = event.get_coords();
        dragging = button === 1 && !(state & Gdk.ModifierType.SHIFT_MASK) && y < statusTop();
        last = '';
        return false;
    });
    terminal.connect('motion-notify-event', (_widget, event) => {
        const [, state] = event.get_state();
        const [, x, y] = event.get_coords();
        if (!dragging || !(state & Gdk.ModifierType.BUTTON1_MASK) || y < statusTop()) {
            last = '';
            return false;
        }
        const rows = terminal.get_row_count(), cols = terminal.get_column_count();
        const col = Math.min(cols, Math.max(1, Math.floor(x / terminal.get_char_width()) + 1));
        // A drag with button 1 in SGR mouse mode, which tmux asks for.
        const report = `\x1b[<32;${col};${rows - 1}M`;
        if (report !== last) {
            last = report;
            terminal.feed_child(new TextEncoder().encode(report));
        }
        return true;
    });
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
        terminal.set_font(Pango.FontDescription.from_string(fontName()));
    };
    applyLook();
    settings.connect('changed::opacity', applyLook);
    settings.connect('changed::font', applyLook);
    watchDefaultFont(applyLook);

    const argv = command();
    const inTmux = argv[0] === 'tmux';

    const css = new Gtk.CssProvider();
    css.load_from_data(new TextEncoder().encode('vte-terminal { padding: 6px 10px; }'));
    terminal.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    // Ctrl+Shift+C/V copy and paste, Ctrl+plus/minus/0 zoom, Shift+PgUp/PgDn
    // scroll.
    terminal.connect('key-press-event', (_widget, event) => {
        const [, state] = event.get_state();
        const [, keyval] = event.get_keyval();
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        const ctrl = Gdk.ModifierType.CONTROL_MASK, shift = Gdk.ModifierType.SHIFT_MASK;
        const key = Gdk.keyval_to_lower(keyval);
        if (mods === (ctrl | shift) && key === Gdk.KEY_c) {
            // A selection made with Shift is the terminal's own, any other is
            // tmux's. With nothing selected the clipboard stays as it is.
            if (terminal.get_has_selection())
                terminal.copy_clipboard_format(Vte.Format.TEXT);
            else if (inTmux)
                tmux('if-shell', '-F', '-t', 'dropdown:', '#{selection_present}',
                    'send-keys -t dropdown: -X copy-pipe-and-cancel ; display-message -d 1500 Скопировано');
            return true;
        }
        // VTE would scroll its own history, which is empty under tmux: tmux
        // gets the keys and scrolls its own.
        if (inTmux && mods === shift && [Gdk.KEY_Page_Up, Gdk.KEY_Page_Down].includes(keyval)) {
            terminal.feed_child(new TextEncoder().encode(keyval === Gdk.KEY_Page_Up ? '\x1b[5;2~' : '\x1b[6;2~'));
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

    serveCopy(terminal);
    if (inTmux)
        scrollDragPastBottom(terminal);
    terminal.connect('child-exited', () => app.quit());
    terminal.spawn_async(Vte.PtyFlags.DEFAULT, GLib.get_home_dir(), argv, null,
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
