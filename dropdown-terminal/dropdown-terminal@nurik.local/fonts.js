// The terminal's font when none is set: the font of the default gnome-terminal
// profile (so it looks like the user's gnome-terminal), unless that profile
// uses the system font; then the system monospace font. Used by terminal.js
// and prefs.js.

import Gio from 'gi://Gio';

const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

function terminalProfile() {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source.lookup('org.gnome.Terminal.ProfilesList', true))
        return null;
    const id = new Gio.Settings({schema_id: 'org.gnome.Terminal.ProfilesList'}).get_string('default');
    if (!id)
        return null;
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.Terminal.Legacy.Profile', true),
        path: `/org/gnome/terminal/legacy/profiles:/:${id}/`,
    });
}

const profile = terminalProfile();

export function defaultFontName() {
    if (profile && !profile.get_boolean('use-system-font') && profile.get_string('font'))
        return profile.get_string('font');
    return desktop.get_string('monospace-font-name');
}

// Calls `callback` when the default font may have changed.
export function watchDefaultFont(callback) {
    desktop.connect('changed::monospace-font-name', callback);
    profile?.connect('changed', callback);
}
