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

//! Path A, stage 1: WASAPI loopback capture.
//!
//! Windows exposes whatever the speakers are playing through *loopback*: a
//! capture stream bound to a render endpoint. In cpal this is implicit — build
//! an **input** stream on an **output** device and the WASAPI backend sets
//! `AUDCLNT_STREAMFLAGS_LOOPBACK` for you.
//!
//! One consequence to know: `default_input_config()` refuses on a render
//! endpoint, so the stream format has to come from `default_output_config()`.
//! That trips people up, because the error it produces ("device does not
//! support input") sounds like the device is wrong when it is not.
//!
//! The callback does the least work that is possible: downmix to mono, push
//! into a lock-free ring buffer, return. It never allocates, never locks and
//! never touches the analysis code. Everything expensive happens on the
//! analysis thread, because a slow audio callback produces dropouts, and
//! dropouts are what make a visualizer feel broken.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use ringbuf::traits::*;
use ringbuf::HeapRb;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

/// What the capture stream actually negotiated. Reported in diagnostics —
/// none of it is guessed.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaptureInfo {
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
}

pub struct Capture {
    pub info: CaptureInfo,
    /// Frames delivered per callback, measured from the stream itself.
    pub frames_per_callback: Arc<AtomicU32>,
    pub consumer: ringbuf::HeapCons<f32>,
}

/// Roughly two seconds of mono audio at 48 kHz. Far more than the analysis
/// thread should ever fall behind by; if it overflows, something is very wrong
/// and dropping the oldest audio is the right failure.
const RING_CAPACITY: usize = 96_000;

/// Open a loopback stream on `wanted`, or on the system default when it is
/// `None` or no longer present.
///
/// The device list in the interface used to be decoration: whichever card you
/// picked, this function opened the default endpoint regardless. Choosing the
/// output that the sound is actually coming from is the whole point on a
/// machine with a dozen of them.
pub fn start(stop: Arc<AtomicBool>, wanted: Option<&str>) -> Result<Capture, String> {
    let host = cpal::default_host();

    let device = wanted
        .and_then(|want| {
            let devices = host.output_devices().ok()?;
            devices.into_iter().find(|d| {
                d.description()
                    .map(|desc| desc.name() == want)
                    .unwrap_or(false)
            })
        })
        .or_else(|| host.default_output_device())
        .ok_or_else(|| "no default output device — is anything plugged in?".to_string())?;

    let name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "unknown output device".to_string());

    // The render endpoint's own format. Asking for the *input* config here
    // fails, because Windows does not consider a speaker an input.
    let supported = device
        .default_output_config()
        .map_err(|e| format!("could not read the output device's format: {e}"))?;

    let sample_format = supported.sample_format();
    let channels = supported.channels();
    let sample_rate = supported.sample_rate();
    let config: cpal::StreamConfig = supported.into();

    let info = CaptureInfo {
        device: name,
        sample_rate,
        channels,
        sample_format: format!("{sample_format:?}"),
    };

    let rb = HeapRb::<f32>::new(RING_CAPACITY);
    let (producer, consumer) = rb.split();

    let frames_per_callback = Arc::new(AtomicU32::new(0));
    let measured = frames_per_callback.clone();

    // cpal's Stream is not Send, so it has to live on the thread that built it.
    // The thread parks forever; the stream stays alive with it.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::Builder::new()
        .name("roomtone-capture".into())
        .spawn(move || {
            let result =
                build_and_play(&device, &config, sample_format, channels, producer, measured);

            match result {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    // The stream is not Send, so it has to be held here — but
                    // parking forever would make the source unswitchable. A
                    // timed park costs one wake-up every quarter second and
                    // lets the stream be dropped on request.
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::park_timeout(std::time::Duration::from_millis(250));
                    }
                    drop(stream);
                    crate::log::event("audio: device capture stopped");
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| format!("could not start the capture thread: {e}"))?;

    ready_rx
        .recv()
        .map_err(|_| "capture thread died on startup".to_string())??;

    Ok(Capture {
        info,
        frames_per_callback,
        consumer,
    })
}

fn build_and_play(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    producer: ringbuf::HeapProd<f32>,
    measured: Arc<AtomicU32>,
) -> Result<cpal::Stream, String> {
    let on_error = |e| {
        crate::log::event(&format!("audio: stream error: {e}"));
    };

    let stream = match sample_format {
        SampleFormat::F32 => build::<f32>(device, config, channels, producer, measured, on_error),
        SampleFormat::I16 => build::<i16>(device, config, channels, producer, measured, on_error),
        SampleFormat::U16 => build::<u16>(device, config, channels, producer, measured, on_error),
        other => Err(format!("unsupported sample format {other:?}")),
    }?;

    stream
        .play()
        .map_err(|e| format!("could not start the loopback stream: {e}"))?;

    Ok(stream)
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    mut producer: ringbuf::HeapProd<f32>,
    measured: Arc<AtomicU32>,
    on_error: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + cpal::FromSample<f32> + Sample,
{
    let channels = channels.max(1) as usize;
    // Reused across callbacks so the audio thread never allocates.
    let mut mono: Vec<f32> = Vec::with_capacity(4096);

    device
        .build_input_stream::<T, _, _>(
            config.clone(),
            move |data: &[T], _| {
                let frames = data.len() / channels;
                measured.store(frames as u32, Ordering::Relaxed);

                mono.clear();
                if mono.capacity() < frames {
                    // Only ever happens on the first callback of a new size.
                    mono.reserve(frames - mono.capacity());
                }

                for frame in data.chunks_exact(channels) {
                    let mut sum = 0.0f32;
                    for s in frame {
                        sum += s.to_f32();
                    }
                    mono.push(sum / channels as f32);
                }

                // If the analysis thread has stalled, drop the newest audio
                // rather than blocking here. Never block the audio callback.
                producer.push_slice(&mono);
            },
            on_error,
            None,
        )
        .map_err(|e| {
            format!(
                "could not open a loopback stream on the default output device: {e}. \
                 If this says the device does not support input, the output format \
                 could not be negotiated."
            )
        })
}

/// Minimal sample conversion so the callback stays generic without pulling in
/// cpal's full conversion machinery.
pub trait Sample: Copy {
    fn to_f32(self) -> f32;
}

impl Sample for f32 {
    #[inline]
    fn to_f32(self) -> f32 {
        self
    }
}

impl Sample for i16 {
    #[inline]
    fn to_f32(self) -> f32 {
        self as f32 / i16::MAX as f32
    }
}

impl Sample for u16 {
    #[inline]
    fn to_f32(self) -> f32 {
        (self as f32 / u16::MAX as f32) * 2.0 - 1.0
    }
}
