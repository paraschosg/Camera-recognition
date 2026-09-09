# Camera Sense

A browser app that watches through your webcam and tells you what it sees: your hand gestures and movement, your mood, the room light and general scene information.

- **Hand gestures.** Tracks up to two hands and names the gesture: open palm, fist, pinch, pointing, peace, rock on, thumbs up, L shape or a finger count. Also reports how open each hand is, its height in the frame and how fast it is moving.
- **Emotion.** Face blendshapes are mapped to happy / surprised / sad / angry / neutral with a confidence bar for each.
- **Room light.** Frame brightness, a light-level label, colour temperature (warm / neutral / cool), dominant colour and the ambient light sensor in lux when the browser exposes one.
- **Other scene info.** Number of faces and hands, head tilt, approximate distance to the camera, mouth open / closed, eyes open / closed, motion level, camera resolution and frame rate.
- **Hands-free computer control.** Drive the real mouse and keyboard with your hand or your head through a small local bridge. See below.

Everything runs locally in the browser. No video ever leaves your machine.

## Run it

The page must be served over `http://localhost` or `https://` for the camera to work (browsers block `getUserMedia` on `file://`).

```bash
npm start          # serves the folder on http://localhost:8080
# or, with no Node at all:
python3 -m http.server 8080
```

Open the URL, press **Start camera**, allow the camera, and show it your hand or face. Chrome, Edge and recent Firefox and Safari work; Chrome is fastest because it can run the models on the GPU.

## Hands-free computer control

A web page cannot move the system cursor on its own, so a tiny Python bridge does it. Everything stays on your machine: the page talks to the bridge over a local WebSocket on port 8765, and the bridge only accepts pages served from localhost.

```bash
pip install -r bridge/requirements.txt
python3 bridge/bridge.py        # keep this window open
```

Then open the app, pick a mode in the **Computer control** card and the status turns green.

| Hand pointer | Head pointer |
|---|---|
| Index finger moves the cursor | Move your head to move the cursor (press *Re-centre head* to reset the neutral position) |
| Pinch thumb + index = left click, hold to drag | Open your mouth = left click, keep it open to drag |
| Pinch thumb + middle finger = right click | Raise your eyebrows = right click |
| Peace sign and move up / down = scroll | Tilt your head left / right = scroll |
| Fist = rest (cursor stays put) | |
| Hold an open palm 0.6 s = pause / resume | |

Extras that work in both modes:

- **Dwell click.** Hold the cursor still for one second to click, for people who cannot pinch or open their mouth.
- **Gesture bindings.** Hold a gesture for 0.6 s to fire an action. Defaults: thumbs up → Enter, L shape → Escape, rock on → Alt+Tab. Edit them in the card; actions look like `key:ctrl+c`, `click:right`, `click:double`, `type:hello`, `scroll` or `toggle`. Bindings are saved in the browser.
- **Sensitivity.** Shrinks the area of the camera frame that maps onto the whole screen, so smaller movements go further. The dashed box on the video shows the active area in hand mode.

The bridge accepts these JSON commands, should you want to drive it from something else: `hello`, `move {x,y}` (0..1), `button {button,state}`, `click {button,count}`, `scroll {dx,dy}`, `key {keys:[...]}`, `type {text}`.

On macOS the first run asks you to allow Accessibility access for the terminal that runs the bridge. On Linux the bridge needs an X11 or XWayland session.

## How it works

| Piece | File | What it does |
|---|---|---|
| Hand and face tracking | `js/vision.js` | Loads MediaPipe Tasks Vision hand and face landmarkers from a CDN (WebAssembly, GPU when available). |
| Gesture and emotion features | `js/analysis.js` | Hand openness, pinch, finger count and gesture name; emotion scores from 52 face blendshapes; head tilt and distance; frame brightness, colour temperature and motion. |
| Computer control | `js/control.js` | One Euro smoothing, pinch / mouth click state machines, dwell click, gesture bindings and the WebSocket client for the bridge. |
| Control bridge | `bridge/bridge.py` | Python + pynput: turns the JSON commands into real mouse and keyboard events. |
| App loop and UI | `js/app.js` | Runs detection each frame, tracks hand movement, drives the controller, draws the overlay and updates the side panel. |

No build step and no dependencies to install. `npm run check` syntax-checks the scripts.

## Privacy

Camera frames are processed on-device by the models loaded from the CDN. Nothing is uploaded.
