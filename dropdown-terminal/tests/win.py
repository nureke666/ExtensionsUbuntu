#!/usr/bin/env python3
# A plain GTK3 window titled 'other' for the tests to move the focus to.
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

window = Gtk.Window(title='other')
window.set_default_size(600, 400)
window.add(Gtk.Label(label='other'))
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
