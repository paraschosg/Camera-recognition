// Formant-based singing synthesizer built on the Web Audio API.
// Each SingingVoice is a glottal-like sawtooth source pushed through a bank of
// band-pass filters tuned to vowel formants, with vibrato and a touch of breath noise.

const VOWELS = {
  u: { label: "oo", f: [300, 870, 2240], g: [1.0, 0.3, 0.1] },
  o: { label: "oh", f: [570, 840, 2410], g: [1.0, 0.6, 0.15] },
  a: { label: "ah", f: [730, 1090, 2440], g: [1.0, 0.5, 0.25] },
  e: { label: "eh", f: [530, 1840, 2480], g: [1.0, 0.35, 0.2] },
  i: { label: "ee", f: [270, 2290, 3010], g: [1.0, 0.2, 0.15] },
};
export const VOWEL_ORDER = ["u", "o", "a", "e", "i"];

export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

// Lowest MIDI note of the two-octave range each voice type can reach.
export const VOICE_RANGES = {
  soprano: 60, // C4
  alto: 55, // G3
  tenor: 48, // C3
  bass: 41, // F2
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
export function midiToName(m) {
  return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
}

// Map a 0..1 position (0 = low) to a MIDI note in the given scale spanning two octaves.
export function positionToMidi(pos, scaleName, rootMidi, octaveShift = 0) {
  const scale = SCALES[scaleName] || SCALES.pentatonic;
  const notes = [];
  for (let oct = 0; oct <= 2; oct++) {
    for (const step of scale) notes.push(rootMidi + oct * 12 + step);
  }
  const trimmed = notes.filter((n) => n <= rootMidi + 24);
  const idx = Math.min(trimmed.length - 1, Math.max(0, Math.round(pos * (trimmed.length - 1))));
  // Never go above G6: an octave shift on a soprano would otherwise turn into a whistle.
  return Math.min(91, trimmed[idx] + octaveShift * 12);
}

function makeNoiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function makeReverbImpulse(ctx, seconds = 2.2, decay = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export class SingingVoice {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.vowel = "a";

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    // Source
    this.osc = ctx.createOscillator();
    this.osc.type = "sawtooth";
    this.osc.frequency.value = 220;

    // Vibrato: LFO into detune (cents)
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = 5.5;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0;
    this.lfo.connect(this.lfoGain).connect(this.osc.detune);

    this.pre = ctx.createGain();
    this.pre.gain.value = 0.35;
    this.osc.connect(this.pre);

    // Formant bank
    const v = VOWELS[this.vowel];
    this.formants = v.f.map((freq, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 9;
      const g = ctx.createGain();
      g.gain.value = v.g[i];
      this.pre.connect(bp).connect(g).connect(this.out);
      return { bp, g };
    });

    // Breath noise for realism
    this.noise = ctx.createBufferSource();
    this.noise.buffer = makeNoiseBuffer(ctx);
    this.noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = "bandpass";
    this.noiseFilter.frequency.value = 2600;
    this.noiseFilter.Q.value = 0.8;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.out);

    this.osc.start();
    this.lfo.start();
    this.noise.start();

    this.current = { midi: null, level: 0, vowel: "a", vibrato: 0 };
  }

  /**
   * @param {object} p
   * @param {number|null} p.midi      target MIDI note, null for silence
   * @param {number} p.level          0..1 loudness
   * @param {string} p.vowel          one of VOWELS keys
   * @param {number} p.vibrato        0..1 vibrato depth
   */
  set({ midi, level, vowel, vibrato }) {
    const t = this.ctx.currentTime;
    const silent = midi == null || level <= 0.02;
    const gain = silent ? 0 : Math.min(1, level) * 0.9;
    this.out.gain.setTargetAtTime(gain, t, silent ? 0.08 : 0.05);

    if (midi != null) {
      // Slight portamento between notes makes it feel sung rather than played.
      this.osc.frequency.setTargetAtTime(midiToFreq(midi), t, 0.045);
    }
    this.lfoGain.gain.setTargetAtTime(Math.max(0, Math.min(1, vibrato)) * 45, t, 0.12);
    this.noiseGain.gain.setTargetAtTime(silent ? 0 : 0.02 + level * 0.03, t, 0.1);

    if (vowel && vowel !== this.vowel && VOWELS[vowel]) {
      this.vowel = vowel;
      const v = VOWELS[vowel];
      this.formants.forEach(({ bp, g }, i) => {
        bp.frequency.setTargetAtTime(v.f[i], t, 0.08);
        g.gain.setTargetAtTime(v.g[i], t, 0.08);
      });
    }
    this.current = { midi: silent ? null : midi, level: silent ? 0 : level, vowel: this.vowel, vibrato };
  }

  silence() {
    this.set({ midi: this.current.midi, level: 0, vowel: this.vowel, vibrato: 0 });
  }
}

export class Choir {
  constructor(voiceCount = 2) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

    // Tone shaping controlled by room light: dark rooms sound warmer, bright rooms brighter.
    this.shelf = this.ctx.createBiquadFilter();
    this.shelf.type = "highshelf";
    this.shelf.frequency.value = 2200;
    this.shelf.gain.value = 0;

    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = makeReverbImpulse(this.ctx);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.25;
    this.dryGain = this.ctx.createGain();
    this.dryGain.gain.value = 0.85;

    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.ratio.value = 4;

    this.master.connect(this.shelf);
    this.shelf.connect(this.dryGain).connect(this.comp);
    this.shelf.connect(this.reverb).connect(this.reverbGain).connect(this.comp);
    this.comp.connect(this.ctx.destination);

    this.voices = Array.from({ length: voiceCount }, () => new SingingVoice(this.ctx, this.master));
  }

  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /** brightness 0..1 from the room; reverb grows a little in the dark. */
  setRoomTone(brightness) {
    const t = this.ctx.currentTime;
    const b = Math.max(0, Math.min(1, brightness));
    this.shelf.gain.setTargetAtTime(-8 + b * 12, t, 0.5);
    this.reverbGain.gain.setTargetAtTime(0.4 - b * 0.25, t, 0.5);
  }

  vowelLabel(key) {
    return VOWELS[key]?.label ?? "—";
  }
}
