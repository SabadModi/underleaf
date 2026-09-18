#!/usr/bin/env python3
"""x11-window.py <activate|minimize|maximize|close> <window-id>

Asks the window manager (EWMH/ICCCM client messages) to act on a window. Underleaf uses it for
its own window buttons (the system title bar is removed) and to hand focus back after
TeXpresso's preview window takes it. Plain ctypes against libX11, nothing to install."""
import ctypes
import sys

x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong),
                ('format', ctypes.c_int), ('data', ctypes.c_long * 5)]


class XEvent(ctypes.Union):
    _fields_ = [('xclient', XClientMessageEvent), ('pad', ctypes.c_long * 24)]


CLIENT_MESSAGE = 33
SUBSTRUCTURE_NOTIFY_AND_REDIRECT = (1 << 19) | (1 << 20)
SOURCE_PAGER = 2  # pagers/taskbars are exempt from focus-stealing prevention
ICONIC_STATE = 3
TOGGLE = 2

action, window = sys.argv[1], int(sys.argv[2], 16)
display = x11.XOpenDisplay(None)
if not display:
    sys.exit(1)
atom = lambda name: x11.XInternAtom(display, name.encode(), 0)


def send(message_type, data):
    event = XEvent()
    event.xclient.type = CLIENT_MESSAGE
    event.xclient.send_event = 1
    event.xclient.display = display
    event.xclient.window = window
    event.xclient.message_type = atom(message_type)
    event.xclient.format = 32
    for i, value in enumerate(data):
        event.xclient.data[i] = value
    x11.XSendEvent(display, x11.XDefaultRootWindow(display), 0, SUBSTRUCTURE_NOTIFY_AND_REDIRECT, ctypes.byref(event))


if action == 'activate':
    send('_NET_ACTIVE_WINDOW', [SOURCE_PAGER])
elif action == 'minimize':
    send('WM_CHANGE_STATE', [ICONIC_STATE])
elif action == 'maximize':
    send('_NET_WM_STATE', [TOGGLE, atom('_NET_WM_STATE_MAXIMIZED_VERT'), atom('_NET_WM_STATE_MAXIMIZED_HORZ'), SOURCE_PAGER])
elif action == 'close':
    send('_NET_CLOSE_WINDOW', [0, SOURCE_PAGER])
else:
    sys.exit(2)
x11.XFlush(display)
x11.XCloseDisplay(display)
