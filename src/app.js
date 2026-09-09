// ROOMTONE — audio-reactive room lighting for Windows.
// Copyright (C) 2026 Robin
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, version 3.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details. You should have received a copy of the licence along with
// this program. If not, see <https://www.gnu.org/licenses/>.

// ROOMTONE front end.
//
// This is the prototype's logic, with the synthetic beat engine cut out and the
// three real data paths wired in its place:
//
//   audio    60 Hz event from the Rust core   → bass, mid, high, kick, bpm
//   track    3 s poll of the Spotify API      → title, artist, cover, accent
//   lyrics   not yet — step 7                 → the art-bloom fallback stands in
//
// Everything below the data layer is the design as drawn. The per-frame work
// writes styles straight onto cached nodes; the template is only re-rendered
// when state changes, which happens on clicks and keypresses, not per frame.

import { render } from './runtime.js';
import { Renderer, decodeSpectrum } from './render/gl.js';
import { parsePreset } from './render/preset.js';
import { Typography } from './render/typography.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const PROPS = { accent: '#7c5cff', intensity: 1 };

/**
 * Spotify reports the position of audio it has already handed to the output,
 * not the audio currently leaving the speakers. The gap is the player's own
 * buffer, and it is why lyrics ran consistently late across every track rather
 * than being wrong on particular ones — a constant bias like that is never the
 * lyric file's fault.
 *
 * 0.13s, measured against where the slider had to sit to make songs line up.
 * The per-track offset handles what is genuinely wrong in a given LRC file;
 * this handles what was wrong in every one of them.
 */
const REPORT_LAG = 0.13;

/** How each live-adjustable value reads on screen. */
const pct = (v) => Math.round(v * 100) + '%';
const FORMATTERS = {
  safeFlash: (v) => ['OFF', 'GENTLE', 'STRONG'][Math.round(v)] || 'OFF',
  intensity: pct, bassGain: pct, reach: pct, bloom: pct,
  extrude: pct, rgb: pct, cuts: pct,
  echo: (v) => String(Math.round(v)),
  offset: (v) => (v > 0 ? '+' : '') + Math.round(v) + ' ms',
};

const DEFAULTS = {
  intensity: 1, bassGain: 1, offset: 0, reach: 1, bloom: 1,
  extrude: 1, echo: 5, rgb: 1, cuts: 1, colorSrc: 'art',
  // 0 off · 1 gentle · 2 strong. Off by default because the visualizer is
  // meant to react — but the setting exists, and the README says so.
  safeFlash: 0,
};

/**
 * Presets that draw the lyrics themselves.
 *
 * These cannot share the screen with karaoke: both are rendering the same words
 * at the same moment, and the result is not a layered effect, it is two texts
 * on top of each other that you can read neither of.
 */
const LYRIC_PRESETS = ['kinetic-type', 'video-edit'];

/** The full key map, shown in settings so it is not folklore. */
const SHORTCUTS = [
  { k: '1 – 9, 0', d: 'Pick a preset' },
  { k: 'F', d: 'Fullscreen' },
  { k: 'ESC', d: 'Leave fullscreen, or close a panel' },
  { k: 'K', d: 'Karaoke' },
  { k: 'L', d: 'Lyric sheet' },
  { k: 'S', d: 'Settings' },
  { k: 'D', d: 'Diagnostics' },
  { k: 'M', d: 'Minimise to the tray' },
  { k: 'G', d: 'Shaders / CSS renderer' },
  { k: 'B', d: 'Cover behind the lyric sheet' },
  { k: 'SPACE', d: 'Play or pause' },
  { k: '← →', d: 'Previous or next track' },
  { k: '[  ]', d: 'Nudge lyric timing by 50 ms' },
  { k: '\\', d: 'Auto-align lyrics to the vocal' },
];

const TOUR = [
  { t: 'Eleven looks, one dock', b: 'The strip along the bottom switches the visualizer. Every thumbnail is live, so you can see what each one is doing before you pick it — and any .frag file you drop in the shaders folder joins the strip on its own.', k: 'KEYS 1 – 9, 0' },
  { t: 'The cover opens up', b: 'Click the album art to drop into kinetic type, where lyric words land on the beat. L opens the full sheet to scroll the song and jump to any line. K is karaoke — the line fills in word by word as it is sung, with a count-in before you come in.', k: 'L FOR THE SHEET · K FOR KARAOKE' },
  { t: 'Take over the screen', b: 'Press F and the window drops its title bar and fills the monitor it is on, exactly, taskbar and all. Escape brings it back. It measures whatever display you put it on, so an ultrawide gets an ultrawide.', k: 'F FOR FULLSCREEN · ESC TO EXIT' },
  { t: 'Feed it real audio', b: 'ROOMTONE reads Windows loopback, so it reacts to anything your speakers are playing — Spotify, a game, a video. Real frequency bands and kick detection, measured live.', k: 'S FOR SETTINGS' },
];

const VARIANTS = [
  { id: 'lowerLeft', per: 2, max: 2, anchor: 'bl', fill: 0.40, maxH: 0.26, tilt: 0, align: 'flex-start', ink: '#fff', box: false, stroke: 0, lh: 0.9, track: '-0.01em' },
  { id: 'lowerCentre', per: 1, max: 2, anchor: 'bc', fill: 0.44, maxH: 0.28, tilt: 0, align: 'center', ink: '#fff', box: false, stroke: 0, lh: 0.88, track: '-0.01em' },
  { id: 'boxed', per: 1, max: 3, anchor: 'bl', fill: 0.30, maxH: 0.30, tilt: 0, align: 'flex-start', ink: '#fff', box: true, stroke: 0, lh: 1.05, track: '0.01em' },
  { id: 'solo', per: 1, max: 1, anchor: 'c', fill: 0.50, maxH: 0.24, tilt: -1.5, align: 'center', ink: '#fff', box: false, stroke: 0, lh: 0.9, track: '-0.02em', solo: true },
  { id: 'outline', per: 2, max: 2, anchor: 'bc', fill: 0.46, maxH: 0.26, tilt: 0, align: 'center', ink: 'transparent', box: false, stroke: 2, lh: 0.9, track: '0.02em' },
];

const CREDITS = [
  { name: 'Tauri', role: 'App shell, windowing, IPC, installer', repo: 'tauri-apps/tauri', url: 'https://github.com/tauri-apps/tauri' },
  { name: 'cpal', role: 'Audio I/O with WASAPI loopback backend', repo: 'RustAudio/cpal', url: 'https://github.com/RustAudio/cpal' },
  { name: 'RustFFT', role: 'FFT for spectrum analysis', repo: 'ejmahler/RustFFT', url: 'https://github.com/ejmahler/RustFFT' },
  { name: 'ringbuf', role: 'Lock-free hand-off from the audio callback', repo: 'agerasev/ringbuf', url: 'https://github.com/agerasev/ringbuf' },
  { name: 'LRCLIB', role: 'Free synchronised lyrics database', repo: 'tranxuanthang/lrclib', url: 'https://github.com/tranxuanthang/lrclib' },
  { name: 'rspotify', role: 'Spotify Web API client with PKCE', repo: 'ramsayleung/rspotify', url: 'https://github.com/ramsayleung/rspotify' },
  { name: 'keyring-rs', role: 'Token storage via Credential Manager', repo: 'hwchen/keyring-rs', url: 'https://github.com/hwchen/keyring-rs' },
  { name: 'color-thief', role: 'Dominant colour extraction from cover art', repo: 'RazrFalcon/color-thief-rs', url: 'https://github.com/RazrFalcon/color-thief-rs' },
  { name: 'image', role: 'Cover art decoding', repo: 'image-rs/image', url: 'https://github.com/image-rs/image' },
  { name: 'windows-rs', role: 'Win32 bindings for window shaping', repo: 'microsoft/windows-rs', url: 'https://github.com/microsoft/windows-rs' },
  { name: 'Cubensis', role: 'Reference for shader-based audio reactivity', repo: 'ginger-code/cubensis', url: 'https://github.com/ginger-code/cubensis' },
];

/**
 * The dock used fixed keys; presets are now whatever .frag files exist. These
 * aliases keep the CSS fallback layers — which are named after the original six
 * — working from the same crossfade weights.
 */
const LEGACY = {
  'edge-glow': 'glow',
  'art-bloom': 'bloom',
  'kinetic-type': 'type',
  'video-edit': 'edit',
  'spectrum-ring': 'spectrum',
  'flow-field': 'flow',
};

/** '#7c5cff' -> [0.49, 0.36, 1.0]. Shaders want components, not a string. */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0.49, 0.36, 1.0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Mix a colour toward black — the deep half of every gradient in the design. */
function shade(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#2a1160';
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.round(v * amount))
    .map((v) => v.toString(16).padStart(2, '0'));
  return `#${c.join('')}`;
}

class Roomtone {
  constructor(template, mount) {
    this.template = template;
    this.mount = mount;
    this.refs = {};

    this.state = {
      screen: 'onboard', preset: 'edge-glow',
      ix: 0, spotify: false, device: null, target: null,
      // What is actually being captured. Mirrors the Rust side, which is the
      // authority: a failed per-app capture falls back and this follows it.
      source: { kind: 'device', name: null },
      credits: false, settings: false, karaoke: false,
      lyrics: false, tray: false, debug: false, tour: 0,
      cfg: { ...DEFAULTS },
    };

    // Live data.
    this.audio = { bass: 0, mid: 0, high: 0, kick: 0, rms: 0, bpm: 0 };
    this.info = { running: false };
    this.np = null;
    this.npAt = 0;
    this.lyrics = null;     // { track_id, lines[], source }
    this.typography = new Typography();
    this.trackOffset = 0;   // per-track lyric offset in ms, remembered
    this.energyLog = [];    // vocal-band rises, for auto-align
    this.toast = null;
    this.toastUntil = 0;
    this.lyricArt = true;   // cover behind the lyric sheet
    this.fullscreen = false;
    this.flatWords = [];    // every word, flattened, for the kinetic type stack
    this.coverUrl = null;
    this.coverFor = null;
    this.deviceNames = [];
    this.apps = [];          // applications with an audio session right now
    this.displays = [];
    this.transportError = null;

    // Shaders
    this.presets = [];          // parsed .frag presets, dock order
    this.params = {};           // presetId -> { key: value }
    this.shaderError = null;
    this.useShaders = true;
    this.stamps = '';

    // Which overlays are mid-exit. Not in `state`: it is animation bookkeeping,
    // not something the app reasons about.
    this.closing = {};

    this.pos = 0;
    this.beatClock = 0;
    this.chromeUntil = 0;
    this.n = {};
  }

  /* -- state and rendering ---------------------------------------------- */

  setState(patch, done) {
    Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    this.draw();
    if (done) done();
  }

  draw() {
    this.refs = {};
    const tree = render(this.template, this.renderVals(), this.refs);
    this.mount.replaceChildren(tree);
    this.root = tree;
    this.cache();
    this.sync();
  }

  /* -- live data --------------------------------------------------------- */

  /** The current track, in the shape the render loop expects. */
  track() {
    const np = this.np;
    const accent = (np && np.accent) || PROPS.accent;
    // A second colour from the artwork when there is one. Falling back to a
    // darkened copy of the lead is the old behaviour and still the right
    // fallback — but a darkened copy reads as a shadow, and two real colours
    // out of the same cover read as the artwork itself.
    const second = (np && np.accent2) || shade(accent, 0.28);
    return {
      title: (np && np.name) || 'Nothing playing',
      artist: (np && np.artists) || (np && np.connected ? 'Press play in Spotify' : 'Spotify not connected'),
      dur: np && np.duration_ms ? np.duration_ms / 1000 : 1,
      a: accent,
      a2: second,
      deep: (np && np.deep) || shade(accent, 0.12),
      // Path C. Absent for most tracks, which is why the art-bloom fallback is
      // a designed state rather than an error.
      lyr: this.lyrics && this.lyrics.lines.length ? this.lyrics.lines : null,
    };
  }

  accent() {
    return this.track().a;
  }

  /** The cover's second hue. */
  accent2() {
    return this.track().a2;
  }

  /** Replaces the prototype's Web Audio analyser. Same contract. */
  readAudio() {
    if (!this.info.running) return null;
    return this.audio;
  }

  /* -- lyrics -------------------------------------------------------------- */

  async setLyrics(payload) {
    if (payload && payload.track_id) {
      try {
        this.trackOffset = (await invoke('lyric_offset_get', { trackId: payload.track_id })) || 0;
      } catch (e) { this.trackOffset = 0; }
    }
    this.applyLyrics(payload);
  }

  applyLyrics(payload) {
    this.lyrics = payload && payload.lines && payload.lines.length ? payload : null;
    this.flatWords = [];
    if (this.lyrics) {
      for (const line of this.lyrics.lines) {
        for (const w of line.words) this.flatWords.push(w);
      }
    }
    this.draw();
  }

  /**
   * Ask for the current track's lyrics directly.
   *
   * The event fires exactly once per track, which makes it a single point of
   * failure: miss it and the window claims the song has no lyrics for as long
   * as it plays. This is the same data, pulled rather than pushed, so a missed
   * event costs a few seconds instead of the whole feature.
   */
  async pullLyrics() {
    const id = this.np && this.np.track_id;
    if (!id) return;
    if (this.lyrics && this.lyrics.track_id === id) return;
    try {
      const payload = await invoke('lyrics_current');
      if (payload && payload.track_id === id) this.setLyrics(payload);
    } catch (e) {
      /* the Rust side has not resolved it yet; the next poll will ask again */
    }
  }

  /**
   * Playback position for lyric purposes.
   *
   * Three corrections stack here. The global slider is taste. The per-track
   * value is memory — most drift lives in the LRC file itself, so it belongs to
   * the track, not the app. The poll correction is physics: Spotify's reported
   * position was true when the server read it, and the reply took time to
   * arrive, so half the round trip has already elapsed.
   */
  lyricPos() {
    // The whole round trip, not half of it. Spotify samples the position when
    // it begins handling the request, so by the time the reply lands the track
    // has moved on by the full poll time, not half.
    const pollLag = this.np && this.np.poll_ms ? this.np.poll_ms / 1000 : 0;
    return this.pos + pollLag + REPORT_LAG + ((this.state.cfg.offset || 0) + this.trackOffset) / 1000;
  }

  say(message) {
    this.toast = message;
    this.toastUntil = performance.now() + 2200;
  }

  /** Nudge this track's offset and remember it. */
  async nudge(ms) {
    this.trackOffset = Math.max(-4000, Math.min(4000, this.trackOffset + ms));
    this.say(`LYRIC OFFSET ${this.trackOffset > 0 ? '+' : ''}${Math.round(this.trackOffset)} MS`);
    const id = this.np && this.np.track_id;
    if (id) invoke('lyric_offset_set', { trackId: id, ms: Math.round(this.trackOffset) }).catch(() => {});
  }

  /**
   * Estimate this track's offset from the audio.
   *
   * ROOMTONE cannot hear words — recognising sung lyrics in a full mix is a
   * research problem, not a feature. But it can hear *when* the vocal band
   * jumps, and a line of lyrics almost always starts on one of those jumps. So
   * this slides the whole lyric sheet across a ±3 second window and keeps the
   * lag where line starts land on the most vocal-band rises.
   *
   * It needs about twenty seconds of a sung passage to have anything to work
   * with, which is why it is a key press rather than something automatic.
   */
  autoAlign() {
    if (!this.lyrics || this.energyLog.length < 120) {
      this.say('AUTO-SYNC NEEDS ~20s OF SINGING FIRST');
      return;
    }

    const log = this.energyLog;
    const from = log[0].t, to = log[log.length - 1].t;
    const starts = this.lyrics.lines
      .filter((l) => l.text)
      .map((l) => l.t)
      .filter((t) => t > from - 3 && t < to + 3);

    if (starts.length < 4) {
      this.say('NOT ENOUGH LINES IN THIS PASSAGE');
      return;
    }

    // Bucket the rises at 50ms so scoring a lag is a lookup, not a scan.
    const STEP = 0.05;
    const buckets = new Map();
    for (const sample of log) {
      const key = Math.round(sample.t / STEP);
      buckets.set(key, Math.max(buckets.get(key) || 0, sample.d));
    }

    let best = 0, bestScore = -1;
    for (let lag = -3.0; lag <= 3.0; lag += STEP) {
      let score = 0;
      for (const t of starts) {
        const key = Math.round((t + lag) / STEP);
        // Look a little either side: a singer does not start exactly on the
        // millisecond the file claims.
        for (let d = -2; d <= 2; d++) score += buckets.get(key + d) || 0;
      }
      if (score > bestScore) { bestScore = score; best = lag; }
    }

    // A flat correlation means there was nothing to lock onto — say so rather
    // than confidently applying noise.
    if (bestScore <= 0) {
      this.say('AUTO-SYNC FOUND NOTHING TO LOCK ONTO');
      return;
    }

    this.trackOffset = Math.round(-best * 1000);
    this.say(`AUTO-SYNC ${this.trackOffset > 0 ? '+' : ''}${this.trackOffset} MS`);
    const id = this.np && this.np.track_id;
    if (id) invoke('lyric_offset_set', { trackId: id, ms: this.trackOffset }).catch(() => {});
  }

  async seekTo(seconds) {
    this.pos = seconds;
    this.npAt = performance.now();
    if (this.np) this.np.progress_ms = seconds * 1000;
    await this.control('seek', Math.max(0, Math.round(seconds * 1000)));
  }

  /* -- shader presets ---------------------------------------------------- */

  async loadPresets() {
    let files;
    try {
      files = await invoke('shader_presets');
    } catch (e) {
      this.shaderError = String(e);
      return;
    }

    const errors = [];
    this.presets = files.map(parsePreset);

    for (const preset of this.presets) {
      if (!this.params[preset.id]) {
        this.params[preset.id] = Object.fromEntries(preset.params.map((p) => [p.key, p.value]));
      }
      const err = this.gl.load(preset);
      if (err) errors.push(`${preset.file}: ${err.split('\n')[0]}`);
    }

    this.shaderError = errors.length ? errors.join(' · ') : null;
    if (this.shaderError) console.warn('[roomtone] shader:', this.shaderError);

    // If the current preset is gone (renamed, deleted), fall back to the first.
    if (!this.presets.some((p) => p.id === this.state.preset) && this.presets.length) {
      this.state.preset = this.presets[0].id;
    }
    this.draw();
  }

  async checkShaders() {
    let stamps;
    try {
      stamps = await invoke('shader_stamps');
    } catch (e) {
      return;
    }
    const key = stamps.map((s) => `${s.file}@${s.mtime}`).join('|');
    if (key === this.stamps) return;
    this.stamps = key;
    await this.loadPresets();
  }

  /** Hand the cover to the GPU once per track, not once per frame. */
  applyCoverTexture() {
    if (!this.coverUrl) { this.gl.uploadCover(null); return; }
    const img = new Image();
    img.onload = () => this.gl.uploadCover(img);
    img.src = this.coverUrl;
  }

  async pullCover() {
    const np = this.np;
    if (!np || !np.cover_cached) {
      if (this.coverUrl) {
        this.coverUrl = null;
        this.coverFor = null;
        this.gl.uploadCover(null);
        this.sync();
      }
      return;
    }
    if (this.coverFor === np.cover_cached) return;
    if (this.coverPending === np.cover_cached) return;
    this.coverPending = np.cover_cached;

    try {
      const url = await invoke('cover_data_url', { path: np.cover_cached });
      // Only latch on success. Latching the path before the call meant one
      // transient failure marked that track as coverless for as long as it
      // played — the request was never retried.
      this.coverFor = np.cover_cached;
      this.coverUrl = url;
      this.applyCoverTexture();
      this.sync();
    } catch (e) {
      console.warn('[roomtone] cover:', e);
      this.coverUrl = null;
      this.coverFor = null;
    } finally {
      this.coverPending = null;
    }
  }

  async control(action, positionMs) {
    try {
      this.transportError = null;
      await invoke('spotify_control', { action, positionMs: positionMs ?? null });
    } catch (e) {
      this.transportError = String(e);
      this.draw();
    }
  }

  /* -- values the template binds against --------------------------------- */

  renderVals() {
    const s = this.state, t = this.track();
    const np = this.np;
    const set = (k, v) => () => this.setState({ [k]: v });
    const playing = !!(np && np.is_playing);

    const src = s.source || { kind: 'device' };
    const devices = (this.deviceNames.length ? this.deviceNames : ['Default output']).map((name, i) => ({
      v: 'dev' + i,
      label: name.length > 22 ? name.slice(0, 21) + '…' : name,
      sub: src.kind === 'device' && src.name === name && this.info.running
        ? `LOOPBACK · ${(this.info.sample_rate / 1000).toFixed(1)} KHZ`
        : 'WASAPI LOOPBACK',
      on: () => this.pickSource({ kind: 'device', name }, 'dev' + i),
    }));

    const appSources = this.apps.map((a) => ({
      v: 'app:' + a.exe.toLowerCase(),
      label: a.name.length > 22 ? a.name.slice(0, 21) + '…' : a.name,
      sub: a.active ? 'PLAYING NOW' : 'IDLE',
      on: () => this.pickSource({ kind: 'app', exe: a.exe, name: a.name }, 'app:' + a.exe.toLowerCase()),
    }));

    const targets = this.displays.map((d, i) => ({
      v: 'disp' + i,
      label: d.primary ? `${d.name} · primary` : d.name,
      sub: `${d.width} × ${d.height}${d.scale !== 1 ? ` · ${Math.round(d.scale * 100)}%` : ''}`,
      mode: 'FULL',
      on: () => { this.setState({ target: 'disp' + i }); this.saveSoon(); },
    }));

    return {
      rootRef: 'rootRef',
      isOnboard: s.screen === 'onboard',
      isClub: s.screen === 'player',
      specBars: Array.from({ length: 56 }, (_, i) => i),
      spotifyOn: s.spotify, spotifyOff: !s.spotify,
      playing, paused: !playing,
      bars: Array.from({ length: 56 }, (_, i) => i),
      slots: [0, 1, 2, 3, 4],
      devices,
      appSources,
      hasApps: appSources.length > 0,
      noApps: appSources.length === 0,
      refreshApps: () => this.loadApps(),
      switches: this.switches(),
      shortcuts: SHORTCUTS,
      targets,
      // The dock is whatever .frag files exist — the six built-ins plus
      // anything in %APPDATA%/roomtone/shaders.
      presets: this.presets.map((preset) => ({
        v: preset.id,
        label: preset.name.toUpperCase(),
        on: () => this.choosePreset(preset.id),
      })),
      echoes: [0, 1, 2, 3, 4, 5, 6],
      editRows: [0, 1, 2],
      isPlayer: s.screen === 'player',
      showTray: s.screen === 'player' && (s.tray || !!this.closing.tray),
      openTray: () => this.openOverlay('tray'),
      closeTray: () => this.closeOverlay('tray'),
      trayBars: Array.from({ length: 18 }, (_, i) => i),
      showDebug: s.screen === 'player' && (s.debug || !!this.closing.debug),
      closeDebug: () => this.closeOverlay('debug'),
      debugRows: [
        { id: 'fps', k: 'RENDER' },
        { id: 'frame', k: 'FRAME TIME' },
        { id: 'cap', k: 'CAPTURE' },
        { id: 'fft', k: 'ANALYSIS' },
        { id: 'total', k: 'TOTAL LATENCY' },
        { id: 'bpm', k: 'DETECTED BPM' },
        { id: 'src', k: 'SOURCE' },
      ],
      bandMeters: [{ id: 'bass', k: 'BASS' }, { id: 'mid', k: 'MID' }, { id: 'high', k: 'HIGH' }],
      shaderFiles: this.presets.map((preset) => ({
        name: preset.file,
        kind: preset.kind,
        uni: `${preset.params.length} PARAM${preset.params.length === 1 ? '' : 'S'}`,
      })),
      openShaderDocs: () => invoke('open_shader_folder').catch(() => {}),
      showLyrics: s.lyrics || !!this.closing.lyrics,
      openLyrics: () => this.openOverlay('lyrics'),
      openKaraoke: () => this.setKaraoke(!s.karaoke),
      closeLyrics: () => this.closeOverlay('lyrics'),
      hasLyrics: !!t.lyr,
      noLyrics: !t.lyr,
      lyricLines: (t.lyr || [])
        .filter((line) => line.text)
        .map((line, i) => ({
          i,
          time: this.mmss(line.t),
          text: line.text,
          on: () => this.seekTo(line.t),
        })),
      showTour: s.screen === 'player' && s.tour >= 0 && s.tour < TOUR.length,
      tourDots: TOUR.map((_, i) => ({ i })),
      nextTour: () => this.setState({ tour: s.tour + 1 }),
      endTour: () => this.setState({ tour: -1 }),
      cfgGroups: this.cfgGroups(),
      colorOpts: [
        { v: 'art', label: 'ALBUM ART', on: () => this.setCfg('colorSrc', 'art') },
        { v: 'fixed', label: 'FIXED', on: () => this.setCfg('colorSrc', 'fixed') },
      ],
      openSettings: () => this.setState({ settings: true }),
      closeSettings: () => this.setState({ settings: false }),
      resetCfg: () => this.setState({ cfg: { ...DEFAULTS } }),
      showCredits: s.credits || !!this.closing.credits,
      credits: CREDITS.map((c) => ({
        ...c,
        open: (e) => {
          e.preventDefault();
          invoke('open_external', { url: c.url }).catch(() => {});
        },
      })),
      openCredits: () => this.openOverlay('credits'),
      closeCredits: () => this.closeOverlay('credits'),
      connect: () => this.connectSpotify(),
      launch: () => {
        if (this.state.spotify && this.state.device && this.state.target) {
          this.configured = true;
          this.setState({ screen: 'player' });
          this.saveNow();
        }
      },
      autostartOn: !!this.autostart,
      toggleAutostart: () => this.toggleAutostart(),
      toggle: () => this.control(playing ? 'pause' : 'play'),
      toggleLyrics: () => this.setState({ preset: s.preset === 'type' ? 'bloom' : 'type' }),
      prev: () => this.control('previous'),
      next: () => this.control('next'),
      trackTitle: t.title,
    };
  }

  async connectSpotify() {
    const status = await invoke('spotify_connect');
    this.setState({ spotify: !!status.connected });
  }

  /**
  /** Borderless fullscreen. No title bar over a visualizer. */
  async setFullscreen(on) {
    try {
      await invoke('set_fullscreen', { on });
      this.fullscreen = on;
      if (on) this.say('FULLSCREEN · ESC TO EXIT');
    } catch (e) {
      this.say(String(e).toUpperCase().slice(0, 70));
    }
  }

  /**
   * Is there a CSS layer that can stand in for this preset?
   *
   * G exists so the shaders can be compared against the hand-written CSS they
   * replaced — but only the original six ever had a CSS version. The presets
   * added since are shader-only, and switching the renderer off under one of
   * them left a black screen with no explanation. LEGACY is the list of presets
   * that have a CSS twin, so it is also the honest answer to this question.
   */
  hasFallback(id) {
    return !!LEGACY[id];
  }

  /**
   * Pick a preset. Clicking a shader-only one while the CSS renderer is on is a
   * request for shaders, not a dead end — so turn them back on rather than
   * showing nothing and letting the user work out why.
   */
  choosePreset(id) {
    // The reciprocal of the swap above: asking for the typography while karaoke
    // is open is asking for karaoke to get out of the way, not for both.
    if (this.state.karaoke && LYRIC_PRESETS.includes(id)) {
      this.karaokeFrom = null;
      this.karaokeTo = null;
      this.setState({ karaoke: false });
    }
    if (!this.hasFallback(id) && !this.useShaders) {
      this.useShaders = true;
      this.say('SHADERS ON · THIS ONE HAS NO CSS VERSION');
    }
    this.setState({ preset: id });
    this.saveSoon();
  }

  pickPreset(index) {
    const preset = this.presets[index];
    if (preset) this.choosePreset(preset.id);
  }

  setCfg(k, v) {
    this.setState((s) => ({ cfg: { ...s.cfg, [k]: v } }));
  }

  /**
   * Slider drags update the value in place and never re-render.
   *
   * They used to go through setState, which rebuilt the whole panel on every
   * input event — so the input under the cursor was destroyed mid-drag. The
   * drawer appeared to slam shut and reopen, and the drag turned into a text
   * selection across the window. A continuous control must never be replaced
   * while it is being held.
   */
  setCfgLive(key, value) {
    if (key.startsWith('p:')) {
      const [, id, name] = key.split(':');
      (this.params[id] || (this.params[id] = {}))[name] = value;
    } else {
      this.state.cfg[key] = value;
    }
    this.saveSoon();
    const fmt = key.startsWith('p:') ? null : FORMATTERS[key];
    this.each('sliderVal', (e) => {
      if (e.getAttribute('data-k') === key) e.textContent = fmt ? fmt(value) : value.toFixed(2);
    });
  }

  cfgGroups() {
    const c = this.state.cfg, P = this.state.preset;
    const R = (key, label, min, max, step, hint) => ({
      key, label, min, max, step, value: c[key], hint,
      display: FORMATTERS[key] ? FORMATTERS[key](c[key]) : c[key].toFixed(2),
      on: (e) => this.setCfgLive(key, parseFloat(e.target.value)),
    });

    const groups = [{
      title: 'MASTER',
      rows: [
        R('intensity', 'Intensity', 0.2, 1.6, 0.05, 'Overall reaction depth. Drop to ~0.4 for something calmer.'),
        R('bassGain', 'Bass weight', 0.3, 2, 0.05, 'How much low end drives the motion versus mids and highs.'),
        R('safeFlash', 'Flash guard', 0, 2, 1, 'Off · Gentle · Strong. Limits how fast and how far the whole screen can change brightness. Reduces, but cannot eliminate, flashing — see the photosensitivity note in the README.'),
      ],
    }];
    // The active preset's sliders come from its own file header. Nothing is
    // registered anywhere: add an @param line to a .frag and a slider appears.
    const active = this.presets.find((x) => x.id === P);
    if (active && active.params.length) {
      const store = this.params[active.id] || (this.params[active.id] = {});
      groups.push({
        title: active.name.toUpperCase(),
        rows: active.params.map((param) => {
          const key = `p:${active.id}:${param.key}`;
          const value = store[param.key] ?? param.value;
          return {
            key,
            label: param.label,
            min: param.min,
            max: param.max,
            step: param.step,
            value,
            hint: `${param.key} · ${param.min} to ${param.max}`,
            display: value.toFixed(2),
            on: (e) => this.setCfgLive(key, parseFloat(e.target.value)),
          };
        }),
      });
    }
    groups.push({ title: 'LYRICS', rows: [R('offset', 'Timing offset', -1000, 1000, 10, 'Nudge lyrics if they run ahead of or behind the audio.')] });
    return groups;
  }

  /* -- node cache and one-shot styling ----------------------------------- */

  cache() {
    const r = this.root;
    this.n = {};
    if (!r) return;
    ['edge', 'bar', 'word', 'bloom', 'stage', 'cover', 'ring', 'prog', 'tcur', 'tdur', 'chrome', 'lyrLayer', 'nolyr', 'barsRow', 'chip', 'launch', 'pbtn', 'title', 'artist', 'devlabel',
      'editLayer', 'editBg', 'editStage', 'editStack', 'erow', 'echo', 'livetag',
      'playerFrame', 'panel', 'slider', 'sliderVal', 'csrc', 'kbhint',
      'editArt', 'editArtTex', 'editScan', 'editMeta',
      'specLayer', 'specRing', 'specHalo', 'sbar', 'flowCanvas', 'pthumb', 'pfx', 'plabel', 'ponly', 'idleTag', 'stageWrap',
      'autoBtn', 'autoTrack', 'autoKnob', 'srcNow', 'swBtn', 'swTrack', 'swKnob',
      'coverTag', 'lyrBloom', 'lyrScroll', 'lyrLine', 'lyrText', 'lyrTime', 'tourNum', 'tourTitle', 'tourBody', 'tourKeys', 'tourNext', 'tdot',
      'trayGlow', 'trayIcon', 'dbg', 'meter', 'shDot', 'dbgPanel'].forEach((k) => {
      this.n[k] = Array.from(r.querySelectorAll('[data-r="' + k + '"]'));
    });
  }

  each(k, fn) { (this.n[k] || []).forEach(fn); }

  sync() {
    const r = this.root, s = this.state;
    if (!r) return;
    const t = this.track(), acc = this.accent();

    if (this._canvasOn) r.style.background = 'transparent';
    r.style.setProperty('--a', acc);
    r.style.setProperty('--a2', t.a2);
    // The dark ground, taken from the cover's own hue rather than being flat
    // grey — so even the black behind the visual belongs to the record.
    r.style.setProperty('--deep', t.deep);

    this.each('title', (e) => { e.textContent = t.title; });
    this.each('artist', (e) => { e.textContent = t.artist; });
    this.each('tdur', (e) => { e.textContent = this.mmss(t.dur); });
    this.each('devlabel', (e) => {
      e.textContent = 'LOOPBACK · ' + (this.info.device || 'DEFAULT OUTPUT').toUpperCase();
    });

    // Real cover art, where the prototype had a gradient.
    const art = this.coverUrl;
    this.each('cover', (e) => {
      e.style.backgroundImage = art ? `url("${art}")` : '';
      e.style.backgroundSize = 'cover';
      e.style.backgroundPosition = 'center';
    });
    this.each('editArt', (e) => {
      e.style.backgroundImage = art ? `url("${art}")` : '';
      e.style.backgroundSize = 'cover';
      e.style.backgroundPosition = 'center';
    });
    this.each('coverTag', (e) => { e.style.display = art ? 'none' : ''; });

    // The lyric sheet, with the cover behind it. Held well back — the sheet is
    // for reading, and a bright photo behind body text is unreadable.
    this.each('lyrBloom', (e) => {
      if (art && this.lyricArt) {
        e.style.backgroundImage = `url("${art}")`;
        e.style.backgroundSize = 'cover';
        e.style.backgroundPosition = 'center';
        e.style.filter = 'blur(46px) saturate(1.25) brightness(0.5)';
        e.style.opacity = '0.5';
      } else {
        e.style.backgroundImage = '';
        e.style.filter = 'blur(120px) saturate(1.3)';
        e.style.opacity = '0.22';
      }
    });

    this.each('chip', (e) => {
      const v = e.getAttribute('data-v'), grp = e.getAttribute('data-g') || 'device';
      const on = s[grp] === v;
      e.style.borderColor = on ? acc : 'rgba(255,255,255,0.12)';
      e.style.background = on ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)';
      e.style.color = on ? '#fff' : 'rgba(255,255,255,0.62)';
    });
    this.each('pbtn', (e) => {
      const on = e.getAttribute('data-v') === s.preset;
      e.style.background = on ? 'rgba(255,255,255,0.12)' : 'transparent';
      e.style.color = on ? '#fff' : 'rgba(255,255,255,0.5)';
    });

    const src = s.source || { kind: 'device' };
    this.each('srcNow', (e) => {
      e.textContent = src.kind === 'app'
        ? 'LISTENING TO ' + String(src.name || '').toUpperCase() + ' ONLY'
        : 'LISTENING TO ' + String(src.name || 'THE DEFAULT OUTPUT').toUpperCase();
      e.style.color = src.kind === 'app' ? acc : 'rgba(255,255,255,0.72)';
    });

    // The switches read their state from the same places the keys do, so the
    // panel can never disagree with the keyboard.
    const swOn = {};
    for (const t of this.switches()) swOn[t.k] = t.on;
    this.each('swTrack', (e) => {
      e.style.background = swOn[e.getAttribute('data-v')] ? acc : 'rgba(255,255,255,0.12)';
    });
    this.each('swKnob', (e) => {
      e.style.transform = swOn[e.getAttribute('data-v')] ? 'translateX(16px)' : 'translateX(0)';
    });
    this.each('swBtn', (e) => {
      e.style.borderColor = swOn[e.getAttribute('data-v')] ? acc : 'rgba(255,255,255,0.10)';
    });

    const auto = !!this.autostart;
    this.each('autoTrack', (e) => { e.style.background = auto ? acc : 'rgba(255,255,255,0.12)'; });
    this.each('autoKnob', (e) => { e.style.transform = auto ? 'translateX(18px)' : 'translateX(0)'; });
    this.each('autoBtn', (e) => { e.style.borderColor = auto ? acc : 'rgba(255,255,255,0.12)'; });

    const T = TOUR[s.tour];
    if (T) {
      this.each('tourNum', (e) => { e.textContent = ('0' + (s.tour + 1)) + ' / 0' + TOUR.length; });
      this.each('tourTitle', (e) => { e.textContent = T.t; });
      this.each('tourBody', (e) => { e.textContent = T.b; });
      this.each('tourKeys', (e) => { e.textContent = T.k; });
      this.each('tourNext', (e) => { e.textContent = s.tour === TOUR.length - 1 ? 'START' : 'NEXT'; });
      this.each('tdot', (e) => {
        const on = +e.getAttribute('data-i') === s.tour;
        e.style.background = on ? acc : 'rgba(255,255,255,0.18)';
        e.style.transform = on ? 'scale(1.4)' : 'scale(1)';
      });
    }

    const ready = s.spotify && s.device && s.target;
    this.each('launch', (e) => {
      e.style.background = ready ? '#fff' : 'rgba(255,255,255,0.04)';
      e.style.color = ready ? '#0a0510' : 'rgba(255,255,255,0.35)';
      e.style.borderColor = ready ? '#fff' : 'rgba(255,255,255,0.10)';
      e.style.cursor = ready ? 'pointer' : 'default';
      e.style.boxShadow = ready ? '0 0 60px ' + acc : 'none';
    });
  }

  mmss(v) {
    const m = Math.floor(v / 60), sec = Math.floor(v % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  /* -- the render loop ---------------------------------------------------- */

  start() {
    this.onMove = () => { this.chromeUntil = performance.now() + 2800; };
    this.onKey = (e) => {
      const k = e.key.toLowerCase();
      const s = this.state;
      // Escape is the way out of fullscreen before it is anything else — a
      // borderless window with no title bar and no exit is a trap.
      if (k === 'escape' && this.fullscreen) { this.setFullscreen(false); return; }
      if (k === 'escape') {
        // Through setKaraoke so the typography preset comes back, and through
        // closeOverlay so each panel gets its exit rather than vanishing.
        if (s.karaoke) this.setKaraoke(false);
        this.closeOverlay('credits');
        this.closeOverlay('lyrics');
        this.closeOverlay('tray');
        this.closeOverlay('debug');
        if (s.settings) this.setState({ settings: false });
        return;
      }
      if (k === 'f') { this.setFullscreen(!this.fullscreen); return; }
      if (s.credits) return;
      if (s.tour >= 0 && s.tour < TOUR.length && s.screen === 'player') {
        if (k === 'enter' || k === ' ') { e.preventDefault(); this.setState({ tour: s.tour + 1 }); }
        return;
      }
      if (e.target && e.target.tagName === 'INPUT') return;
      if (k === 'l') { this.toggleOverlay('lyrics'); return; }
      if (k === 'k') { this.setKaraoke(!s.karaoke); return; }
      if (k === 'd') { this.toggleOverlay('debug'); return; }
      if (k === 'm') { this.toggleOverlay('tray'); return; }
      if (k === 's') { this.setState({ settings: !s.settings }); return; }
      // The comparison switch. The brief asks for each CSS layer to stay behind
      // a flag until its shader beats it — this is that flag, live.
      if (k === 'g') {
        this.useShaders = !this.useShaders;
        // Turning shaders off under a shader-only preset would black the screen.
        // Fall back to the first preset that has a CSS layer and say so.
        if (!this.useShaders && !this.hasFallback(s.preset)) {
          const fb = this.presets.find((x) => this.hasFallback(x.id));
          this.say('CSS FALLBACK · ' + ((fb && fb.name) || 'EDGE GLOW').toUpperCase());
          this.setState({ preset: fb ? fb.id : 'edge-glow' });
        } else {
          this.say(this.useShaders ? 'WEBGL2 SHADERS' : 'CSS FALLBACK · G TO RETURN');
          this.draw();
        }
        this.saveSoon();
        return;
      }
      if (k === '[') { this.nudge(-50); return; }
      if (k === ']') { this.nudge(50); return; }
      if (k === '\\') { this.autoAlign(); return; }
      if (k === 'b') { this.lyricArt = !this.lyricArt; this.sync(); this.saveSoon(); return; }
      if (k === ' ') { e.preventDefault(); this.control(this.np && this.np.is_playing ? 'pause' : 'play'); }
      // 1-9 then 0 for the tenth. The dock can hold more than ten presets —
      // user shaders land at the end — and those are picked by clicking.
      else if (k >= '0' && k <= '9') this.pickPreset(k === '0' ? 9 : Number(k) - 1);
      else if (k === 'arrowright') this.control('next');
      else if (k === 'arrowleft') this.control('previous');
    };
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('keydown', this.onKey);

    this.chromeUntil = performance.now() + 4000;
    this.last = performance.now();
    this.frame();
  }

  frame = () => {
    requestAnimationFrame(this.frame);

    const now = performance.now();

    const t0 = now;
    this.body();
    this.ftime = (this.ftime || 0) * 0.9 + (performance.now() - t0) * 0.1;
  };

  body = () => {
    const now = performance.now(), dt = Math.min(0.06, (now - this.last) / 1000);
    this.last = now;
    const s = this.state;
    if (s.screen !== 'player') { this.chromeUntil = now + 3000; return; }

    const t = this.track();
    const np = this.np;
    const playing = !!(np && np.is_playing);

    // Progress comes from Spotify, interpolated locally between polls.
    if (np && np.active) {
      const drift = playing ? (now - this.npAt) / 1000 : 0;
      this.pos = Math.min(np.progress_ms / 1000 + drift, t.dur);
    } else if (playing) {
      this.pos += dt;
    }

    // A beat clock derived from the *detected* tempo, so rotations and
    // oscillations keep musical time between kicks. Nothing here invents
    // amplitude — that all comes from the analyser.
    const bpm = this.audio.bpm > 40 ? this.audio.bpm : 120;
    if (playing || this.audio.rms > 1e-4) this.beatClock += dt * (bpm / 60);
    const beat = this.beatClock;
    const phrase = (beat / 32) % 1;

    const A = this.readAudio();
    let bass = A ? A.bass : 0;
    let mid = A ? A.mid : 0;
    let high = A ? A.high : 0;
    const kickNow = A ? A.kick : 0;

    const energy = bass * 0.55 + mid * 0.3 + high * 0.15;

    // Vocal-band rises, sampled at ~20 Hz and kept for the last 45 seconds.
    // This is what auto-sync correlates the lyric line starts against.
    if (playing && now - (this._logAt || 0) > 50) {
      this._logAt = now;
      const rise = Math.max(0, mid - (this._lastMid ?? mid));
      this._lastMid = mid;
      this.energyLog.push({ t: this.pos, d: rise });
      if (this.energyLog.length > 900) this.energyLog.shift();
    }
    const C = s.cfg;
    bass = Math.min(1.4, bass * C.bassGain);
    const modeK = 1;
    const k = C.intensity * PROPS.intensity * modeK;

    // Crossfade weights, one per preset. These drive both the CSS layers and
    // the shader pass, so switching renderers changes nothing about timing.
    const PW = this.pw || (this.pw = { glow: 0, bloom: 0, type: 0, edit: 0, spectrum: 0, flow: 0 });
    const lr = Math.min(1, dt * 8);
    for (const preset of this.presets) {
      if (!(preset.id in PW)) PW[preset.id] = 0;
      const want = preset.id === s.preset ? 1 : 0;
      let v = PW[preset.id] + (want - PW[preset.id]) * lr;
      if (Math.abs(v - want) < 0.02) v = want;
      PW[preset.id] = v;
    }
    for (const [id, legacy] of Object.entries(LEGACY)) PW[legacy] = PW[id] || 0;
    const P = s.preset, hasLyr = !!t.lyr;
    const acc = this.accent();

    // Overlays on their way out. They are still mounted only because
    // closeOverlay() is holding them there for exactly this.
    const leaving = (e, key, keyframes) => {
      if (!this.closing[key]) return;
      e.style.animation = keyframes;
      // A panel that is fading out must stop taking clicks immediately, or a
      // second click during the fade lands on something already dismissed.
      e.style.pointerEvents = 'none';
    };
    this.each('ovl', (e) => leaving(e, e.getAttribute('data-v'), 'rtleave 0.24s ease both'));
    this.each('dbgPanel', (e) => leaving(e, 'debug', 'rtleavedown 0.22s ease both'));

    // The settings drawer slides. It only *looks* like it slides because anim()
    // hands the freshly built node the position the old one had.
    this.each('panel', (e) => {
      this.anim(e, 'panel', 'transform', s.settings ? 'translateX(0)' : 'translateX(100%)');
    });

    // The settings drawer used to slide in over the top bar, hiding the mode
    // switch and half the transport. Give the panel its own room instead: the
    // stage narrows by exactly the drawer's width, on the drawer's own easing,
    // so the two read as one movement.
    this.each('playerFrame', (e) => { e.style.right = s.settings ? '372px' : '0px'; });
    this.each('csrc', (e) => {
      const on = e.getAttribute('data-v') === C.colorSrc;
      e.style.borderColor = on ? acc : 'rgba(255,255,255,0.12)';
      e.style.background = on ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)';
      e.style.color = on ? '#fff' : 'rgba(255,255,255,0.6)';
    });

    const glowMul = (PW.glow + PW.bloom * 0.4 + PW.type * 0.28 + PW.edit * 0.1 + PW.spectrum * 0.4 + PW.flow * 0.2) * C.reach;
    this.each('edge', (e, i) => {
      e.style.opacity = String((0.10 + bass * 0.72) * glowMul * k);
      e.style.transform = (i % 2 ? 'scaleX' : 'scaleY') + '(' + (0.5 + bass * 0.65) + ')';
    });

    const bloomMul = (PW.bloom * 0.62 + PW.type * (hasLyr ? 0.09 : 0.62) + PW.glow * 0.13 + PW.edit * 0.04 + PW.spectrum * 0.14 + PW.flow * 0.24) * C.bloom;
    this.each('bloom', (e) => { e.style.opacity = String(bloomMul * (0.45 + energy * 0.85) * k); });

    this.each('barsRow', (e) => { e.style.opacity = String(PW.glow * 0.9 + PW.bloom * 0.3 + PW.type * 0.1); });
    const N = (this.n.bar || []).length || 1;
    const barMax = P === 'edge-glow' ? 96 : 52;
    this.each('bar', (e, i) => {
      const n = i / (N - 1 || 1);
      const band = n < 0.32 ? bass : n < 0.7 ? mid : high;
      const w = 0.42 + 0.58 * Math.abs(Math.sin(i * 0.72 + beat * 1.3 + n * 4.2));
      e.style.height = Math.max(2, band * w * barMax * k) + '%';
      e.style.opacity = String(0.22 + band * 0.65);
    });

    this.each('ring', (e) => { e.style.transform = 'rotate(' + (beat * 14) + 'deg)'; });
    this.each('cover', (e) => {
      e.style.transform = 'scale(' + (1 + kickNow * 0.03 * k) + ')';
      e.style.boxShadow =
        '0 40px 120px rgba(0,0,0,0.7), 0 0 ' + (30 + bass * 130 * k) + 'px ' + acc;
    });

    const shrink = Math.max(PW.type * (hasLyr ? 1 : 0), PW.edit, PW.spectrum, PW.flow * 0.7);
    const stEl = (this.n.stage || [])[0], wrEl = (this.n.stageWrap || [])[0];
    if (stEl && wrEl) {
      const band = wrEl.clientHeight - 118 - (this._padB || 158);
      const nat = stEl.scrollHeight || 1;
      this._fitS = Math.max(0.4, Math.min(1, band / nat));
    }
    const fitS = this._fitS || 1;
    const bandH = Math.max(120, window.innerHeight - 118 - (this._padB || 126));
    const downPx = shrink * bandH * 0.25;
    this.each('stage', (e) => {
      e.style.transition = 'none';
      e.style.transform = 'translate(' + (-34 * shrink) + 'vw,' + downPx + 'px) scale(' + ((1 - 0.52 * shrink) * fitS) + ')';
      e.style.opacity = String(Math.max(0, 1 - PW.edit * 2.2));
      e.style.pointerEvents = PW.edit > 0.3 ? 'none' : 'auto';
    });

    this.each('prog', (e) => { e.style.width = (t.dur ? (this.pos / t.dur) * 100 : 0) + '%'; });
    this.each('tcur', (e) => { e.textContent = this.mmss(this.pos); });

    // Kinetic type. Words land one at a time and the ones before them stay,
    // shrinking and blurring back — so you read the phrase, not just the word.
    const W = this.flatWords;
    const lyrOn = PW.type > 0.02 && hasLyr;
    this.each('lyrLayer', (e) => { e.style.opacity = String(hasLyr ? PW.type : 0); });
    this.each('nolyr', (e) => { e.style.opacity = String(hasLyr ? 0 : PW.type); });

    if (W.length) {
      const lp = this.lyricPos();
      let ci = -1;
      for (let i = 0; i < W.length; i++) {
        if (W[i].t <= lp) ci = i;
        else break;
      }
      const cur = W[ci];

      // Attack: the fraction of the 200ms landing still to go.
      const att = cur ? Math.max(0, Math.min(1, 1 - (lp - cur.t) / 0.2)) : 0;

      // Between lines the type recedes and the bloom takes over, so an
      // instrumental passage does not leave a dead word on screen.
      const gap = cur ? lp - cur.t : 99;
      const gapFade = Math.max(0, Math.min(1, 1 - (gap - 1.6) / 1.4));

      if (lyrOn) {
        this.each('lyrLayer', (e) => {
          e.style.opacity = String((0.14 + gapFade * 0.86) * PW.type);
        });
        this.each('bloom', (e) => {
          const gapBloom = (0.09 + (1 - gapFade) * 0.5) * PW.type + bloomMul * (1 - PW.type);
          e.style.opacity = String(gapBloom * (0.45 + energy * 0.85) * k);
        });
      }

      const list = this.n.word || [];
      {
        const L = list.length;
        list.forEach((e, j) => {
          const age = L - 1 - j;
          const w = W[ci - age];
          e.textContent = w ? w.w : '';
          e.style.fontSize = 11.5 * Math.pow(0.66, age) + 'vw';
          e.style.opacity = String(Math.max(0, 1 - age * 0.22));
          if (age === 0) {
            e.style.filter = `blur(${att * 13}px)`;
            e.style.transform = `translateY(${att * 30}px) scale(${1 + kickNow * 0.05 * k + att * 0.12})`;
            e.style.color = '#fff';
            e.style.textShadow = `0 0 ${(24 + bass * 90 * k) * PW.type}px ${acc}`;
          } else {
            e.style.filter = `blur(${age * 1.8}px)`;
            e.style.transform = 'scale(1)';
            e.style.color = `rgba(255,255,255,${Math.max(0.12, 0.5 - age * 0.09)})`;
            e.style.textShadow = 'none';
          }
        });
      }
    }

    // The full sheet: current line lit, past lines dimmed, scrolled to centre.
    if (s.lyrics && hasLyr) {
      const lp = this.lyricPos();
      let ci = 0;
      t.lyr.forEach((line, i) => { if (line.t <= lp) ci = i; });

      (this.n.lyrLine || []).forEach((el, i) => {
        const txt = el.querySelector('[data-r="lyrText"]');
        const tm = el.querySelector('[data-r="lyrTime"]');
        const isCur = i === ci, past = i < ci;
        if (txt) {
          txt.style.color = isCur ? '#fff' : past ? '#8f8a99' : '#9d98a6';
          txt.style.fontWeight = isCur ? '700' : '500';
          txt.style.textShadow = isCur ? `0 0 ${20 + bass * 60}px ${acc}` : 'none';
        }
        if (tm) tm.style.color = isCur ? acc : '#77727f';
        el.style.background = isCur ? 'rgba(255,255,255,0.05)' : 'transparent';
      });

      const scroller = (this.n.lyrScroll || [])[0];
      const current = (this.n.lyrLine || [])[ci];
      if (scroller && current) {
        const want = current.offsetTop - scroller.clientHeight / 2 + current.offsetHeight / 2;
        scroller.scrollTop += (want - scroller.scrollTop) * Math.min(1, dt * 3);
      }
    }

    this.each('livetag', (e) => { e.style.opacity = A ? '1' : '0'; });

    const editOn = PW.edit > 0.02;
    this.each('editLayer', (e) => { e.style.opacity = String(PW.edit); });
    if (editOn) {
      const lp = this.lyricPos();
      let line = null, lineIndex = 0;
      if (hasLyr) {
        t.lyr.forEach((l, i) => { if (l.t <= lp && l.text) { line = l; lineIndex = i; } });
      }
      if (!line) {
        // No lyrics, or before the first line: the title takes the frame.
        const title = t.title === 'Nothing playing' ? 'ROOMTONE' : t.title;
        line = { t: 0, text: title, words: title.split(/\s+/).map((w, i) => ({ t: i, w })) };
        lineIndex = -1;
      }

      let wordIndex = 0;
      const words = line.words.length ? line.words : [{ t: line.t, w: line.text }];
      words.forEach((w, i) => { if (w.t <= lp) wordIndex = i; });
      if (lineIndex === -1) wordIndex = Math.floor(this.beatClock / 2) % words.length;

      this.typography.frame(this.n, {
        line: { ...line, words },
        lineIndex,
        wordIndex,
        now,
        kick: kickNow,
        bass,
        energy,
        accent: acc,
        cfg: C,
        intensity: k,
        padB: this._padB || 126,
      });
    }

    this.each('specLayer', (e) => { e.style.opacity = String(PW.spectrum); });
    if (PW.spectrum > 0.02) {
      const SB = this.n.sbar || [], SN = SB.length || 1;
      const ring = (this.n.specRing || [])[0];
      const R = ring ? ring.getBoundingClientRect().width * 0.23 : 160;
      SB.forEach((e, i) => {
        const n = i / SN;
        const band = n < 0.32 ? bass : n < 0.7 ? mid : high;
        const w2 = 0.4 + 0.6 * Math.abs(Math.sin(i * 0.8 + beat * 1.1));
        e.style.height = (14 + band * w2 * 200 * k) + 'px';
        e.style.transform = 'translate(-50%,0) rotate(' + (n * 360 + beat * 5) + 'deg) translateY(' + R + 'px)';
        e.style.opacity = String(0.3 + band * 0.7);
      });
      this.each('specHalo', (e) => {
        e.style.transform = 'scale(' + (1 + kickNow * 0.09 * k) + ')';
        e.style.boxShadow = '0 0 ' + (18 + bass * 90 * k) + 'px ' + acc + ', inset 0 0 ' + (14 + bass * 44) + 'px ' + acc;
      });
    }

    this.each('flowCanvas', (e) => { e.style.opacity = String(PW.flow); });
    if (PW.flow > 0.02) this.flowStep(dt, bass, high, energy, kickNow, acc, k);

    if (this._thumbAcc !== acc && (this.n.pfx || []).length) {
      this._thumbAcc = acc;
      const TH = {
        glow: 'radial-gradient(120% 90% at 50% 118%,' + acc + ', transparent 60%),radial-gradient(120% 90% at 50% -18%,' + acc + ', transparent 60%)',
        bloom: 'radial-gradient(58% 58% at 42% 44%,' + acc + ', transparent 70%),radial-gradient(46% 46% at 68% 64%, rgba(255,255,255,0.5), transparent 72%)',
        type: 'repeating-linear-gradient(to bottom, rgba(255,255,255,0.92) 0 4px, transparent 4px 12px)',
        edit: 'linear-gradient(135deg,#2a1160,' + acc + ' 58%,#120a24)',
        spectrum: 'conic-gradient(from 0deg,' + acc + ' 0 3deg, transparent 3deg 9deg)',
        flow: 'repeating-linear-gradient(58deg,' + acc + ' 0 1px, transparent 1px 7px)',
      };
      this.each('pfx', (e) => {
        const v = LEGACY[e.getAttribute('data-v')] || 'glow';
        e.style.background = TH[v] || '';
        e.style.inset = v === 'spectrum' ? '20%' : v === 'type' ? '28% 24%' : '0';
        e.style.borderRadius = v === 'spectrum' ? '50%' : '0';
        e.style.filter = v === 'edit' ? 'blur(3px)' : v === 'flow' ? 'blur(0.5px)' : 'none';
      });
    }
    this.each('pfx', (e) => {
      const w = PW[e.getAttribute('data-v')] || 0;

      e.style.opacity = String(Math.min(1, 0.3 + w * 0.36 + energy * 0.3));
    });
    this.each('pthumb', (e) => {
      const on = e.getAttribute('data-v') === P;
      e.style.borderColor = on ? acc : 'rgba(255,255,255,0.12)';
      e.style.boxShadow = on ? '0 0 0 1px ' + acc + ', 0 0 ' + (10 + bass * 26) + 'px ' + acc : 'none';
    });
    this.each('plabel', (e) => { e.style.color = e.getAttribute('data-v') === P ? '#fff' : '#9d98a6'; });

    // While the CSS renderer is on, the presets with no CSS twin say so on the
    // thumbnail rather than showing an empty rectangle.
    const cssOnly = !this.useShaders;
    this.each('ponly', (e) => {
      e.style.display = cssOnly && !this.hasFallback(e.getAttribute('data-v')) ? 'flex' : 'none';
    });
    this.each('pbtn', (e) => {
      const v = e.getAttribute('data-v');
      const typographic = LYRIC_PRESETS.includes(v);

      // Out of the dock rather than dimmed while karaoke is drawing: they are
      // not merely a bad idea then, they are unusable. But they fade first —
      // `display:none` on its own is the visual equivalent of a jump cut.
      if (typographic) {
        const hide = !!s.karaoke;
        e.style.transition = 'opacity 0.20s ease, transform 0.20s ease';
        this.anim(e, 'pbtn:' + v, 'opacity', hide ? '0' : '1');
        this.anim(e, 'pbtnT:' + v, 'transform', hide ? 'scale(0.86)' : 'none');

        // The reflow waits until the fade has finished, so the remaining tiles
        // slide once, after the disappearing ones are already invisible.
        clearTimeout((this._dockT || (this._dockT = {}))[v]);
        if (hide) {
          this._dockT[v] = setTimeout(() => { e.style.display = 'none'; }, 200);
        } else {
          e.style.display = '';
        }
        return;
      }

      e.style.opacity = cssOnly && !this.hasFallback(v) ? '0.45' : '1';
    });

    if (s.tray) {
      this.each('trayGlow', (e) => { e.style.opacity = String((0.3 + energy * 0.6) * 0.5); });
      this.each('trayIcon', (e) => { e.style.transform = 'scale(' + (1 + kickNow * 0.22) + ')'; });
    }

    this.fps = this.fps ? this.fps * 0.92 + (1 / Math.max(0.001, dt)) * 0.08 : 1 / Math.max(0.001, dt);
    if (s.debug) this.debugFrame(A, bass, mid, high);

    this.each('shDot', (e) => {
      e.style.background = e.getAttribute('data-v') === 'user' ? acc : 'rgba(255,255,255,0.3)';
    });

    const dock = (this.n.chrome || []).find((e) => e.getAttribute('data-r2') === 'dock');
    if (dock) {
      const rct = dock.getBoundingClientRect();
      const padB = Math.ceil(window.innerHeight - rct.top) + 24;
      if (padB > 0 && padB !== this._padB) {
        this._padB = padB;
        this.each('stageWrap', (e) => { e.style.paddingBottom = padB + 'px'; });
      }
    }

    // Karaoke draws over everything, shader included — the words are the point
    // and the visualizer is the stage they stand on. The centre panel steps out
    // of the way so the album art is not competing with the line being sung.
    this.karaokeFrame(acc, energy, kickNow, t);
    this.each('stageWrap', (e) => {
      e.style.transition = 'opacity 0.28s ease, transform 0.34s cubic-bezier(0.2,0.9,0.2,1)';
      this.anim(e, 'stageWrap', 'opacity', s.karaoke ? '0' : '1');
      // A slight drop as it leaves, so the cover reads as stepping back rather
      // than switching off.
      this.anim(e, 'stageWrapT', 'transform', s.karaoke ? 'translateY(10px) scale(0.98)' : 'none');
    });

    // ---- the shader pass ------------------------------------------------
    const shaded = this.useShaders && this.gl.ok;
    if (shaded) {
      // The CSS layers stay in the DOM but go dark. Flipping back with G is
      // instant, which is what makes an honest side-by-side possible.
      ['edge', 'bloom', 'specLayer', 'flowCanvas'].forEach((k) => {
        this.each(k, (e) => { e.style.opacity = '0'; });
      });
      this.renderShaders(PW, k, acc, now);
    }
    this.canvasVisible(shaded);

    // Transient message — offset nudges, auto-sync results.
    if (this.toast) {
      const left = this.toastUntil - now;
      if (left <= 0) {
        this.toast = null;
        if (this._toastEl) this._toastEl.style.opacity = '0';
      } else {
        if (!this._toastEl || !this._toastEl.isConnected) this._toastEl = this.makeToast();
        this._toastEl.textContent = this.toast;
        this._toastEl.style.opacity = String(Math.min(1, left / 400));
      }
    }

    const show = now < this.chromeUntil;
    if (!playing) { if (!this.pauseAt) this.pauseAt = now; } else this.pauseAt = 0;
    const resting = !show && !playing && this.pauseAt && now - this.pauseAt > 900;
    this.each('idleTag', (e) => { e.style.opacity = resting ? '1' : '0'; });
    this.each('chrome', (e, i) => {
      // Through anim(), keyed per chrome element, so the fade actually runs
      // rather than the element simply appearing already faded. The index is
      // the key because most of these carry no identifying attribute, and the
      // template emits them in a stable order.
      this.anim(e, 'chrome:' + (e.getAttribute('data-r2') || i), 'opacity', show ? '1' : '0');
      if (e.getAttribute('data-r2') !== 'dock') e.style.pointerEvents = show ? 'auto' : 'none';
      e.style.background = editOn ? 'rgba(6,4,12,0.88)' : 'transparent';
      e.style.borderRadius = editOn ? '10px' : '0';
      e.style.boxShadow = editOn ? '0 0 0 11px rgba(6,4,12,0.88)' : 'none';
    });
    if (this.root) this.root.style.cursor = show ? 'default' : 'none';
  };

  /**
   * One pass per preset with weight above the noise floor — normally one, two
   * during a crossfade. Both write into the same feedback buffer, so trails
   * carry across the transition instead of being cut and restarted.
   */
  /**
   * Photosensitivity guard.
   *
   * Applied to the *uniforms*, not inside any one shader. That placement is the
   * whole design: it covers all eleven presets and every shader a user writes
   * later, without asking a shader author to remember anything. A guard that
   * each preset had to opt into would protect the presets that needed it least.
   *
   * Two limits, because flashing has two dimensions:
   *
   *   * **Rate.** Photosensitive seizures are provoked mainly by full-screen
   *     changes in the 3–30 Hz band, worst around 15. The kick — the one signal
   *     that drives sudden whole-frame brightness — is put through a falling
   *     envelope, so a fast run of hits reads as one sustained push instead of
   *     a strobe.
   *   * **Depth.** Overall intensity is slew-limited, so no single frame can
   *     jump the screen from dark to bright.
   *
   * It cannot make an arbitrary shader safe — a preset is free to do anything
   * with `uTime` — but it removes the two mechanisms every built-in uses to
   * flash, and it is honest about being a reduction rather than a guarantee.
   */
  guard(kick, intensity, dt) {
    const level = Math.round(this.state.cfg.safeFlash || 0);
    if (level <= 0) {
      this.guardIntensity = intensity;
      return { kick, intensity };
    }

    const gentle = level === 1;

    // Falling envelope on the kick. It may rise instantly to the cap but only
    // decays at a fixed rate, so repeated hits cannot re-trigger a full swing.
    const cap = gentle ? 0.45 : 0.22;
    const fall = gentle ? 1.8 : 1.1;            // units per second
    const wanted = Math.min(kick, cap);
    const prev = this.guardKick || 0;
    const decayed = Math.max(0, prev - fall * dt);
    this.guardKick = Math.max(decayed, wanted);

    // Slew limit on intensity. At 60 fps, "gentle" allows the screen to travel
    // its full brightness range in about half a second, "strong" in one second.
    const slew = gentle ? 2.0 : 1.0;
    const target = intensity * (gentle ? 0.85 : 0.6);
    const held = this.guardIntensity ?? target;
    const step = slew * dt;
    this.guardIntensity = held + Math.max(-step, Math.min(step, target - held));

    return { kick: this.guardKick, intensity: this.guardIntensity };
  }

  renderShaders(PW, intensity, accent, now) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Cap total pixels rather than the ratio: a 4K display at dpr 2 would ask
    // for 33 megapixels a frame, and no preset needs that to look right.
    const wantW = Math.round(window.innerWidth * dpr);
    const wantH = Math.round(window.innerHeight * dpr);
    const budget = 1440 * 2560;
    const scale = Math.min(1, Math.sqrt(budget / Math.max(1, wantW * wantH)));
    this.gl.resize(Math.max(2, Math.round(wantW * scale)), Math.max(2, Math.round(wantH * scale)));

    const layers = [];
    for (const preset of this.presets) {
      const weight = PW[preset.id] || 0;
      if (weight <= 0.02) continue;
      layers.push({ preset, weight, params: this.params[preset.id] || {} });
    }
    if (!layers.length) return;

    const dt = Math.min(0.1, Math.max(0.001, (now - (this._shadeAt || now - 16)) / 1000));
    this._shadeAt = now;
    const safe = this.guard(this.audio.kick, intensity, dt);

    this.gl.draw(layers, {
      bass: this.audio.bass,
      mid: this.audio.mid,
      high: this.audio.high,
      kick: safe.kick,
      beat: this.beatClock,
      time: now / 1000,
      intensity: safe.intensity,
      art: hexToRgb(accent),
      art2: hexToRgb(this.accent2()),
    });
  }

  makeToast() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:50%;bottom:calc(var(--dock, 150px));transform:translateX(-50%);' +
      "z-index:60;padding:10px 18px;border-radius:999px;font-family:'Space Mono',monospace;" +
      'font-size:10.5px;letter-spacing:0.2em;color:#fff;background:rgba(7,5,13,0.86);' +
      'border:1px solid rgba(255,255,255,0.16);pointer-events:none;transition:opacity .2s ease';
    document.body.appendChild(el);
    return el;
  }

  canvasVisible(on) {
    // Never hand the screen over to a canvas that cannot draw: that is a black
    // rectangle where the interface used to be.
    if (on && (!this.gl || !this.gl.ok || (this.gl.gl && this.gl.gl.isContextLost()))) on = false;
    if (this._canvasOn === on) return;
    this._canvasOn = on;
    this.gl.canvas.style.opacity = on ? '1' : '0';
    // The app frame is opaque black by default. While the shaders are drawing
    // it has to get out of the way, or it paints over them.
    if (this.root) this.root.style.background = on ? 'transparent' : '#000';
  }





  /**
   * Everything that used to be reachable only by pressing an undocumented key.
   *
   * A shortcut nobody knows about is not a feature. Each of these still has its
   * key — muscle memory is worth keeping — but each is now also a switch you can
   * find by looking, and each reports its real state rather than a remembered
   * one.
   */
  switches() {
    const s = this.state;
    return [
      {
        k: 'shaders',
        label: 'WebGL shaders',
        key: 'G',
        hint: 'Off falls back to the hand-written CSS layers. Six presets have one; the rest are shader-only.',
        on: this.useShaders,
        go: () => {
          this.useShaders = !this.useShaders;
          if (!this.useShaders && !this.hasFallback(s.preset)) {
            const fb = this.presets.find((x) => this.hasFallback(x.id));
            this.setState({ preset: fb ? fb.id : 'edge-glow' });
          }
          this.saveSoon();
          this.draw();
        },
      },
      {
        k: 'karaoke',
        label: 'Karaoke',
        key: 'K',
        hint: 'The line being sung, filling in word by word, over the visualizer.',
        on: s.karaoke,
        go: () => this.setKaraoke(!s.karaoke),
      },
      {
        k: 'lyricArt',
        label: 'Cover behind lyrics',
        key: 'B',
        hint: 'Album art washed in behind the lyric sheet.',
        on: this.lyricArt,
        go: () => { this.lyricArt = !this.lyricArt; this.saveSoon(); this.sync(); },
      },
      {
        k: 'debug',
        label: 'Diagnostics overlay',
        key: 'D',
        hint: 'Measured frame time, capture latency, FFT cost and detected tempo. Every number is read, none is estimated.',
        on: s.debug,
        go: () => this.toggleOverlay('debug'),
      },
    ].map((t) => ({ ...t, state: t.on ? 'ON' : 'OFF' }));
  }


  /* -- motion -------------------------------------------------------------- */

  /**
   * Set a style that is supposed to animate, on a DOM that is rebuilt every
   * time state changes.
   *
   * This is the fix for the whole class of "why is nothing smooth" problems.
   * `draw()` replaces the entire tree, so every element `sync()` touches is a
   * brand-new node — and a brand-new node has no previous value for CSS to
   * interpolate from. Every `transition` in the stylesheet was therefore doing
   * nothing at all: the panel was simply created already at its destination.
   *
   * So remember what was last set for a given logical element, give the new
   * node that old value with transitions switched off, force the browser to
   * accept it, and only then set the target. The transition has something to
   * come from and runs properly.
   */
  anim(el, key, prop, value) {
    const mem = this.animMem || (this.animMem = new Map());
    const was = mem.get(key);
    if (was !== undefined && was !== value) {
      const keep = el.style.transition;
      el.style.transition = 'none';
      el.style[prop] = was;
      // Reading a layout property forces the browser to commit the value above
      // before the one below — without this both land in the same frame and
      // the transition is skipped again.
      void el.offsetWidth;
      el.style.transition = keep;
    }
    el.style[prop] = value;
    mem.set(key, value);
  }

  /**
   * Overlays that are removed from the DOM when closed need to survive long
   * enough to fade.
   *
   * `data-if` deletes the subtree the moment the flag goes false, which is why
   * closing anything was instant while opening was animated. The flag going
   * false now only starts the exit: the overlay stays mounted, marked as
   * leaving, until the animation has run.
   */
  closeOverlay(key, ms = 240) {
    if (!this.state[key]) return;
    const timers = this._closeTimers || (this._closeTimers = {});
    this.closing[key] = true;
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      this.closing[key] = false;
      this.draw();
    }, ms);
    this.setState({ [key]: false });
  }

  openOverlay(key) {
    const timers = this._closeTimers || (this._closeTimers = {});
    clearTimeout(timers[key]);
    this.closing[key] = false;
    this.setState({ [key]: true });
  }

  /** Open if closed, start closing if open. */
  toggleOverlay(key, ms) {
    if (this.state[key]) this.closeOverlay(key, ms);
    else this.openOverlay(key);
  }

  /* -- what we are listening to ------------------------------------------- */

  /** Applications with an audio session, newest state each time it is asked. */
  async loadApps() {
    try {
      this.apps = (await invoke('audio_apps')) || [];
    } catch (e) {
      this.apps = [];
    }
    this.draw();
  }

  /**
   * Choose a capture source.
   *
   * The Rust side is the authority on what ends up running: asking for an app
   * that has since closed, or asking on a version of Windows without process
   * loopback, falls back to the whole device. So the answer is applied here
   * rather than the request — the interface shows what is true.
   */
  async pickSource(source, chipId) {
    this.setState({ device: chipId });
    try {
      const actual = await invoke('set_audio_source', { source });
      this.setState({ source: actual });
      this.say(
        actual.kind === 'app'
          ? 'LISTENING TO ' + String(actual.name).toUpperCase()
          : 'LISTENING TO THE WHOLE OUTPUT'
      );
    } catch (e) {
      // The fallback already happened in Rust; reflect it and say why.
      try {
        this.setState({ source: await invoke('audio_source') });
      } catch (_) { /* leave the last known source */ }
      this.say(String(e).toUpperCase().slice(0, 70));
    }
    this.saveSoon();
  }

  /* -- remembering the setup ---------------------------------------------- */

  /**
   * What is worth carrying to the next launch.
   *
   * Deliberately not the whole state object. Panels, toasts and the tour are
   * *this* session's business — reopening the settings drawer because it was
   * open yesterday would be a bug, not a feature. This is the setup: what to
   * listen to, what to draw, and how it is tuned.
   */
  snapshot() {
    const s = this.state;
    return {
      v: 1,
      device: s.device,
      target: s.target,
      source: s.source,
      preset: s.preset,
      cfg: { ...s.cfg },
      params: JSON.parse(JSON.stringify(this.params || {})),
      useShaders: this.useShaders,
      lyricArt: this.lyricArt,
      // Latched, not read from the current screen.
      //
      // Reading `screen === 'player'` looked right and was wrong: the setup
      // screen is where you change the audio source, and every change there
      // saves — writing `configured: false` over the fact that setup had been
      // completed weeks ago. One trip back to the picker and the app forgot you
      // had ever finished. Once true it stays true.
      configured: !!this.configured || s.screen === 'player',
      tourDone: s.tour < 0 || s.tour >= TOUR.length,
    };
  }

  /**
   * Apply a saved setup, ignoring anything that no longer exists.
   *
   * A remembered audio device can be unplugged and a remembered preset can be a
   * .frag the user has since deleted. Restoring either blindly would leave the
   * app pointing at nothing with no way to tell why, so every field is checked
   * against what is actually available now and quietly dropped if it is gone.
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') return;

    const next = {};

    if (saved.cfg) {
      // Merge over the defaults rather than replacing them, so a setting added
      // in a later version still has its default on an older config.
      next.cfg = { ...DEFAULTS, ...saved.cfg };
    }

    // The device is remembered by name; if it is not in this machine's list
    // right now, it was unplugged or renamed.
    if (saved.device) {
      const i = Number(String(saved.device).replace('dev', ''));
      if (Number.isInteger(i) && i >= 0 && i < this.deviceNames.length) next.device = saved.device;
    }
    if (saved.target) {
      const i = Number(String(saved.target).replace('disp', ''));
      if (Number.isInteger(i) && i >= 0 && i < this.displays.length) next.target = saved.target;
    }
    if (saved.preset && this.presets.some((x) => x.id === saved.preset)) {
      next.preset = saved.preset;
    }

    // The source is not validated here: Rust already resolved it at startup,
    // falling back if the app was not running, and `audio_source` below reports
    // what actually happened.
    if (saved.source && saved.source.kind) next.source = saved.source;
    if (saved.configured) this.configured = true;

    if (typeof saved.useShaders === 'boolean') this.useShaders = saved.useShaders;
    if (typeof saved.lyricArt === 'boolean') this.lyricArt = saved.lyricArt;
    if (saved.params && typeof saved.params === 'object') this.params = saved.params;
    if (saved.tourDone) next.tour = -1;

    // Straight to the player, but only if everything it needs actually came
    // back. A half-restored setup lands on the setup screen, which is the one
    // place that can explain what is missing.
    if (saved.configured && this.state.spotify && next.device && next.target) {
      next.screen = 'player';
    }

    this.setState(next);
  }

  /**
   * Save, but not on every frame of a slider drag.
   *
   * Settings changes arrive continuously while a control is held, and this
   * writes a file. One write a second after things settle is plenty — and the
   * setup is also saved on the way out, so the last edit is never lost even if
   * the app closes inside the debounce window.
   */
  saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 900);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    try {
      invoke('ui_state_set', { state: this.snapshot() }).catch(() => {});
    } catch (e) { /* never let a failed save break the interface */ }
  }

  /** Is ROOMTONE in the Windows startup list? Asked of the registry, not us. */
  async refreshAutostart() {
    try {
      this.autostart = await invoke('autostart_get');
    } catch (e) {
      this.autostart = false;
    }
    this.draw();
  }

  async toggleAutostart() {
    const want = !this.autostart;
    try {
      this.autostart = await invoke('autostart_set', { on: want });
      this.say(this.autostart ? 'WILL START WITH WINDOWS' : 'WILL NOT START WITH WINDOWS');
    } catch (e) {
      this.say(String(e).toUpperCase().slice(0, 70));
      await this.refreshAutostart();
      return;
    }
    this.draw();
  }

  /**
   * Turn karaoke on or off, and get the typography presets out of the way.
   *
   * Every route into karaoke goes through here — the K key, the switch in
   * settings, the button, and Escape — so the preset swap cannot be forgotten
   * by one of them.
   *
   * Leaving karaoke puts the old preset back, but only if it is still the one
   * this function chose. If you picked something else while karaoke was open,
   * that was a deliberate choice and overriding it on the way out would be
   * the app arguing with you.
   */
  setKaraoke(on) {
    const s = this.state;
    on = !!on;
    if (!!s.karaoke === on) return;

    const next = { karaoke: on, lyrics: false };

    if (on && LYRIC_PRESETS.includes(s.preset)) {
      const fallback = this.presets.find((x) => !LYRIC_PRESETS.includes(x.id));
      if (fallback) {
        this.karaokeFrom = s.preset;
        this.karaokeTo = fallback.id;
        next.preset = fallback.id;
      }
    } else if (!on && this.karaokeFrom) {
      if (s.preset === this.karaokeTo && this.presets.some((x) => x.id === this.karaokeFrom)) {
        next.preset = this.karaokeFrom;
      }
      this.karaokeFrom = null;
      this.karaokeTo = null;
    }

    this.setState(next);
  }

  /* -- karaoke ------------------------------------------------------------ */

  /**
   * The karaoke overlay is built by hand instead of declared in the template.
   *
   * Every line has a different number of words, and the template runtime
   * rebuilds a list by replacing its nodes — which would throw the word spans
   * away mid-wipe and restart the fill on every re-render. Owning the nodes
   * here means a span is created once per line and then only ever restyled,
   * which is what lets the fill move smoothly at 60 fps.
   */
  makeKaraoke() {
    const el = document.createElement('div');
    el.id = 'rt-karaoke';
    el.style.cssText =
      'position:fixed;inset:0;z-index:48;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:1.6vh;padding:0 5vw;' +
      'pointer-events:none;text-align:center;' +
      // Always mounted, never display-toggled. This overlay is built by hand
      // rather than by the template, so it survives re-renders — which means it
      // can simply fade, and the words can lift into place as they arrive.
      'opacity:0;visibility:hidden;transform:scale(0.985);' +
      'transition:opacity 0.28s ease, transform 0.34s cubic-bezier(0.2,0.9,0.2,1),' +
      ' visibility 0s linear 0.28s;' +
      // Scrim only at the very top and bottom: the shader stays visible behind
      // the words, which is the whole reason to do this over a solid panel.
      'background:linear-gradient(to bottom,rgba(4,3,8,0.78) 0%,rgba(4,3,8,0.10) 26%,' +
      'rgba(4,3,8,0.10) 74%,rgba(4,3,8,0.86) 100%)';

    const add = (css) => {
      const d = document.createElement('div');
      d.style.cssText = css;
      el.appendChild(d);
      return d;
    };

    // Pre-roll. Three dots that light in turn as the next line approaches, so
    // you know when to come in — the one thing a lyric sheet never tells you.
    const dots = add('display:flex;gap:11px;height:13px;align-items:center;opacity:0;transition:opacity 0.25s ease');
    const dotEls = [0, 1, 2].map(() => {
      const d = document.createElement('div');
      d.style.cssText =
        'width:11px;height:11px;border-radius:50%;background:rgba(255,255,255,0.16);' +
        'transition:background 0.10s linear,transform 0.10s ease,box-shadow 0.10s ease';
      dots.appendChild(d);
      return d;
    });

    const line = (size, alpha) =>
      'font-size:' + size + ';line-height:1.18;font-weight:700;letter-spacing:-0.015em;' +
      'max-width:86vw;color:rgba(255,255,255,' + alpha + ');' +
      'text-wrap:balance;transition:opacity 0.2s ease';

    const prev = add(line('clamp(13px,1.9vw,30px)', '0.24'));
    const cur = add(
      'font-size:clamp(26px,4.6vw,86px);line-height:1.1;font-weight:800;letter-spacing:-0.025em;' +
      'max-width:90vw;display:flex;flex-wrap:wrap;justify-content:center;gap:0.10em 0.30em'
    );
    const next = add(line('clamp(14px,2.1vw,34px)', '0.34'));

    const railWrap = add(
      'width:min(46vw,620px);height:3px;border-radius:2px;background:rgba(255,255,255,0.10);' +
      'overflow:hidden;margin-top:0.8vh'
    );
    const rail = document.createElement('div');
    rail.style.cssText = 'height:100%;width:0%;border-radius:2px;background:#fff;box-shadow:0 0 10px #fff';
    railWrap.appendChild(rail);

    const hint = add(
      "font-family:'Space Mono',monospace;font-size:9.5px;letter-spacing:0.22em;" +
      'color:rgba(255,255,255,0.30);margin-top:0.8vh'
    );

    document.body.appendChild(el);
    return { el, dots, dotEls, prev, cur, next, rail, hint, words: [], key: null };
  }

  /**
   * Lines with an end time, so a wipe knows how long it has to cross a word.
   *
   * LRC gives a start time and nothing else. The end of a line is the start of
   * the next one — except for the last line, which gets a length guessed from
   * its word count rather than hanging on screen for ever.
   */
  karaokeLines(lines) {
    if (this._karSrc === lines) return this._karLines;
    this._karSrc = lines;
    const spoken = (lines || []).filter((l) => l.text);
    this._karLines = spoken.map((l, i) => {
      const words = l.words && l.words.length ? l.words : [{ t: l.t, w: l.text }];
      const end = i + 1 < spoken.length
        ? spoken[i + 1].t
        : l.t + Math.max(2.5, words.length * 0.42);
      return { t: l.t, text: l.text, words, end };
    });
    return this._karLines;
  }

  karaokeFrame(acc, energy, kick, t) {
    const K = this.kar || (this.kar = this.makeKaraoke());

    if (!this.state.karaoke) {
      if (K.el.style.opacity !== '0') {
        K.el.style.opacity = '0';
        K.el.style.transform = 'scale(0.985)';
        // Delayed so the fade is visible before the element stops being
        // rendered at all; going straight to hidden would cut it off.
        K.el.style.visibility = 'hidden';
        K.el.style.transitionDelay = '0s, 0s, 0.28s';
        K.key = null;
      }
      return;
    }
    if (K.el.style.opacity !== '1') {
      K.el.style.visibility = 'visible';
      K.el.style.transitionDelay = '0s, 0s, 0s';
      K.el.style.opacity = '1';
      K.el.style.transform = 'none';
    }

    const L = this.karaokeLines(t.lyr);
    if (!L.length) {
      if (K.key !== 'none') {
        K.key = 'none';
        K.cur.textContent = '';
        K.words = [];
        K.prev.textContent = '';
        K.next.textContent = '';
      }
      K.rail.style.width = '0%';
      K.dots.style.opacity = '0';
      K.hint.textContent = t.title === 'Nothing playing'
        ? 'PRESS PLAY IN SPOTIFY · K TO CLOSE'
        : 'NO SYNCED LYRICS FOR THIS TRACK · K TO CLOSE';
      return;
    }
    K.hint.textContent = 'KARAOKE · K TO CLOSE · [ ] TO NUDGE TIMING';

    const lp = this.lyricPos();
    let ci = -1;
    for (let i = 0; i < L.length; i++) {
      if (L[i].t <= lp) ci = i;
      else break;
    }

    const cur = ci >= 0 ? L[ci] : null;
    const done = !cur || lp > cur.end;

    // Rebuild the word spans only when the line actually changes.
    if (K.key !== ci) {
      K.key = ci;
      K.cur.textContent = '';
      K.words = [];
      if (cur) {
        for (const w of cur.words) {
          const span = document.createElement('span');
          span.textContent = w.w;
          span.style.cssText =
            'display:inline-block;color:transparent;' +
            '-webkit-background-clip:text;background-clip:text;' +
            // The outline is what makes an unsung word readable without
            // colouring it in. The fill then pours into an existing shape
            // rather than a word appearing from nothing.
            '-webkit-text-stroke:0.7px rgba(255,255,255,0.26);' +
            'transition:transform 0.08s ease';
          K.cur.appendChild(span);
          K.words.push(span);
        }
      }
      K.prev.textContent = ci > 0 ? L[ci - 1].text : '';
      K.next.textContent = ci + 1 < L.length ? L[ci + 1].text : '';
    }

    // The wipe. Each word gets its own window: from its own timestamp to the
    // next word's, or to the end of the line for the last one.
    if (cur) {
      const ws = cur.words;
      for (let i = 0; i < ws.length; i++) {
        const span = K.words[i];
        if (!span) continue;
        const st = ws[i].t;
        const en = i + 1 < ws.length ? ws[i + 1].t : cur.end;
        const p = Math.max(0, Math.min(1, (lp - st) / Math.max(0.08, en - st)));

        // Three stops: sung is white, the moving edge is the cover colour, the
        // rest is a ghost. The accent riding the edge is what reads as a wipe
        // rather than as two blocks of text.
        const b = p * 100;
        const a = Math.max(0, b - 7);
        span.style.backgroundImage =
          'linear-gradient(90deg,#ffffff 0%,#ffffff ' + a.toFixed(1) + '%,' +
          acc + ' ' + b.toFixed(1) + '%,rgba(255,255,255,0.13) ' + b.toFixed(1) + '%)';

        const active = p > 0 && p < 1;
        span.style.textShadow = active ? '0 0 ' + (12 + energy * 44) + 'px ' + acc : 'none';
        span.style.transform = active ? 'translateY(' + (-kick * 5).toFixed(2) + 'px)' : 'none';
      }

      const lineP = Math.max(0, Math.min(1, (lp - cur.t) / Math.max(0.2, cur.end - cur.t)));
      K.rail.style.width = (lineP * 100).toFixed(1) + '%';
      K.rail.style.background = acc;
      K.rail.style.boxShadow = '0 0 ' + (8 + energy * 22) + 'px ' + acc;
      K.cur.style.opacity = done ? '0.45' : '1';
    }

    // Count-in. Only in a real gap — flashing dots between every line would be
    // noise, so this waits for a pause worth counting.
    const upcoming = ci + 1 < L.length ? L[ci + 1] : null;
    const from = cur ? cur.end : lp - 99;
    const ttn = upcoming ? upcoming.t - lp : (ci < 0 && L[0] ? L[0].t - lp : 99);
    const gap = upcoming ? upcoming.t - from : (ci < 0 ? 99 : 0);

    if (ttn > 0 && ttn <= 3.0 && gap >= 2.2) {
      K.dots.style.opacity = '1';
      for (let i = 0; i < 3; i++) {
        const lit = ttn <= 3.0 - i;
        K.dotEls[i].style.background = lit ? acc : 'rgba(255,255,255,0.16)';
        K.dotEls[i].style.boxShadow = lit ? '0 0 14px ' + acc : 'none';
        K.dotEls[i].style.transform = lit ? 'scale(1.25)' : 'scale(1)';
      }
    } else {
      K.dots.style.opacity = '0';
    }
  }

  /** Every number here is measured. None is hardcoded. */
  debugFrame(A, bass, mid, high) {
    let bot = 118;
    this.each('chrome', (e) => {
      const r = e.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.5 && r.left < window.innerWidth * 0.5 && r.bottom > bot) bot = r.bottom;
    });
    const dk = (this.n.chrome || []).find((x) => x.getAttribute('data-r2') === 'dock');
    const floor = dk ? dk.getBoundingClientRect().top : window.innerHeight - 24;
    const top = Math.round(bot + 16);
    this.each('dbgPanel', (e) => {
      e.style.top = top + 'px';
      e.style.maxHeight = Math.max(120, Math.round(floor - top - 16)) + 'px';
    });

    const info = this.info;
    const ft = this.ftime || 0;
    const cap = info.running ? info.capture_ms + info.hop_ms : 0;
    const fft = info.running ? info.analysis_us / 1000 : 0;

    const vals = {
      fps: Math.round(this.fps) + ' FPS',
      frame: ft.toFixed(1) + ' MS',
      cap: info.running ? cap.toFixed(1) + ' MS' : '—',
      fft: info.running ? fft.toFixed(2) + ' MS' : '—',
      total: info.running ? (cap + fft + ft).toFixed(1) + ' MS' : '—',
      bpm: this.audio.bpm > 40 ? Math.round(this.audio.bpm) + ' BPM' : 'LISTENING…',
      src: this.shaderError
        ? 'SHADER ERROR'
        : this.useShaders && this.gl.ok
          ? `WEBGL2 · ${this.presets.length} PRESETS`
          : 'CSS FALLBACK (G)',
    };
    this.each('dbg', (e) => {
      const key = e.getAttribute('data-k');
      e.textContent = vals[key] || '—';
      if (key === 'total') {
        e.style.color = info.running && parseFloat(vals.total) > 45 ? '#ffb84d' : 'rgba(255,255,255,0.9)';
      }
    });
    const bv = { bass, mid, high };
    this.each('meter', (e) => {
      e.style.width = Math.min(100, (bv[e.getAttribute('data-k')] || 0) * 100) + '%';
    });
  }

  flowStep(dt, bass, high, energy, kick, acc, k) {
    const c = (this.n.flowCanvas || [])[0];
    if (!c) return;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    const g = c.getContext('2d');
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; this.parts = null; }
    if (!this.parts) {
      this.parts = Array.from({ length: 200 }, () => ({ x: Math.random() * W, y: Math.random() * H, a: Math.random() * 6.28 }));
      g.fillStyle = '#06050b';
      g.fillRect(0, 0, W, H);
    }
    g.fillStyle = 'rgba(6,5,11,' + (0.05 + (1 - energy) * 0.055) + ')';
    g.fillRect(0, 0, W, H);
    this.ft = (this.ft || 0) + dt * (0.22 + energy * 0.85);
    const sp = 30 + bass * 200 * k;
    g.lineWidth = 1 + bass * 2.2;
    g.strokeStyle = acc;
    g.globalAlpha = Math.min(0.9, 0.4 + high * 0.42);
    g.beginPath();
    this.parts.forEach((p) => {
      const ang = Math.sin(p.x * 0.0042 + this.ft) * 1.8 + Math.cos(p.y * 0.0038 - this.ft * 0.7) * 1.8 + p.a * 0.12;
      const nx = p.x + Math.cos(ang) * sp * dt, ny = p.y + Math.sin(ang) * sp * dt;
      g.moveTo(p.x, p.y);
      g.lineTo(nx, ny);
      p.x = nx < 0 ? W : nx > W ? 0 : nx;
      p.y = ny < 0 ? H : ny > H ? 0 : ny;
    });
    g.stroke();
    if (kick > 0.62) {
      g.globalAlpha = 0.09 * kick;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
    }
    g.globalAlpha = 1;
  }
}

/* -- boot ---------------------------------------------------------------- */

// The canvas sits under the whole interface. The DOM renders on top of it, so
// text stays crisp and clickable while the shaders own everything that moves.
const canvas = document.createElement('canvas');
canvas.id = 'gl';
canvas.style.cssText =
  'position:fixed;inset:0;width:100%;height:100%;display:block;background:#000;' +
  // G swaps renderers. Without this the swap is a hard cut between two
  // completely different pictures; with it they dissolve.
  'transition:opacity 0.22s ease';
document.body.appendChild(canvas);

// Anything the interface throws goes into the same log as everything else.
//
// A WebView has no console anyone is looking at, so an uncaught error used to
// be completely silent — the visible symptom was a panel that stopped
// responding, with nothing written down anywhere. Installed before the app is
// constructed so a failure during start-up is caught too.
const report = (what) => {
  try { invoke('ui_log', { message: String(what) }).catch(() => {}); } catch (e) { /* nothing left to try */ }
};
window.addEventListener('error', (e) => {
  report(`${e.message} @ ${e.filename || '?'}:${e.lineno || 0}`);
});
window.addEventListener('unhandledrejection', (e) => {
  report(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});

const mount = document.createElement('div');
document.body.appendChild(mount);

const app = new Roomtone(document.getElementById('app-template').content.firstElementChild, mount);
app.gl = new Renderer(canvas);
if (!app.gl.ok) app.shaderError = app.gl.error;

// A WebGL context can be taken away at any moment — a driver reset, the window
// being reparented into the desktop, waking from sleep. When that happens the
// canvas keeps its size and simply stops painting, and because the interface
// makes itself transparent to let the shaders through, the result is a black
// screen with no error anywhere. So: catch it, fall back to the CSS layers, and
// rebuild when the browser hands the context back.
canvas.addEventListener('webglcontextlost', (e) => {
  // Without preventDefault the context is never restored at all.
  e.preventDefault();
  app.gl.ok = false;
  app._canvasOn = null;          // force canvasVisible() to re-apply
  app.canvasVisible(false);
  app.shaderError = 'the graphics context was lost — using the CSS renderer';
  app.render();
}, false);

canvas.addEventListener('webglcontextrestored', () => {
  app.gl = new Renderer(canvas);
  app.shaderError = app.gl.ok ? null : app.gl.error;
  if (app.gl.ok) app.renderShaders();
  app._canvasOn = null;
  app.render();
}, false);

listen('audio', ({ payload }) => {
  app.audio = payload;
  const bins = decodeSpectrum(payload.spectrum);
  if (bins) app.gl.uploadSpectrum(bins);
});

listen('lyrics', ({ payload }) => app.setLyrics(payload));

listen('track', ({ payload }) => {
  const before = app.np;
  app.np = payload;
  app.npAt = performance.now();
  app.pullCover();

  // Re-render only when something structural changed — not every 3 seconds.
  if (!app.lyrics || app.lyrics.track_id !== payload.track_id) app.pullLyrics();

  const changed = !before
    || before.track_id !== payload.track_id
    || before.is_playing !== payload.is_playing
    || before.connected !== payload.connected;
  if (changed) app.draw();
});

async function refreshInfo() {
  try { app.info = await invoke('audio_info'); } catch (e) { /* leave as-is */ }
}

(async function boot() {
  const [status, devices, displays] = await Promise.all([
    invoke('spotify_status').catch(() => ({})),
    invoke('audio_devices').catch(() => []),
    invoke('displays').catch(() => []),
  ]);

  app.deviceNames = devices;
  app.displays = displays;
  app.state.spotify = !!status.connected;

  await refreshInfo();
  setInterval(refreshInfo, 1000);

  await app.loadPresets();

  // Restore after the presets and the device list are known: the saved setup is
  // validated against what actually exists on this machine right now, and it
  // cannot check a preset id against a list that has not loaded yet.
  try {
    app.restore(await invoke('ui_state_get'));
  } catch (e) { /* first run, or an unreadable config — carry on with defaults */ }

  app.refreshAutostart();
  app.loadApps();

  // Rust chose the source before the window existed. Ask what it settled on
  // rather than assuming the saved one was available.
  try {
    app.state.source = await invoke('audio_source');
  } catch (e) { /* keep the default */ }

  // The last edit is never lost to the debounce: leaving writes immediately.
  window.addEventListener('beforeunload', () => app.saveNow());
  window.addEventListener('blur', () => app.saveNow());

  // Hot reload: poll the user shader folder and recompile what changed. A file
  // watcher would be tidier, but polling a directory twice a second costs
  // nothing and cannot get wedged.
  setInterval(() => app.checkShaders(), 2000);

  app.draw();
  app.start();
})();
