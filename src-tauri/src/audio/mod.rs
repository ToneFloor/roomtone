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

//! Path A: system audio in, band values out.
//!
//! This is the only path with a hard latency budget, and the only one that
//! keeps working when everything else fails. If Spotify and the lyrics service
//! both vanish, this path alone still drives a complete visualizer.
//!
//! ```text
//!   WASAPI loopback  →  ring buffer  →  FFT 2048  →  bands + onsets  →  window
//!        ~10 ms           lock-free       <1 ms          ~11 ms hop      60 Hz
//! ```

pub mod analysis;
pub mod capture;
#[cfg(windows)]
pub mod process_capture;
#[cfg(windows)]
pub mod sessions;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "audio";

/// Emitted to the window 60 times a second. Deliberately tiny: the bridge is
/// crossed 60 times a second, so nothing large may cross it.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Frame {
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    pub kick: f32,
    pub rms: f32,
    pub bpm: f32,
}

/// The per-frame payload. The bands stay as scalars because almost everything
/// reads them directly; the spectrum rides along as 128 base64 bytes, which is
/// small enough to cross the bridge 60 times a second without showing up as
/// jitter and detailed enough for a shader to sample any frequency at any pixel.
#[derive(Debug, Clone, Serialize)]
pub struct FramePayload {
    #[serde(flatten)]
    pub bands: Frame,
    pub spectrum: String,
}

/// Everything measured about the running pipeline. Nothing here is hardcoded.
#[derive(Debug, Clone, Serialize)]
pub struct AudioInfo {
    pub running: bool,
    pub device: Option<String>,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: Option<String>,
    /// Frames per WASAPI callback, measured from the live stream.
    pub buffer_frames: u32,
    /// That buffer expressed in milliseconds — the capture floor.
    pub capture_ms: f32,
    /// One analysis hop in milliseconds.
    pub hop_ms: f32,
    /// Capture + hop. The part of the budget this path owns.
    pub pipeline_ms: f32,
    /// Time spent inside the last FFT frame.
    pub analysis_us: u32,
    pub analysis_frames: u64,
    pub error: Option<String>,
}

impl Default for AudioInfo {
    fn default() -> Self {
        Self {
            running: false,
            device: None,
            sample_rate: 0,
            channels: 0,
            sample_format: None,
            buffer_frames: 0,
            capture_ms: 0.0,
            hop_ms: 0.0,
            pipeline_ms: 0.0,
            analysis_us: 0,
            analysis_frames: 0,
            error: None,
        }
    }
}

/// Where the audio comes from.
///
/// `Device` is the whole speaker output — everything the machine plays mixed
/// together. `App` is one application's own contribution, captured before it
/// reaches that mix, so a notification arriving mid-song does not register.
/// An app is identified by its **executable name**, not by a process id.
///
/// A pid is meaningless the moment the app restarts, let alone across a reboot,
/// and this gets written to a config file. The pid is resolved fresh each time
/// the source is opened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Source {
    /// A whole output endpoint. `None` means whatever Windows calls default,
    /// which is also the fallback when a named device has been unplugged.
    Device { name: Option<String> },
    App { exe: String, name: String },
}

impl Default for Source {
    fn default() -> Self {
        Source::Device { name: None }
    }
}

struct Running {
    info: capture::CaptureInfo,
    frames_per_callback: Arc<std::sync::atomic::AtomicU32>,
    levels: Arc<analysis::Levels>,
    /// Setting this ends the capture and analysis threads for this source.
    stop: Arc<AtomicBool>,
    source: Source,
}

static STATE: OnceLock<std::sync::Mutex<Option<Running>>> = OnceLock::new();
static ERROR: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();

fn state() -> &'static std::sync::Mutex<Option<Running>> {
    STATE.get_or_init(|| std::sync::Mutex::new(None))
}

fn error_slot() -> &'static std::sync::Mutex<Option<String>> {
    ERROR.get_or_init(|| std::sync::Mutex::new(None))
}

/// Open the capture stream and start the analysis and emit loops.
///
/// `preferred` is whatever was being listened to last time. It is tried first
/// and falls back to the whole device — an app that is simply not running yet
/// is an ordinary Tuesday, not an error worth stopping for.
pub fn start(app: AppHandle, preferred: Source) {
    let wanted = preferred.clone();
    if let Err(e) = open(preferred) {
        if wanted != Source::default() {
            crate::log::event(&format!("audio: {wanted:?} unavailable ({e}) — using the device"));
            if let Err(e) = open(Source::default()) {
                crate::log::event(&format!("audio: capture FAILED: {e}"));
                if let Ok(mut slot) = error_slot().lock() {
                    *slot = Some(e);
                }
            }
        } else {
            crate::log::event(&format!("audio: capture FAILED: {e}"));
            if let Ok(mut slot) = error_slot().lock() {
                *slot = Some(e);
            }
        }
    }
    spawn_emitter(app);
}

/// Switch to a different source, keeping the emitter running.
///
/// If the new source cannot be opened — the app was closed, or this build of
/// Windows is too old for per-app capture — the whole-device source is restored
/// rather than leaving the visualizer deaf, and the error is reported so the
/// interface can say what happened.
pub fn set_source(source: Source) -> Result<(), String> {
    match open(source.clone()) {
        Ok(()) => Ok(()),
        Err(e) => {
            crate::log::event(&format!("audio: {source:?} failed ({e}) — falling back to the device"));
            let _ = open(Source::default());
            Err(e)
        }
    }
}

pub fn current_source() -> Source {
    state()
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|r| r.source.clone()))
        .unwrap_or_default()
}

/// Tear down whatever is running and bring up `source`.
fn open(source: Source) -> Result<(), String> {
    // Stop first, and only then start. Two capture threads pushing into two
    // ring buffers while two analysis threads drain them would not crash — it
    // would just quietly double the CPU cost and leave the old one winning.
    if let Ok(mut slot) = state().lock() {
        if let Some(previous) = slot.take() {
            previous.stop.store(true, Ordering::SeqCst);
        }
    }

    let stop = Arc::new(AtomicBool::new(false));

    let cap = match &source {
        Source::Device { name } => capture::start(stop.clone(), name.as_deref())?,
        #[cfg(windows)]
        Source::App { exe, name } => {
            let pid = sessions::pid_for_exe(exe)
                .ok_or_else(|| format!("{name} is not running"))?;
            process_capture::start(pid, name, stop.clone())?
        }
        #[cfg(not(windows))]
        Source::App { .. } => return Err("per-app capture is Windows only".into()),
    };

    crate::log::event(&format!(
        "audio: capture open — {} ({} Hz, {} ch, {})",
        cap.info.device, cap.info.sample_rate, cap.info.channels, cap.info.sample_format
    ));

    let levels = analysis::spawn(cap.consumer, cap.info.sample_rate, stop.clone());

    if let Ok(mut slot) = state().lock() {
        *slot = Some(Running {
            info: cap.info,
            frames_per_callback: cap.frames_per_callback,
            levels,
            stop,
            source,
        });
    }

    if let Ok(mut slot) = error_slot().lock() {
        *slot = None;
    }

    watch_for_silence();
    Ok(())
}

/// Report once, shortly after opening, whether any audio actually arrived.
///
/// A capture stream can open perfectly and deliver nothing — that is exactly
/// what happens when per-app capture targets the wrong process in a family, and
/// it is invisible otherwise: no error, no callback, just a visualizer that sits
/// still while music plays. One line in the log turns a mystery into a fact.
fn watch_for_silence() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(8));
        let Ok(slot) = state().lock() else { return };
        let Some(running) = slot.as_ref() else { return };
        let s = running.levels.snapshot();
        let frames = running.levels.frames.load(Ordering::Relaxed);
        crate::log::event(&format!(
            "audio: after 8s on {} — {} analysis frames, rms {:.4}{}",
            running.info.device,
            frames,
            s.rms,
            if frames == 0 {
                " (NO AUDIO REACHED THE ANALYSER)"
            } else if s.rms < 0.0005 {
                " (silent — is anything playing through this source?)"
            } else {
                ""
            }
        ));
    });
}

/// One small event per frame at 60 Hz. Raw FFT frames are deliberately never
/// sent across the bridge — the serialisation cost shows up as jitter.
fn spawn_emitter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_micros(16_667));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            ticker.tick().await;

            // Read the levels through the shared state rather than capturing
            // them once: switching source replaces them, and an emitter holding
            // the old handle would keep publishing a stream nobody is filling.
            let Some(levels) = state()
                .lock()
                .ok()
                .and_then(|s| s.as_ref().map(|r| r.levels.clone()))
            else {
                continue;
            };

            let s = levels.snapshot();

            let spectrum = levels
                .spectrum
                .lock()
                .map(|b| crate::base64_encode(&b[..]))
                .unwrap_or_default();

            let _ = app.emit(
                EVENT,
                FramePayload {
                    bands: Frame {
                        bass: s.bass,
                        mid: s.mid,
                        high: s.high,
                        kick: s.kick,
                        rms: s.rms,
                        bpm: s.bpm,
                    },
                    spectrum,
                },
            );
        }
    });
}

pub fn info() -> AudioInfo {
    let error = error_slot().lock().ok().and_then(|s| s.clone());

    let guard = match state().lock() {
        Ok(g) => g,
        Err(_) => return AudioInfo { error, ..Default::default() },
    };

    let Some(running) = guard.as_ref() else {
        return AudioInfo { error, ..Default::default() };
    };

    let sr = running.info.sample_rate.max(1) as f32;
    let buffer_frames = running.frames_per_callback.load(Ordering::Relaxed);
    let capture_ms = buffer_frames as f32 / sr * 1000.0;
    let hop_ms = analysis::hop_ms(running.info.sample_rate);
    let snap = running.levels.snapshot();

    AudioInfo {
        running: true,
        device: Some(running.info.device.clone()),
        sample_rate: running.info.sample_rate,
        channels: running.info.channels,
        sample_format: Some(running.info.sample_format.clone()),
        buffer_frames,
        capture_ms,
        hop_ms,
        pipeline_ms: capture_ms + hop_ms,
        analysis_us: snap.analysis_us,
        analysis_frames: snap.frames,
        error,
    }
}

/// Every output endpoint Windows knows about. Loopback can bind to any of
/// them, so this is what the onboarding device picker lists.
pub fn devices() -> Vec<String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let mut names = Vec::new();

    if let Ok(devices) = host.output_devices() {
        for d in devices {
            if let Ok(desc) = d.description() {
                let name = desc.name().to_string();
                if !name.is_empty() && !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    names
}
