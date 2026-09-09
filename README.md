# Camera Sense

A browser app that watches through your webcam and tells you what it sees: your hand gestures and movement, your mood, the room light and general scene information.

- **Hand gestures.** Tracks up to two hands and names the gesture: open palm, fist, pinch, pointing, peace, rock on, thumbs up, L shape or a finger count. Also reports how open each hand is, its height in the frame and how fast it is moving.
- **Emotion.** Face blendshapes are mapped to happy / surprised / sad / angry / neutral with a confidence bar for each.
- **Room light.** Frame brightness, a light-level label, colour temperature (warm / neutral / cool), dominant colour and the ambient light sensor in lux when the browser exposes one.
- **Other scene info.** Number of faces and hands, head tilt, approximate distance to the camera, mouth open / closed, eyes open / closed, motion level, camera resolution and frame rate.

Everything runs locally in the browser. No video ever leaves your machine.

## Run it

The page must be served over `http://localhost` or `https://` for the camera to work (browsers block `getUserMedia` on `file://`).

```bash
npm start          # serves the folder on http://localhost:8080
# or, with no Node at all:
python3 -m http.server 8080
```

Open the URL, press **Start camera**, allow the camera, and show it your hand or face. Chrome, Edge and recent Firefox and Safari work; Chrome is fastest because it can run the models on the GPU.

## How it works

| Piece | File | What it does |
|---|---|---|
| Hand and face tracking | `js/vision.js` | Loads MediaPipe Tasks Vision hand and face landmarkers from a CDN (WebAssembly, GPU when available). |
| Gesture and emotion features | `js/analysis.js` | Hand openness, pinch, finger count and gesture name; emotion scores from 52 face blendshapes; head tilt and distance; frame brightness, colour temperature and motion. |
| App loop and UI | `js/app.js` | Runs detection each frame, tracks hand movement, draws the overlay and updates the side panel. |

No build step and no dependencies to install. `npm run check` syntax-checks the scripts.

## Privacy

Camera frames are processed on-device by the models loaded from the CDN. Nothing is uploaded.
