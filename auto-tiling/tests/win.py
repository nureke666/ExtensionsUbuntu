import sys
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

# A plain resizable test window titled after argv[1].
window = Gtk.Window(title=sys.argv[1])
window.set_default_size(500, 350)
# 'fixed' makes a non-resizable window, which must stay floating.
if len(sys.argv) > 2 and sys.argv[2] == 'fixed':
    window.set_resizable(False)
label = Gtk.Label(label=sys.argv[1])
window.add(label)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
