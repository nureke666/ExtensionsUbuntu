import os
import sys
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, GLib, Gtk

# A plain resizable test window titled after argv[1]; its app id is
# 'test-<title>' (or $APP_ID), so windows tell apart like different apps.
GLib.set_prgname(os.environ.get('APP_ID') or f'test-{sys.argv[1]}')
window = Gtk.Window(title=sys.argv[1])
window.set_default_size(500, 350)
# 'fixed' makes a non-resizable window, which must stay floating; 'max' opens
# maximized, like a browser that remembers it; 'wide' cannot be narrower than
# 700 px (like Chrome's 500 px); 'small' cannot be bigger than 600x400, so it
# never fills its slot (like a terminal sized in whole cells).
mode = sys.argv[2] if len(sys.argv) > 2 else ''
if mode == 'fixed':
    window.set_resizable(False)
elif mode == 'max':
    window.maximize()
elif mode == 'wide':
    window.set_size_request(700, -1)
elif mode == 'small':
    hints = Gdk.Geometry()
    hints.max_width, hints.max_height = 600, 400
    window.set_geometry_hints(None, hints, Gdk.WindowHints.MAX_SIZE)
label = Gtk.Label(label=sys.argv[1])
window.add(label)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
