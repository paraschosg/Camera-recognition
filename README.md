# Gesture Singer

A browser app that turns your webcam into a singing instrument and a small scene analyser.

- **Sing with your hands.** Each hand is a voice. Raise it to sing higher, open it to sing louder, close it to go quiet, slide it sideways to change the vowel (oo · oh · ah · eh · ee) and pinch thumb and index for vibrato. Two hands give you a duet.
- **Emotion.** Face blendshapes are mapped to happy / surprised / sad / angry / neutral. In *Auto* scale mode your mood picks the musical scale (happy → major, sad → minor, angry → blues, surprised → an octave up).
- **Room light.** Frame brightness, a light-level label, colour temperature (warm / neutral / cool), dominant colour and the ambient light sensor in lux when the browser exposes one. Darker rooms make the voice warmer and more reverberant.
- **Other scene info.** Number of faces and hands, head tilt, approximate distance to the camera, mouth open / closed, eyes open / closed, motion level, camera resolution and frame rate.

Everything runs locally in the browser. No video ever leaves your machine.

## Run it

The page must be served over `http://localhost` or `https://` for the camera to work (browsers block `getUserMedia` on `file://`).

```bash
npm start          # serves the folder on http://localhost:8080
# or, with no Node at all:
python3 -m http.server 8080
```

Open the URL, press **Start camera & voice**, allow the camera, and put your hand in front of the camera. Chrome, Edge and recent Firefox and Safari work; Chrome is fastest because it can run the models on the GPU.

## How it works

| Piece | File | What it does |
|---|---|---|
| Hand and face tracking | `js/vision.js` | Loads MediaPipe Tasks Vision hand and face landmarkers from a CDN (WebAssembly, GPU when available). |
| Gesture and emotion features | `js/analysis.js` | Hand openness, pinch, finger count and gesture name; emotion scores from 52 face blendshapes; head tilt and distance; frame brightness, colour temperature and motion. |
| Singing voice | `js/voice.js` | Web Audio formant synthesis: a sawtooth source through three band-pass formant filters per vowel, vibrato LFO, breath noise, reverb and a compressor. |
| App loop and UI | `js/app.js` | Runs detection each frame, maps hands to voices, draws the overlay and updates the side panel. |

No build step and no dependencies to install. `npm run check` syntax-checks the scripts.

## Privacy

Camera frames are processed on-device by the models loaded from the CDN. Nothing is uploaded.
