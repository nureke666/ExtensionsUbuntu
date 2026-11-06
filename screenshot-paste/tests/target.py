#!/usr/bin/env python3
# Test window: a text field that prints what Screenshot Paste does to it.
# "paste WxH" when Ctrl+V brings an image, "enter" on Enter.
import sys

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, Gtk


def say(*args):
    print(*args, flush=True)


def on_image(_clipboard, pixbuf):
    say(f'paste {pixbuf.get_width()}x{pixbuf.get_height()}' if pixbuf else 'paste no-image')


def on_paste(_view):
    Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).request_image(on_image)


def on_key(_widget, event):
    name = Gdk.keyval_name(event.keyval)
    say(f'key {name} code={event.hardware_keycode} state={int(event.state)}')
    if name in ('Return', 'KP_Enter'):
        say('enter')
    return False


win = Gtk.Window(title='paste target')
win.set_default_size(400, 200)
view = Gtk.TextView()
view.connect('paste-clipboard', on_paste)
win.connect('key-press-event', on_key)
win.connect('map-event', lambda *_: say('ready'))
win.connect('destroy', Gtk.main_quit)
win.add(view)
win.show_all()
view.grab_focus()
Gtk.main()
sys.exit(0)
