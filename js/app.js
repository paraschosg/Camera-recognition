import { loadVision, HAND_CONNECTIONS } from "./vision.js";
import {
  handFeatures,
  emotionFromBlendshapes,
  EmotionSmoother,
  faceGeometry,
  FrameAnalyzer,
  describeColor,
} from "./analysis.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
const statusEl = $("status");
const startBtn = $("startBtn");

const state = {
  running: false,
  models: null,
  frame: 0,
  lastFaceResult: null,
  lastFrameInfo: null,
  emotion: new EmotionSmoother(0.12),
  analyzer: new FrameAnalyzer(),
  fps: { last: performance.now(), frames: 0, value: 0 },
  lux: null,
  lastUiUpdate: 0,
  handTracks: [], // previous palm positions per hand slot, for movement speed
};

const EMOTION_EMOJI = { happy: "😊 Happy", surprised: "😮 Surprised", sad: "😢 Sad", angry: "😠 Angry", neutral: "😐 Neutral" };
const HAND_COLORS = ["#33d6a6", "#7c5cff"];

function setStatus(text, isError = false) {
  statusEl.innerHTML = text;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.remove("hidden");
}

// ---------- Setup ----------

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((resolve) => (video.onloadedmetadata = resolve));
  await video.play();
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  const track = stream.getVideoTracks()[0];
  const s = track.getSettings();
  $("camInfo").textContent = `${s.width}×${s.height}${s.frameRate ? ` @ ${Math.round(s.frameRate)} fps` : ""}`;
}

function startAmbientLightSensor() {
  // Only Chromium exposes this, and often behind a flag. Purely optional.
  if (!("AmbientLightSensor" in window)) return;
  try {
    const sensor = new window.AmbientLightSensor({ frequency: 2 });
    sensor.addEventListener("reading", () => {
      state.lux = sensor.illuminance;
    });
    sensor.addEventListener("error", () => {
      state.lux = null;
    });
    sensor.start();
  } catch (err) {
    console.info("Ambient light sensor unavailable", err);
  }
}

async function start() {
  startBtn.disabled = true;
  try {
    setStatus("Requesting camera…");
    await startCamera();

    state.models = await loadVision(setStatus);
    startAmbientLightSensor();

    statusEl.classList.add("hidden");
    state.running = true;
    startBtn.textContent = "Running";
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    const msg = err?.name === "NotAllowedError"
      ? "Camera access was denied. Allow the camera in your browser and try again."
      : `Could not start: ${err?.message || err}`;
    setStatus(msg, true);
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", start);
$("mirror").addEventListener("change", (e) => $("videoWrap").classList.toggle("mirrored", e.target.checked));

// ---------- Main loop ----------

function loop() {
  if (!state.running) return;
  const now = performance.now();
  state.frame++;

  if (video.readyState >= 2) {
    const hands = state.models.hands.detectForVideo(video, now);

    // Face landmarks are heavier; run them every other frame.
    if (state.frame % 2 === 0) {
      state.lastFaceResult = state.models.face.detectForVideo(video, now);
    }
    // Pixel statistics are cheap but do not need to run every frame.
    if (state.frame % 3 === 0) {
      state.lastFrameInfo = state.analyzer.analyze(video);
    }

    const handInfo = processHands(hands, now);
    const faceInfo = processFace(state.lastFaceResult);
    draw(hands, state.lastFaceResult, handInfo);

    if (now - state.lastUiUpdate > 100) {
      updateUI(handInfo, faceInfo, state.lastFrameInfo, hands);
      state.lastUiUpdate = now;
    }
  }

  state.fps.frames++;
  if (now - state.fps.last >= 1000) {
    state.fps.value = state.fps.frames;
    state.fps.frames = 0;
    state.fps.last = now;
  }
  requestAnimationFrame(loop);
}

/** Extracts gesture and movement information for each detected hand. */
function processHands(result, now) {
  const landmarksList = result?.landmarks ?? [];
  // Keep hand slots stable: sort hands left-to-right in screen space.
  const ordered = landmarksList
    .map((lm, i) => ({ lm, handedness: result.handednesses?.[i]?.[0]?.categoryName ?? "?" }))
    .sort((a, b) => a.lm[9].x - b.lm[9].x);

  const hands = [];
  let maxSpeed = 0;
  for (let slot = 0; slot < 2; slot++) {
    const hand = ordered[slot];
    if (!hand) {
      state.handTracks[slot] = null;
      hands.push(null);
      continue;
    }
    const f = handFeatures(hand.lm);
    // Movement speed in screen widths per second, smoothed.
    const prev = state.handTracks[slot];
    let speed = 0;
    if (prev) {
      const dt = Math.max(1, now - prev.t) / 1000;
      const raw = Math.hypot(f.palm.x - prev.x, f.palm.y - prev.y) / dt;
      speed = prev.speed + (raw - prev.speed) * 0.3;
    }
    state.handTracks[slot] = { x: f.palm.x, y: f.palm.y, t: now, speed };
    maxSpeed = Math.max(maxSpeed, speed);

    const height = 1 - Math.min(1, Math.max(0, (f.palm.y - 0.08) / 0.84));
    hands.push({ ...f, speed, height, handedness: hand.handedness });
  }

  let movement;
  if (!hands.some(Boolean)) movement = "—";
  else if (maxSpeed < 0.15) movement = "still";
  else if (maxSpeed < 0.6) movement = "slow";
  else if (maxSpeed < 1.5) movement = "moving";
  else movement = "fast / waving";

  return { hands, movement, maxSpeed };
}

function processFace(result) {
  if (!result?.faceLandmarks?.length) return { faces: 0 };
  const shapes = result.faceBlendshapes?.[0]?.categories;
  let emo = null, jawOpen = 0, blink = 0;
  if (shapes) {
    const e = emotionFromBlendshapes(shapes);
    emo = state.emotion.update(e.scores);
    jawOpen = e.jawOpen;
    blink = e.blink;
  }
  const geo = faceGeometry(result.faceLandmarks[0], video.videoWidth, video.videoHeight);
  return { faces: result.faceLandmarks.length, emotion: emo, jawOpen, blink, ...geo };
}

// ---------- Drawing ----------

function draw(hands, face, handInfo) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!$("showLandmarks").checked) return;
  const W = overlay.width, H = overlay.height;

  if (face?.faceLandmarks) {
    octx.fillStyle = "rgba(255,255,255,0.35)";
    for (const lm of face.faceLandmarks) {
      for (let i = 0; i < lm.length; i += 3) {
        octx.fillRect(lm[i].x * W - 1, lm[i].y * H - 1, 2, 2);
      }
    }
  }

  const ordered = [...(hands?.landmarks ?? [])].sort((a, b) => a[9].x - b[9].x);
  ordered.forEach((lm, slot) => {
    const color = HAND_COLORS[slot] ?? "#ffffff";
    octx.strokeStyle = color;
    octx.lineWidth = 3;
    octx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      octx.moveTo(lm[a].x * W, lm[a].y * H);
      octx.lineTo(lm[b].x * W, lm[b].y * H);
    }
    octx.stroke();
    octx.fillStyle = "#fff";
    for (const p of lm) {
      octx.beginPath();
      octx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
      octx.fill();
    }
    const info = handInfo.hands[slot];
    if (info) drawLabel(info.gesture, lm[9].x * W, lm[9].y * H - 70, color, info.openness);
  });
}

/** Draws text that stays readable even when the canvas is mirrored. */
function drawLabel(text, x, y, color, level) {
  const mirrored = $("mirror").checked;
  octx.save();
  if (mirrored) {
    octx.translate(overlay.width, 0);
    octx.scale(-1, 1);
    x = overlay.width - x;
  }
  octx.font = "bold 22px system-ui, sans-serif";
  const w = octx.measureText(text).width + 20;
  octx.fillStyle = "rgba(15,17,23,0.75)";
  octx.fillRect(x - w / 2, y - 18, w, 34);
  octx.fillStyle = color;
  octx.fillRect(x - w / 2, y + 12, w * Math.max(0, Math.min(1, level)), 4);
  octx.fillStyle = "#fff";
  octx.textAlign = "center";
  octx.fillText(text, x, y + 7);
  octx.restore();
}

// ---------- UI ----------

function updateUI(handInfo, faceInfo, frameInfo, hands) {
  // Hands
  document.querySelectorAll("#handsList .hand").forEach((el, slot) => {
    const info = handInfo.hands[slot];
    el.classList.toggle("active", !!info);
    el.querySelector(".note").textContent = info ? info.gesture : "—";
    el.querySelector(".fill").style.width = `${Math.round((info?.openness ?? 0) * 100)}%`;
    el.querySelector(".fingers").textContent = info
      ? `${info.fingerCount} finger${info.fingerCount === 1 ? "" : "s"} up · ${Math.round(info.openness * 100)}% open · height ${Math.round(info.height * 100)}%`
      : "—";
    el.querySelector(".gesture").textContent = info ? `${info.handedness} hand` : "no hand";
  });
  $("handMotion").textContent = handInfo.movement;

  // Emotion
  if (faceInfo.faces && faceInfo.emotion) {
    const { emotion, confidence, scores } = faceInfo.emotion;
    $("emotionMain").textContent = `${EMOTION_EMOJI[emotion]} · ${Math.round(confidence * 100)}%`;
    document.querySelectorAll("#emotionBars .bar").forEach((bar) => {
      const k = bar.dataset.emotion;
      bar.querySelector(".fill").style.width = `${Math.round(scores[k] * 100)}%`;
      bar.querySelector("em").textContent = `${Math.round(scores[k] * 100)}%`;
    });
  } else {
    $("emotionMain").textContent = "No face";
  }

  // Room
  if (frameInfo) {
    $("lightLevel").textContent = `${frameInfo.lightLevel} (${Math.round(frameInfo.brightness * 100)}%)`;
    $("lightFill").style.width = `${Math.round(frameInfo.brightness * 100)}%`;
    $("colorTemp").textContent = frameInfo.colorTemp;
    const c = frameInfo.dominant;
    $("swatch").style.background = `rgb(${c.r},${c.g},${c.b})`;
    $("dominantColor").textContent = describeColor(c);
    $("motion").textContent = `${frameInfo.motionLabel} (${Math.round(frameInfo.motion * 100)}%)`;
  }
  $("lux").textContent = state.lux == null ? "not available" : `${Math.round(state.lux)} lux`;

  // Scene
  $("faces").textContent = String(faceInfo.faces ?? 0);
  $("hands").textContent = String(hands?.landmarks?.length ?? 0);
  if (faceInfo.faces) {
    const t = faceInfo.tiltDeg;
    $("headTilt").textContent = Math.abs(t) < 4 ? "level" : `${Math.abs(t).toFixed(0)}° ${t > 0 ? "right" : "left"}`;
    $("distance").textContent = faceInfo.distanceCm ? `≈ ${Math.round(faceInfo.distanceCm)} cm` : "—";
    $("mouth").textContent = faceInfo.jawOpen > 0.35 ? "open" : faceInfo.jawOpen > 0.12 ? "slightly open" : "closed";
    $("eyes").textContent = faceInfo.blink > 0.5 ? "closed" : "open";
  } else {
    for (const id of ["headTilt", "distance", "mouth", "eyes"]) $(id).textContent = "—";
  }
  $("fps").textContent = `${state.fps.value} fps`;
}
