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
# never fills its slot; 'cells' is sized in steps of 10x20 px, like a
# terminal in whole cells; 'tabs' is 'cells' that, like gnome-terminal,
# grows by a 40 px tab bar on Ctrl+Shift+T and shrinks back on Ctrl+Shift+W.
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
if mode in ('cells', 'tabs'):
    hints = Gdk.Geometry()
    hints.base_width, hints.base_height = 0, 0
    hints.width_inc, hints.height_inc = 10, 20
    window.set_geometry_hints(None, hints, Gdk.WindowHints.BASE_SIZE | Gdk.WindowHints.RESIZE_INC)
label = Gtk.Label(label=sys.argv[1])
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
bar = Gtk.Label(label='tabs')
bar.set_size_request(-1, 40)
bar.set_no_show_all(True)
box.pack_start(bar, False, False, 0)
box.pack_start(label, True, True, 0)
window.add(box)


def on_key(_window, event):
    ctrl_shift = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK
    if mode != 'tabs' or event.state & ctrl_shift != ctrl_shift:
        return False
    key = Gdk.keyval_to_lower(event.keyval)
    if key not in (Gdk.KEY_t, Gdk.KEY_w) or bar.get_visible() == (key == Gdk.KEY_t):
        return False
    # Keeps the cells it has, the window grows or shrinks by the bar.
    width, height = window.get_size()
    bar.set_visible(key == Gdk.KEY_t)
    window.resize(width, height + (40 if key == Gdk.KEY_t else -40))
    return True


window.connect('key-press-event', on_key)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
