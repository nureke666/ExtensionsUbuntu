import os
import sys
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import GLib, Gtk

# A plain resizable test window titled after argv[1]; its app id is
# 'test-<title>' (or $APP_ID), so windows tell apart like different apps.
GLib.set_prgname(os.environ.get('APP_ID') or f'test-{sys.argv[1]}')
window = Gtk.Window(title=sys.argv[1])
window.set_default_size(500, 350)
# 'fixed' makes a non-resizable window, which must stay floating; 'max' opens
# maximized, like a browser that remembers it.
mode = sys.argv[2] if len(sys.argv) > 2 else ''
if mode == 'fixed':
    window.set_resizable(False)
elif mode == 'max':
    window.maximize()
label = Gtk.Label(label=sys.argv[1])
window.add(label)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
