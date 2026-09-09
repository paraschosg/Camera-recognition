// Pure analysis helpers: hand gestures, emotion from face blendshapes, room light and motion.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---------- Hands ----------

const FINGERS = {
  index: { tip: 8, pip: 6 },
  middle: { tip: 12, pip: 10 },
  ring: { tip: 16, pip: 14 },
  pinky: { tip: 20, pip: 18 },
};

/** Extracts control features from 21 hand landmarks (normalized coords). */
export function handFeatures(lm) {
  const wrist = lm[0];
  const palmPoints = [0, 5, 9, 13, 17].map((i) => lm[i]);
  const palm = {
    x: palmPoints.reduce((s, p) => s + p.x, 0) / palmPoints.length,
    y: palmPoints.reduce((s, p) => s + p.y, 0) / palmPoints.length,
  };
  const palmSize = Math.max(1e-4, dist(lm[0], lm[9]));

  // Openness: how far the fingertips are from the palm centre, relative to hand size.
  const tips = [8, 12, 16, 20].map((i) => dist(lm[i], palm) / palmSize);
  const meanTip = tips.reduce((s, v) => s + v, 0) / tips.length;
  // A curled fist keeps the tips ~0.4-0.5 palm lengths away; a flat open hand ~1.1-1.3.
  const openness = clamp01((meanTip - 0.5) / 0.65);

  // Which fingers are extended (tip further from the wrist than the middle joint).
  const up = {};
  for (const [name, f] of Object.entries(FINGERS)) {
    up[name] = dist(lm[f.tip], wrist) > dist(lm[f.pip], wrist) * 1.15;
  }
  up.thumb = dist(lm[4], lm[17]) > dist(lm[3], lm[17]) * 1.1 && dist(lm[4], palm) / palmSize > 0.9;
  const fingerCount = Object.values(up).filter(Boolean).length;

  // Pinch = thumb and index tips together while the other fingers stay out; a fist also
  // brings those tips together, so it must not count.
  const pinchDist = dist(lm[4], lm[8]) / palmSize;
  const othersOut = [up.middle, up.ring, up.pinky].filter(Boolean).length >= 2;
  const pinch = othersOut ? clamp01((0.55 - pinchDist) / 0.35) : 0; // 1 = fully pinched
  // Thumb + middle finger pinch (used as a right click); index must stay clear of the thumb.
  const pinchMiddleDist = dist(lm[4], lm[12]) / palmSize;
  const pinchMiddle = pinchDist > 0.6 && (up.ring || up.pinky) ? clamp01((0.55 - pinchMiddleDist) / 0.35) : 0;

  let gesture;
  if (pinch > 0.75) gesture = "pinch";
  else if (fingerCount === 0) gesture = "fist";
  else if (fingerCount >= 4 && openness > 0.5) gesture = "open palm";
  else if (up.index && !up.middle && !up.ring && !up.pinky) gesture = up.thumb ? "L shape" : "pointing";
  else if (up.index && up.middle && !up.ring && !up.pinky) gesture = "peace";
  else if (up.index && up.pinky && !up.middle && !up.ring) gesture = "rock on";
  else if (up.thumb && !up.index && !up.middle && !up.ring && !up.pinky) gesture = "thumbs up";
  else gesture = `${fingerCount} finger${fingerCount === 1 ? "" : "s"}`;

  return { palm, palmSize, openness, pinch, pinchMiddle, fingerCount, up, gesture, indexTip: lm[8] };
}

// ---------- Emotion ----------

const EMOTIONS = ["happy", "surprised", "sad", "angry", "neutral"];

function blendMap(categories) {
  const m = {};
  for (const c of categories) m[c.categoryName] = c.score;
  return m;
}
const avg = (m, a, b) => ((m[a] ?? 0) + (m[b] ?? 0)) / 2;

/** Heuristic emotion scores from MediaPipe face blendshapes. Returns scores summing to 1. */
export function emotionFromBlendshapes(categories) {
  const m = blendMap(categories);
  const smile = avg(m, "mouthSmileLeft", "mouthSmileRight");
  const frown = avg(m, "mouthFrownLeft", "mouthFrownRight");
  const browDown = avg(m, "browDownLeft", "browDownRight");
  const browInnerUp = m.browInnerUp ?? 0;
  const browOuterUp = avg(m, "browOuterUpLeft", "browOuterUpRight");
  const eyeWide = avg(m, "eyeWideLeft", "eyeWideRight");
  const eyeSquint = avg(m, "eyeSquintLeft", "eyeSquintRight");
  const cheekSquint = avg(m, "cheekSquintLeft", "cheekSquintRight");
  const jawOpen = m.jawOpen ?? 0;
  const sneer = avg(m, "noseSneerLeft", "noseSneerRight");
  const press = avg(m, "mouthPressLeft", "mouthPressRight");
  const lowerDown = avg(m, "mouthLowerDownLeft", "mouthLowerDownRight");

  const raw = {
    happy: smile * 1.6 + cheekSquint * 0.4,
    surprised: jawOpen * 0.7 + eyeWide * 1.0 + browOuterUp * 0.6 + browInnerUp * 0.3,
    sad: frown * 1.4 + browInnerUp * 0.5 + lowerDown * 0.3 - smile * 0.5,
    angry: browDown * 1.3 + sneer * 0.8 + eyeSquint * 0.4 + press * 0.4 - smile * 0.4,
    neutral: 0.22,
  };
  for (const k of EMOTIONS) raw[k] = Math.max(0, raw[k]);
  const sum = EMOTIONS.reduce((s, k) => s + raw[k], 0) || 1;
  const scores = {};
  for (const k of EMOTIONS) scores[k] = raw[k] / sum;
  return {
    scores,
    jawOpen,
    browInnerUp,
    blink: avg(m, "eyeBlinkLeft", "eyeBlinkRight"),
  };
}

/** Exponential smoothing so the emotion readout does not flicker. */
export class EmotionSmoother {
  constructor(alpha = 0.15) {
    this.alpha = alpha;
    this.scores = Object.fromEntries(EMOTIONS.map((k) => [k, k === "neutral" ? 1 : 0]));
  }
  update(scores) {
    for (const k of EMOTIONS) this.scores[k] += (scores[k] - this.scores[k]) * this.alpha;
    return this.dominant();
  }
  dominant() {
    let best = "neutral";
    for (const k of EMOTIONS) if (this.scores[k] > this.scores[best]) best = k;
    return { emotion: best, confidence: this.scores[best], scores: this.scores };
  }
}

// ---------- Face geometry ----------

/** Head tilt (degrees, positive = tilted toward the viewer's right) and camera distance estimate. */
export function faceGeometry(landmarks, videoWidth, videoHeight) {
  const rightEye = landmarks[33];
  const leftEye = landmarks[263];
  const dx = (leftEye.x - rightEye.x) * videoWidth;
  const dy = (leftEye.y - rightEye.y) * videoHeight;
  const tiltDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const eyeDistPx = Math.hypot(dx, dy);
  // Rough pinhole estimate: average adult inter-ocular distance ≈ 6.3 cm, focal ≈ 0.9 × frame width.
  const focalPx = videoWidth * 0.9;
  const distanceCm = eyeDistPx > 1 ? (6.3 * focalPx) / eyeDistPx : null;
  return { tiltDeg, distanceCm };
}

// ---------- Room light, colour and motion ----------

export class FrameAnalyzer {
  constructor(width = 64, height = 36) {
    this.w = width;
    this.h = height;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.prev = null;
    this.motionSmooth = 0;
  }

  analyze(video) {
    this.ctx.drawImage(video, 0, 0, this.w, this.h);
    const { data } = this.ctx.getImageData(0, 0, this.w, this.h);
    const n = this.w * this.h;
    let r = 0, g = 0, b = 0, lum = 0, diff = 0;
    const hadPrev = !!this.prev;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
      r += R; g += G; b += B;
      const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      gray[i] = y;
      lum += y;
      if (this.prev) diff += Math.abs(y - this.prev[i]);
    }
    this.prev = gray;
    r /= n; g /= n; b /= n; lum /= n;
    const brightness = lum / 255; // 0..1

    const motionRaw = hadPrev ? clamp01(diff / n / 40) : 0;
    this.motionSmooth += (motionRaw - this.motionSmooth) * 0.3;

    // Warm/cool from the red:blue balance of the whole frame.
    const warmth = (r + 1) / (b + 1);
    let colorTemp;
    if (warmth > 1.35) colorTemp = "warm (incandescent / sunset)";
    else if (warmth > 1.1) colorTemp = "slightly warm";
    else if (warmth > 0.92) colorTemp = "neutral / daylight";
    else colorTemp = "cool (screens / overcast)";

    let lightLevel;
    if (brightness < 0.08) lightLevel = "very dark";
    else if (brightness < 0.2) lightLevel = "dim";
    else if (brightness < 0.45) lightLevel = "normal indoor";
    else if (brightness < 0.7) lightLevel = "bright";
    else lightLevel = "very bright";

    let motionLabel;
    if (this.motionSmooth < 0.03) motionLabel = "still";
    else if (this.motionSmooth < 0.12) motionLabel = "slight";
    else if (this.motionSmooth < 0.3) motionLabel = "moving";
    else motionLabel = "lots of movement";

    return {
      brightness,
      lightLevel,
      colorTemp,
      warmth,
      motion: this.motionSmooth,
      motionLabel,
      dominant: { r: Math.round(r), g: Math.round(g), b: Math.round(b) },
    };
  }
}

export function describeColor({ r, g, b }) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 510;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1)) / 255;
  if (sat < 0.12) return l < 0.25 ? "dark grey" : l > 0.7 ? "light grey" : "grey";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 20 || h >= 340) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 260) return "blue";
  if (h < 300) return "purple";
  return "pink";
}
