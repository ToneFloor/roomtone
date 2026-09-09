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

//! Capturing one application instead of the whole speaker output.
//!
//! Ordinary loopback captures the *endpoint* — everything mixed together, so a
//! Discord notification lands in the visual alongside the music. Windows also
//! offers **process loopback**, which captures one process tree's contribution
//! before it reaches the mix.
//!
//! There is no cpal support for it, so this is hand-written COM. Three things
//! about it are unusual enough to be worth stating, because each one produces a
//! silent failure rather than an error:
//!
//!   * It is activated by *path*, not by device. There is no `IMMDevice` for a
//!     process; you call `ActivateAudioInterfaceAsync` against a magic virtual
//!     device string and pass the target process id in a `PROPVARIANT` blob.
//!   * Activation is asynchronous even though nothing about this is slow, so a
//!     completion handler has to be implemented and waited on.
//!   * `GetMixFormat` is not supported on the resulting client. The format is
//!     not negotiated — you state one and Windows converts. Asking the client
//!     what it wants returns an error that reads like the device is broken.
//!
//! Requires Windows 10 build 20348 or newer. On anything older, activation
//! fails and the caller falls back to whole-device capture.

#![cfg(windows)]

use ringbuf::traits::*;
use ringbuf::HeapRb;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use windows::core::{implement, Interface, Ref, Result as WinResult, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

use super::capture::{Capture, CaptureInfo};

/// The format we ask Windows to hand us. Not negotiated — see the module note.
const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;

/// Ring capacity, matching the device path: about two seconds of mono.
const RING_CAPACITY: usize = 96_000;

/// 200 ms of buffer, in 100-nanosecond units.
///
/// Process loopback rejects a zero duration, unlike endpoint loopback where it
/// means "use the default". This is a buffer ceiling, not added latency: the
/// event fires per packet, so the pull cadence is unaffected.
const BUFFER_100NS: i64 = 2_000_000;

/// A `PROPVARIANT` holding a blob.
///
/// Built by hand because the generated `PROPVARIANT` keeps its union private,
/// and a `VT_BLOB` is the only shape needed here. The layout is the documented
/// one: the four 16-bit header fields, then the union.
#[repr(C)]
struct BlobPropVariant {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    cb_size: u32,
    _padding: u32,
    blob: *mut u8,
}

const VT_BLOB: u16 = 65;

/// `WAVE_FORMAT_IEEE_FLOAT`, spelled out.
///
/// The generated bindings put this constant behind a media feature that pulls
/// in a great deal of unrelated surface. It is a stable, documented value and
/// has been 3 since 1998.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

/// Signals a Windows event when activation finishes.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion {
    done: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> WinResult<()> {
        // Deliberately does nothing but wake the waiter. The result is read on
        // the calling thread, where the error can actually be reported.
        unsafe {
            let _ = SetEvent(self.done);
        }
        Ok(())
    }
}

/// Ask Windows for an `IAudioClient` bound to one process tree.
unsafe fn activate(pid: u32) -> Result<IAudioClient, String> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                // Include the tree, not just the one process. The session we
                // found often belongs to a child that does the decoding, and
                // apps like Discord and browsers spread audio across several
                // processes — targeting one of them alone captures silence.
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };

    let pv = BlobPropVariant {
        vt: VT_BLOB,
        reserved1: 0,
        reserved2: 0,
        reserved3: 0,
        cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        _padding: 0,
        blob: &mut params as *mut _ as *mut u8,
    };

    let done = CreateEventW(None, true, false, PCWSTR::null())
        .map_err(|e| format!("could not create the activation event: {e}"))?;

    let handler: IActivateAudioInterfaceCompletionHandler = Completion { done }.into();

    let operation: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID as *const GUID,
        Some(&pv as *const BlobPropVariant as *const _),
        &handler,
    )
    .map_err(|e| {
        format!("this build of Windows does not support per-app capture ({e}) — needs build 20348 or newer")
    })?;

    // Two seconds is generous for something that is only asynchronous by
    // signature. Waiting forever would hang the app if the audio service is
    // wedged, which is exactly when a person is already having a bad time.
    let waited = WaitForSingleObject(done, 2000);
    let _ = CloseHandle(done);
    if waited != WAIT_OBJECT_0 {
        return Err("Windows did not answer the per-app capture request".into());
    }

    let mut hr = HRESULT(0);
    let mut unknown = None;
    operation
        .GetActivateResult(&mut hr, &mut unknown)
        .map_err(|e| format!("per-app capture was refused: {e}"))?;
    hr.ok()
        .map_err(|e| format!("per-app capture was refused: {e}"))?;

    unknown
        .ok_or_else(|| "per-app capture returned nothing".to_string())?
        .cast::<IAudioClient>()
        .map_err(|e| format!("per-app capture returned the wrong interface: {e}"))
}

/// Start capturing one process tree. `stop` ends the capture thread.
pub fn start(pid: u32, label: &str, stop: Arc<AtomicBool>) -> Result<Capture, String> {
    let rb = HeapRb::<f32>::new(RING_CAPACITY);
    let (mut producer, consumer) = rb.split();

    let frames_per_callback = Arc::new(AtomicU32::new(0));
    let measured = frames_per_callback.clone();

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let name = label.to_string();

    std::thread::Builder::new()
        .name("roomtone-app-capture".into())
        .spawn(move || unsafe {
            // COM lives on the thread that initialises it, and every interface
            // here is used only from this thread.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let client = match activate(pid) {
                Ok(c) => c,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };

            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                nChannels: CHANNELS,
                nSamplesPerSec: RATE,
                nAvgBytesPerSec: RATE * CHANNELS as u32 * 4,
                nBlockAlign: CHANNELS * 4,
                wBitsPerSample: 32,
                cbSize: 0,
            };

            if let Err(e) = client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                BUFFER_100NS,
                0,
                &format,
                None,
            ) {
                let _ = ready_tx.send(Err(format!("could not open the app's audio stream: {e}")));
                return;
            }

            let Ok(event) = CreateEventW(None, false, false, PCWSTR::null()) else {
                let _ = ready_tx.send(Err("could not create the capture event".into()));
                return;
            };
            if let Err(e) = client.SetEventHandle(event) {
                let _ = ready_tx.send(Err(format!("could not arm the capture event: {e}")));
                return;
            }

            let capture: IAudioCaptureClient = match client.GetService() {
                Ok(c) => c,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("could not read the app's audio: {e}")));
                    return;
                }
            };

            if let Err(e) = client.Start() {
                let _ = ready_tx.send(Err(format!("could not start the app's audio: {e}")));
                return;
            }

            let _ = ready_tx.send(Ok(()));
            crate::log::event(&format!("audio: capturing {name} (pid {pid}) only"));

            let mut mono: Vec<f32> = Vec::with_capacity(4096);

            while !stop.load(Ordering::Relaxed) {
                // A timeout rather than an infinite wait: an app that goes
                // quiet stops raising the event entirely, and without a timeout
                // the stop flag would never be read and the thread would leak.
                let _ = WaitForSingleObject(event, 200);

                loop {
                    let Ok(packet) = capture.GetNextPacketSize() else { break };
                    if packet == 0 {
                        break;
                    }

                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    if capture
                        .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                        .is_err()
                    {
                        break;
                    }

                    if frames > 0 {
                        measured.store(frames, Ordering::Relaxed);
                        mono.clear();

                        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                            // Windows is allowed to hand back a silent packet
                            // with no buffer at all. It still has to occupy its
                            // place in time, or the analysis clock drifts.
                            mono.resize(frames as usize, 0.0);
                        } else {
                            let samples = std::slice::from_raw_parts(
                                data as *const f32,
                                frames as usize * CHANNELS as usize,
                            );
                            for frame in samples.chunks_exact(CHANNELS as usize) {
                                mono.push(frame.iter().sum::<f32>() / CHANNELS as f32);
                            }
                        }

                        producer.push_slice(&mono);
                    }

                    let _ = capture.ReleaseBuffer(frames);
                }
            }

            let _ = client.Stop();
            let _ = CloseHandle(event);
            crate::log::event(&format!("audio: stopped capturing {name}"));
        })
        .map_err(|e| format!("could not start the capture thread: {e}"))?;

    ready_rx
        .recv()
        .map_err(|_| "the per-app capture thread died on startup".to_string())??;

    Ok(Capture {
        info: CaptureInfo {
            device: label.to_string(),
            sample_rate: RATE,
            channels: CHANNELS,
            sample_format: "F32".into(),
        },
        frames_per_callback,
        consumer,
    })
}
