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

//! Path A, stage 2: FFT, band split, normalisation and kick detection.
//!
//! Runs on its own thread, decoupled from both the audio callback and the
//! render loop. A late analysis frame therefore softens the motion rather than
//! stalling it — which is the whole reason the three are separated.
//!
//! The algorithm here is a direct port of the prototype's `readAudio()`. That
//! version was written against the Web Audio analyser and is correct; only the
//! source of the samples changes.

use aubio_rs::{Onset, OnsetMode, Tempo};
use ringbuf::traits::*;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// 2048 samples at 48 kHz is ~43 ms of audio, giving ~23 Hz bins.
const FFT_SIZE: usize = 2048;
/// 512-sample hop → an analysis frame every ~11 ms, about 94 per second.
const HOP: usize = 512;

/// How many bins the spectrum texture carries to the shaders.
///
/// The handoff spec says two things that look contradictory: upload the *full*
/// spectrum as a texture, and never send raw FFT frames across the bridge
/// because the serialisation shows up as jitter. Both are right. 1024 raw f32
/// bins per frame is the thing to avoid; 128 log-spaced bins quantised to
/// bytes is 128 bytes, which is nothing — and 128 is already finer than any
/// shader can show on screen.
pub const SPECTRUM_BINS: usize = 128;

/// Rise instantly, fall slowly. Symmetric smoothing makes the visuals feel
/// mushy; this is the single most important constant in the file.
const RELEASE: f32 = 0.86;

/// Fallback detector only. aubio does the real work; this is what runs if
/// aubio cannot be created on this machine.
const KICK_THRESHOLD: f32 = 1.4;
/// Minimum gap between kicks, in analysis frames (~120 ms).
const KICK_REFRACTORY: u32 = 11;

/// Minimum inter-onset interval. Below this, a single drum hit registers as
/// several — the debouncing a hand-rolled detector always gets slightly wrong.
const MIN_IOI_MS: f32 = 120.0;

/// Peak-picking threshold. Lower catches more, including things that are not
/// beats; this sits where a kick reads reliably and a hi-hat does not.
const ONSET_THRESHOLD: f32 = 0.3;

/// Below this, in dB, the input counts as silence and nothing fires. Without
/// it, room noise and codec hiss produce a steady drizzle of phantom onsets.
const SILENCE_DB: f32 = -48.0;

/// Live band values, written by the analysis thread and read by the emitter.
/// Floats are stored as bits so reads never lock.
#[derive(Debug)]
pub struct Levels {
    bass: AtomicU32,
    mid: AtomicU32,
    high: AtomicU32,
    kick: AtomicU32,
    rms: AtomicU32,
    /// Microseconds spent in the last analysis frame.
    pub analysis_us: AtomicU32,
    pub frames: AtomicU64,
    /// Detected tempo, 0 until enough kicks have been seen.
    bpm: AtomicU32,
    /// Log-spaced magnitudes, 0-255, ready to become a 1D texture.
    pub spectrum: std::sync::Mutex<[u8; SPECTRUM_BINS]>,
}

impl Default for Levels {
    fn default() -> Self {
        Self {
            bass: AtomicU32::new(0),
            mid: AtomicU32::new(0),
            high: AtomicU32::new(0),
            kick: AtomicU32::new(0),
            rms: AtomicU32::new(0),
            analysis_us: AtomicU32::new(0),
            frames: AtomicU64::new(0),
            bpm: AtomicU32::new(0),
            spectrum: std::sync::Mutex::new([0u8; SPECTRUM_BINS]),
        }
    }
}

fn store(slot: &AtomicU32, v: f32) {
    slot.store(v.to_bits(), Ordering::Relaxed);
}

fn load(slot: &AtomicU32) -> f32 {
    f32::from_bits(slot.load(Ordering::Relaxed))
}

impl Levels {
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            bass: load(&self.bass),
            mid: load(&self.mid),
            high: load(&self.high),
            kick: load(&self.kick),
            rms: load(&self.rms),
            bpm: load(&self.bpm),
            analysis_us: self.analysis_us.load(Ordering::Relaxed),
            frames: self.frames.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct Snapshot {
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    pub kick: f32,
    pub rms: f32,
    pub bpm: f32,
    pub analysis_us: u32,
    pub frames: u64,
}

/// A per-band rolling normaliser, so a quiet track still fills the screen.
struct Normaliser {
    peak: f32,
    smoothed: f32,
}

impl Normaliser {
    fn new() -> Self {
        Self {
            peak: 1e-4,
            smoothed: 0.0,
        }
    }

    fn update(&mut self, raw: f32) -> f32 {
        // Peak rises immediately, then leaks away slowly so the visuals adapt
        // when a loud track is followed by a quiet one.
        self.peak = (self.peak * 0.9994).max(raw).max(1e-5);

        let normalised = (raw / self.peak).clamp(0.0, 1.0);

        // Asymmetric: instant attack, slow release.
        self.smoothed = normalised.max(self.smoothed * RELEASE);
        self.smoothed
    }
}

/// One analysis hop expressed in milliseconds, for the latency budget.
pub fn hop_ms(sample_rate: u32) -> f32 {
    HOP as f32 / sample_rate.max(1) as f32 * 1000.0
}

pub fn spawn(
    mut consumer: ringbuf::HeapCons<f32>,
    sample_rate: u32,
    stop: Arc<std::sync::atomic::AtomicBool>,
) -> Arc<Levels> {
    let levels = Arc::new(Levels::default());
    let out = levels.clone();

    std::thread::Builder::new()
        .name("roomtone-analysis".into())
        .spawn(move || {
            let mut planner = FftPlanner::<f32>::new();
            let fft = planner.plan_fft_forward(FFT_SIZE);

            // Hann window, precomputed.
            let window: Vec<f32> = (0..FFT_SIZE)
                .map(|i| {
                    let x = std::f32::consts::PI * 2.0 * i as f32 / FFT_SIZE as f32;
                    0.5 * (1.0 - x.cos())
                })
                .collect();

            let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
            let range = |lo: f32, hi: f32| {
                let a = (lo / bin_hz).floor().max(1.0) as usize;
                let b = ((hi / bin_hz).ceil() as usize).min(FFT_SIZE / 2);
                (a, b.max(a + 1))
            };
            let (bass_lo, bass_hi) = range(20.0, 250.0);
            let (mid_lo, mid_hi) = range(250.0, 4_000.0);
            let (high_lo, high_hi) = range(4_000.0, 16_000.0);

            let mut history = vec![0.0f32; FFT_SIZE];
            let mut hop = vec![0.0f32; HOP];
            let mut scratch = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];

            let mut n_bass = Normaliser::new();
            let mut n_mid = Normaliser::new();
            let mut n_high = Normaliser::new();

            // Rolling mean of raw bass, for onset detection.
            // aubio: onset detection using the complex-domain method, and a
            // separate tempo tracker. Both are causal — designed to run in
            // real time rather than over a finished file — which is exactly
            // what a visualizer needs and what makes them worth the dependency.
            let mut onset = Onset::new(OnsetMode::Complex, FFT_SIZE, HOP, sample_rate)
                .map(|o| {
                    o.with_threshold(ONSET_THRESHOLD)
                        .with_silence(SILENCE_DB)
                        .with_minioi_ms(MIN_IOI_MS)
                })
                .map_err(|e| {
                    crate::log::event(&format!("audio: aubio onset unavailable ({e}), using the built-in detector"));
                })
                .ok();

            let mut tempo = Tempo::new(OnsetMode::SpecDiff, FFT_SIZE, HOP, sample_rate)
                .map(|t| t.with_silence(SILENCE_DB))
                .ok();

            if onset.is_some() {
                crate::log::event("audio: aubio onset + tempo running");
            }

            let mut spectrum_peak = 1e-4f32;
            let mut bass_mean = 0.0f32;
            let mut since_kick = KICK_REFRACTORY;
            let mut kick = 0.0f32;
            let mut last_kick_at: Option<Instant> = None;
            let mut intervals: Vec<f32> = Vec::with_capacity(16);

            loop {
                // Checked here rather than only when audio arrives: a stopped
                // source stops filling the ring, so a thread that only looked
                // at the flag after a successful read would never exit.
                if stop.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                if consumer.occupied_len() < HOP {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    continue;
                }

                let started = Instant::now();
                consumer.pop_slice(&mut hop);

                // Slide the analysis window forward by one hop.
                history.copy_within(HOP.., 0);
                history[FFT_SIZE - HOP..].copy_from_slice(&hop);

                let mut sum_sq = 0.0f32;
                for (i, slot) in scratch.iter_mut().enumerate() {
                    let s = history[i];
                    sum_sq += s * s;
                    *slot = Complex::new(s * window[i], 0.0);
                }
                let rms = (sum_sq / FFT_SIZE as f32).sqrt();

                fft.process(&mut scratch);

                let band = |lo: usize, hi: usize| -> f32 {
                    let mut acc = 0.0f32;
                    for c in &scratch[lo..hi] {
                        acc += c.norm();
                    }
                    acc / (hi - lo) as f32
                };

                let raw_bass = band(bass_lo, bass_hi);
                let raw_mid = band(mid_lo, mid_hi);
                let raw_high = band(high_lo, high_hi);

                // -- onset ------------------------------------------------
                let mut fired = false;

                if let Some(detector) = onset.as_mut() {
                    // aubio reports the onset for this hop. Anything above zero
                    // is a detection; it has already applied its own silence
                    // gate and minimum interval.
                    if let Ok(value) = detector.do_result(&hop[..]) {
                        fired = value > 0.0;
                    }

                    if let Some(t) = tempo.as_mut() {
                        let _ = t.do_result(&hop[..]);
                        // Confidence stays low until it has heard enough of a
                        // pulse to mean it. Reporting an unsure number as fact
                        // is worse than reporting nothing.
                        if t.get_confidence() > 0.08 {
                            let bpm = t.get_bpm();
                            if (40.0..=220.0).contains(&bpm) {
                                store(&levels.bpm, bpm);
                            }
                        }
                    }
                } else {
                    // No aubio on this machine: rolling mean of bass energy.
                    bass_mean = bass_mean * 0.978 + raw_bass * 0.022;
                    since_kick = since_kick.saturating_add(1);

                    if raw_bass > bass_mean * KICK_THRESHOLD
                        && since_kick >= KICK_REFRACTORY
                        && rms > 1e-4
                    {
                        fired = true;
                        since_kick = 0;

                        let now = Instant::now();
                        if let Some(prev) = last_kick_at.replace(now) {
                            let gap = now.duration_since(prev).as_secs_f32();
                            if (0.3..=1.0).contains(&gap) {
                                intervals.push(gap);
                                if intervals.len() > 12 {
                                    intervals.remove(0);
                                }
                            }
                        }
                    }

                    if intervals.len() >= 4 {
                        let mut sorted = intervals.clone();
                        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        let median = sorted[sorted.len() / 2];
                        if median > 0.0 {
                            store(&levels.bpm, 60.0 / median);
                        }
                    }
                }

                if fired {
                    kick = 1.0;
                } else {
                    kick *= 0.85;
                }

                // Log-spaced bins for the shader texture. Linear bins waste
                // most of their resolution above 10 kHz, where there is very
                // little to look at; ears and eyes both want log spacing.
                {
                    let nyquist = sample_rate as f32 / 2.0;
                    let lo_hz = 20.0f32;
                    let hi_hz = 16_000.0f32.min(nyquist * 0.98);
                    let ratio = (hi_hz / lo_hz).ln();

                    let mut peak = spectrum_peak.max(1e-6);
                    let mut frame = [0u8; SPECTRUM_BINS];

                    for (i, slot) in frame.iter_mut().enumerate() {
                        let a = (i as f32) / SPECTRUM_BINS as f32;
                        let b = (i as f32 + 1.0) / SPECTRUM_BINS as f32;
                        let f0 = lo_hz * (ratio * a).exp();
                        let f1 = lo_hz * (ratio * b).exp();

                        let k0 = ((f0 / bin_hz) as usize).max(1);
                        let k1 = ((f1 / bin_hz).ceil() as usize).clamp(k0 + 1, FFT_SIZE / 2);

                        let mut acc = 0.0f32;
                        for c in &scratch[k0..k1] {
                            acc += c.norm();
                        }
                        let v = acc / (k1 - k0) as f32;
                        peak = peak.max(v);
                        *slot = ((v / peak).clamp(0.0, 1.0) * 255.0) as u8;
                    }

                    // Same rolling-peak trick as the bands: adapt down slowly so
                    // a quiet passage still fills the texture.
                    spectrum_peak = peak * 0.9994;

                    if let Ok(mut out) = levels.spectrum.lock() {
                        *out = frame;
                    }
                }

                store(&levels.bass, n_bass.update(raw_bass));
                store(&levels.mid, n_mid.update(raw_mid));
                store(&levels.high, n_high.update(raw_high));
                store(&levels.kick, kick);
                store(&levels.rms, rms);

                levels
                    .analysis_us
                    .store(started.elapsed().as_micros() as u32, Ordering::Relaxed);
                levels.frames.fetch_add(1, Ordering::Relaxed);
            }
        })
        .expect("could not start the analysis thread");

    out
}
