#!/usr/bin/env python3
"""Local control bridge for Camera Sense.

Listens on ws://127.0.0.1:8765 and turns JSON commands from the web app into real
mouse and keyboard events with pynput. It only accepts connections from pages served on
localhost so a random website cannot drive your computer.

Run:  python3 bridge.py            (after: pip install -r requirements.txt)
"""
import asyncio
import json
import sys

try:
    import websockets
    from pynput.keyboard import Controller as KeyboardController, Key
    from pynput.mouse import Button, Controller as MouseController
except ImportError as exc:  # pragma: no cover
    sys.exit(f"Missing dependency ({exc}). Run: pip install -r requirements.txt")

HOST = "127.0.0.1"
PORT = 8765
ALLOWED_ORIGIN_PREFIXES = ("http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1")

mouse = MouseController()
keyboard = KeyboardController()

KEY_NAMES = {
    "ctrl": Key.ctrl, "control": Key.ctrl, "shift": Key.shift, "alt": Key.alt, "option": Key.alt,
    "cmd": Key.cmd, "command": Key.cmd, "win": Key.cmd, "super": Key.cmd, "meta": Key.cmd,
    "enter": Key.enter, "return": Key.enter, "esc": Key.esc, "escape": Key.esc, "tab": Key.tab,
    "space": Key.space, "backspace": Key.backspace, "delete": Key.delete, "del": Key.delete,
    "up": Key.up, "down": Key.down, "left": Key.left, "right": Key.right,
    "home": Key.home, "end": Key.end, "pageup": Key.page_up, "pagedown": Key.page_down,
    "capslock": Key.caps_lock, "insert": Key.insert,
    "volumeup": Key.media_volume_up, "volumedown": Key.media_volume_down, "mute": Key.media_volume_mute,
    "playpause": Key.media_play_pause, "next": Key.media_next, "previous": Key.media_previous,
}
for _i in range(1, 13):
    KEY_NAMES[f"f{_i}"] = getattr(Key, f"f{_i}")

BUTTONS = {"left": Button.left, "right": Button.right, "middle": Button.middle}


def parse_key(name: str):
    name = name.strip().lower()
    if name in KEY_NAMES:
        return KEY_NAMES[name]
    if len(name) == 1:
        return name
    raise ValueError(f"unknown key: {name}")


def screen_size():
    """Best-effort screen size; falls back to a common resolution if unavailable."""
    try:
        import tkinter

        root = tkinter.Tk()
        root.withdraw()
        size = (root.winfo_screenwidth(), root.winfo_screenheight())
        root.destroy()
        return size
    except Exception:
        return (1920, 1080)


SCREEN_W, SCREEN_H = screen_size()


def handle(cmd: dict):
    kind = cmd.get("type")
    if kind == "move":
        x = min(max(float(cmd["x"]), 0.0), 1.0) * (SCREEN_W - 1)
        y = min(max(float(cmd["y"]), 0.0), 1.0) * (SCREEN_H - 1)
        mouse.position = (int(x), int(y))
    elif kind == "button":
        button = BUTTONS[cmd.get("button", "left")]
        if cmd.get("state") == "down":
            mouse.press(button)
        else:
            mouse.release(button)
    elif kind == "click":
        mouse.click(BUTTONS[cmd.get("button", "left")], int(cmd.get("count", 1)))
    elif kind == "scroll":
        mouse.scroll(int(cmd.get("dx", 0)), int(cmd.get("dy", 0)))
    elif kind == "key":
        keys = [parse_key(k) for k in cmd.get("keys", []) if k.strip()]
        if not keys:
            return
        for k in keys:
            keyboard.press(k)
        for k in reversed(keys):
            keyboard.release(k)
    elif kind == "type":
        keyboard.type(str(cmd.get("text", "")))
    elif kind == "hello":
        return {"type": "screen", "width": SCREEN_W, "height": SCREEN_H}
    else:
        raise ValueError(f"unknown command: {kind}")
    return None


def origin_of(websocket) -> str:
    # websockets >= 13 exposes .request.headers; older releases use .request_headers.
    req = getattr(websocket, "request", None)
    headers = req.headers if req is not None else getattr(websocket, "request_headers", {})
    return headers.get("Origin", "") or ""


async def session(websocket):
    origin = origin_of(websocket)
    if origin and not origin.startswith(ALLOWED_ORIGIN_PREFIXES):
        print(f"refused connection from origin {origin}")
        await websocket.close(code=4403, reason="origin not allowed")
        return
    print(f"web app connected ({origin or 'no origin'})")
    try:
        async for raw in websocket:
            try:
                reply = handle(json.loads(raw))
            except Exception as exc:  # bad command must not kill the bridge
                reply = {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
            if reply:
                await websocket.send(json.dumps(reply))
    finally:
        # Never leave a button held down if the page disappears mid-drag.
        for button in BUTTONS.values():
            try:
                mouse.release(button)
            except Exception:
                pass
        print("web app disconnected")


async def main():
    print(f"Camera Sense bridge listening on ws://{HOST}:{PORT}  (screen {SCREEN_W}x{SCREEN_H})")
    print("Keep this window open. Press Ctrl+C to stop.")
    async with websockets.serve(session, HOST, PORT):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
