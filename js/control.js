// Hands-free computer control: turns hand or head tracking into mouse and keyboard
// commands and sends them to the local bridge (bridge/bridge.py) over a WebSocket.

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const DEFAULT_BINDINGS = [
  { gesture: "thumbs up", action: "key:enter" },
  { gesture: "L shape", action: "key:escape" },
  { gesture: "rock on", action: "key:alt+tab" },
  { gesture: "peace", action: "scroll" },
  { gesture: "open palm", action: "toggle" },
];

export const ACTION_HELP =
  "key:ctrl+c · click:left · click:right · click:double · scroll · toggle · type:hello";

/** One Euro filter: smooths jitter when the hand is still, follows fast moves closely. */
class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x == null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const dxRaw = (x - this.x) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    this.dx = aD * dxRaw + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cutoff, dt);
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }
  reset() {
    this.x = null;
  }
}

export class BridgeConnection {
  constructor(url = "ws://127.0.0.1:8765") {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.screen = null;
    this.onChange = () => {};
    this.retryTimer = null;
    this.lastMoveSent = 0;
    this.wanted = false;
  }
  connect() {
    this.wanted = true;
    if (this.ws) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      ws.send(JSON.stringify({ type: "hello" }));
      this.onChange();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "screen") this.screen = msg;
        if (msg.type === "error") console.warn("bridge:", msg.message);
        this.onChange();
      } catch {}
    };
    ws.onclose = () => {
      this.ws = null;
      this.connected = false;
      this.onChange();
      if (this.wanted) this.scheduleRetry();
    };
    ws.onerror = () => {};
  }
  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }
  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), 2000);
  }
  send(cmd) {
    if (!this.connected) return;
    if (cmd.type === "move") {
      // The bridge does not need more than ~60 updates a second.
      const now = performance.now();
      if (now - this.lastMoveSent < 15) return;
      this.lastMoveSent = now;
    }
    this.ws.send(JSON.stringify(cmd));
  }
}

/**
 * Converts tracking features into control commands.
 * mode: "off" | "hand" | "head"
 */
export class Controller {
  constructor(bridge) {
    this.bridge = bridge;
    this.mode = "off";
    this.enabled = true; // can be toggled with the "toggle" gesture without changing mode
    this.sensitivity = 1.0; // 0.5 .. 2 : smaller active box = more sensitive
    this.dwellClick = false;
    this.bindings = DEFAULT_BINDINGS.map((b) => ({ ...b }));

    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.cursor = null; // {x,y} 0..1 screen space, for the on-page preview
    this.leftDown = false;
    this.rightDown = false;
    this.pinchFrames = 0;
    this.releaseFrames = 0;
    this.pinchMidFrames = 0;
    this.pinchMidReleaseFrames = 0;
    this.scrollPrevY = null;
    this.scrollAccum = 0;
    this.holdGesture = null;
    this.holdSince = 0;
    this.holdFired = false;
    this.cooldownUntil = 0;
    this.dwellAnchor = null;
    this.dwellSince = 0;
    this.dwellFired = false;
    this.headCenter = null;
    this.mouthFrames = 0;
    this.browFrames = 0;
    this.lastEvent = "";
    this.lastEventAt = 0;
  }

  setMode(mode) {
    if (mode !== this.mode) this.reset();
    this.mode = mode;
    this.headCenter = null;
  }

  reset() {
    this.releaseButtons();
    this.fx.reset();
    this.fy.reset();
    this.cursor = null;
    this.scrollPrevY = null;
    this.holdGesture = null;
    this.dwellAnchor = null;
  }

  releaseButtons() {
    if (this.leftDown) this.bridge.send({ type: "button", button: "left", state: "up" });
    if (this.rightDown) this.bridge.send({ type: "button", button: "right", state: "up" });
    this.leftDown = this.rightDown = false;
  }

  note(text) {
    this.lastEvent = text;
    this.lastEventAt = performance.now();
  }

  /** Map a point inside the camera's active box to 0..1 screen coordinates. */
  activeBox() {
    // Box shrinks with sensitivity so smaller hand moves cover the whole screen.
    const w = 0.55 / this.sensitivity;
    const h = 0.55 / this.sensitivity;
    return { x0: 0.5 - w / 2, y0: 0.45 - h / 2, w, h };
  }

  mapToScreen(px, py, now) {
    const box = this.activeBox();
    // Raw camera frames are not mirrored: the user's right is small x, so flip it.
    const sx = 1 - clamp01((px - box.x0) / box.w);
    const sy = clamp01((py - box.y0) / box.h);
    return { x: clamp01(this.fx.filter(sx, now)), y: clamp01(this.fy.filter(sy, now)) };
  }

  moveTo(pos, now) {
    this.cursor = pos;
    this.bridge.send({ type: "move", x: pos.x, y: pos.y });
    this.updateDwell(pos, now);
  }

  updateDwell(pos, now) {
    if (!this.dwellClick || this.leftDown) {
      this.dwellAnchor = null;
      return;
    }
    if (!this.dwellAnchor || Math.hypot(pos.x - this.dwellAnchor.x, pos.y - this.dwellAnchor.y) > 0.015) {
      this.dwellAnchor = { ...pos };
      this.dwellSince = now;
      this.dwellFired = false;
      return;
    }
    if (!this.dwellFired && now - this.dwellSince > 1000) {
      this.dwellFired = true;
      this.bridge.send({ type: "click", button: "left" });
      this.note("dwell click");
    }
  }
  dwellProgress() {
    if (!this.dwellClick || !this.dwellAnchor || this.dwellFired) return 0;
    return clamp01((performance.now() - this.dwellSince) / 1000);
  }

  runAction(action) {
    const [kind, arg = ""] = action.split(":");
    switch (kind) {
      case "key":
        this.bridge.send({ type: "key", keys: arg.split("+") });
        break;
      case "click":
        if (arg === "double") this.bridge.send({ type: "click", button: "left", count: 2 });
        else this.bridge.send({ type: "click", button: arg || "left" });
        break;
      case "type":
        this.bridge.send({ type: "type", text: arg });
        break;
      case "toggle":
        this.enabled = !this.enabled;
        if (!this.enabled) this.releaseButtons();
        break;
      case "scroll":
        return; // handled continuously, not as a one-shot
    }
    this.note(`${action}`);
  }

  bindingFor(gesture) {
    return this.bindings.find((b) => b.gesture === gesture)?.action ?? null;
  }

  /** Gesture bindings fire after being held for 600 ms, with a cooldown so they fire once. */
  updateHold(gesture, now) {
    if (gesture !== this.holdGesture) {
      this.holdGesture = gesture;
      this.holdSince = now;
      this.holdFired = false;
      return;
    }
    const action = this.bindingFor(gesture);
    if (!action || action === "scroll" || this.holdFired || now < this.cooldownUntil) return;
    if (now - this.holdSince > 600) {
      this.holdFired = true;
      this.cooldownUntil = now + 300;
      // "toggle" must work even while control is paused; everything else needs it on.
      if (action === "toggle" || this.enabled) this.runAction(action);
    }
  }
  holdProgress() {
    const action = this.holdGesture && this.bindingFor(this.holdGesture);
    if (!action || action === "scroll" || this.holdFired) return 0;
    return clamp01((performance.now() - this.holdSince) / 600);
  }

  // ---------- Hand mode ----------

  updateHand(hand, now) {
    if (this.mode !== "hand") return;
    if (!hand) {
      this.releaseButtons();
      this.holdGesture = null;
      this.scrollPrevY = null;
      this.fx.reset();
      this.fy.reset();
      return;
    }

    this.updateHold(hand.gesture, now);
    if (!this.enabled) return;

    const binding = this.bindingFor(hand.gesture);

    // Scroll mode: the bound gesture (peace by default) turns vertical movement into scrolling.
    if (binding === "scroll") {
      if (this.scrollPrevY != null) {
        this.scrollAccum += (hand.palm.y - this.scrollPrevY) * 40 * this.sensitivity;
        const steps = Math.trunc(this.scrollAccum);
        if (steps !== 0) {
          this.bridge.send({ type: "scroll", dx: 0, dy: -steps });
          this.scrollAccum -= steps;
          this.note(steps < 0 ? "scroll up" : "scroll down");
        }
      }
      this.scrollPrevY = hand.palm.y;
      return;
    }
    this.scrollPrevY = null;

    // A fist rests the cursor so the user can reposition their hand without moving it.
    if (hand.gesture === "fist") return;

    // Pinch = left button with hysteresis; a held pinch drags.
    if (hand.pinch > 0.7) {
      this.pinchFrames++;
      this.releaseFrames = 0;
    } else if (hand.pinch < 0.4) {
      this.releaseFrames++;
      this.pinchFrames = 0;
    }
    if (!this.leftDown && this.pinchFrames >= 2) {
      this.leftDown = true;
      this.bridge.send({ type: "button", button: "left", state: "down" });
      this.note("left down");
    } else if (this.leftDown && this.releaseFrames >= 3) {
      this.leftDown = false;
      this.bridge.send({ type: "button", button: "left", state: "up" });
      this.note("left up (click)");
    }

    // Thumb + middle finger = right click.
    if (hand.pinchMiddle > 0.7) {
      this.pinchMidFrames++;
      this.pinchMidReleaseFrames = 0;
    } else if (hand.pinchMiddle < 0.4) {
      this.pinchMidReleaseFrames++;
      this.pinchMidFrames = 0;
    }
    if (!this.rightDown && this.pinchMidFrames >= 2 && !this.leftDown) {
      this.rightDown = true;
      this.bridge.send({ type: "click", button: "right" });
      this.note("right click");
    } else if (this.rightDown && this.pinchMidReleaseFrames >= 3) {
      this.rightDown = false;
    }

    // The pointer follows the index fingertip; during a pinch the tip moves, so use the palm.
    const src = this.leftDown ? hand.palm : hand.indexTip;
    this.moveTo(this.mapToScreen(src.x, src.y, now), now);
  }

  // ---------- Head mode ----------

  updateHead(face, now) {
    if (this.mode !== "head") return;
    if (!face || !face.nose) {
      this.releaseButtons();
      this.fx.reset();
      this.fy.reset();
      return;
    }
    // The first frame sets the neutral head position; small moves around it cover the screen.
    if (!this.headCenter) this.headCenter = { x: face.nose.x, y: face.nose.y };
    const range = 0.08 / this.sensitivity;
    const sx = 1 - clamp01((face.nose.x - this.headCenter.x) / (2 * range) + 0.5);
    const sy = clamp01((face.nose.y - this.headCenter.y) / (2 * range) + 0.5);
    if (!this.enabled) return;

    // Mouth open = left click (held = drag). Eyebrows raised = right click.
    this.mouthFrames = face.jawOpen > 0.45 ? this.mouthFrames + 1 : 0;
    if (!this.leftDown && this.mouthFrames >= 3) {
      this.leftDown = true;
      this.bridge.send({ type: "button", button: "left", state: "down" });
      this.note("left down (mouth)");
    } else if (this.leftDown && face.jawOpen < 0.2) {
      this.leftDown = false;
      this.bridge.send({ type: "button", button: "left", state: "up" });
      this.note("left up (click)");
    }
    this.browFrames = face.browInnerUp > 0.6 ? this.browFrames + 1 : 0;
    if (this.browFrames === 3) {
      this.bridge.send({ type: "click", button: "right" });
      this.note("right click (brows)");
    }

    // Head tilt scrolls.
    if (Math.abs(face.tiltDeg) > 14) {
      this.scrollAccum += Math.sign(face.tiltDeg) * 0.25;
      const steps = Math.trunc(this.scrollAccum);
      if (steps !== 0) {
        this.bridge.send({ type: "scroll", dx: 0, dy: -steps });
        this.scrollAccum -= steps;
        this.note(steps < 0 ? "scroll up (tilt)" : "scroll down (tilt)");
      }
    }

    this.moveTo({ x: clamp01(this.fx.filter(sx, now)), y: clamp01(this.fy.filter(sy, now)) }, now);
  }

  recenterHead() {
    this.headCenter = null;
  }
}
