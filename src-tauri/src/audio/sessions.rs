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

//! Which applications are making sound right now.
//!
//! Windows keeps an *audio session* per application on each output endpoint.
//! Walking those sessions is how Volume Mixer builds its list, and it is how
//! ROOMTONE builds the "listen to just this app" picker.
//!
//! Two details are worth knowing, because both produce a confusing list if you
//! get them wrong:
//!
//!   * A session survives the sound that made it. An app that played a
//!     notification an hour ago still has an *inactive* session sitting there.
//!     Listing those means offering to capture silence, so state is reported and
//!     the interface can lead with what is actually playing.
//!   * One process can own several sessions, and a browser owns one per tab
//!     making noise. They are collapsed by process id, or Chrome appears nine
//!     times.

#![cfg(windows)]

use serde::Serialize;
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, AudioSessionStateActive,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// One application that can be captured on its own.
#[derive(Debug, Clone, Serialize)]
pub struct AppSource {
    pub pid: u32,
    /// The executable's file name, e.g. `Spotify.exe` — the stable identity.
    pub exe: String,
    /// What to show a person, e.g. `Spotify`.
    pub name: String,
    /// Is it making sound at this moment?
    pub active: bool,
}

/// COM has to be initialised on whichever thread calls in.
///
/// Tauri runs commands on a pool, so this is not a one-off at startup: any
/// thread might be the one asking. Calling it twice on the same thread is
/// harmless — the second call returns S_FALSE, not an error — so it is simply
/// called every time rather than tracked.
fn com_init() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// The executable name behind a process id.
fn exe_name(pid: u32) -> Option<String> {
    unsafe {
        // QUERY_LIMITED_INFORMATION rather than QUERY_INFORMATION: it is the
        // one that works without elevation against processes we do not own,
        // which is most of them.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut buf = [0u16; MAX_PATH as usize];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        ok.ok()?;

        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit('\\').next().map(|s| s.to_string())
    }
}

/// Every process on the machine as (pid, parent pid, exe name).
///
/// Needed because "one app" is rarely one process. Discord runs several;
/// browsers run one per tab. The audio session belongs to whichever child is
/// actually decoding, and that child is useless as a capture target — process
/// loopback can include a target's *descendants*, not its ancestors, so
/// capturing a leaf gets silence. The root has to be found first.
fn process_table() -> Vec<(u32, u32, String)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                out.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..len]),
                ));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

/// Walk up from `pid` while the parent is the same executable.
///
/// Stops as soon as the parent is something else — otherwise every app would
/// resolve to explorer.exe, and ROOMTONE would offer to capture the entire
/// desktop under the name "Spotify".
fn tree_root(pid: u32, table: &[(u32, u32, String)]) -> u32 {
    let Some(exe) = table.iter().find(|(p, _, _)| *p == pid).map(|(_, _, e)| e.clone()) else {
        return pid;
    };

    let mut current = pid;
    // A bound, because a corrupted table with a parent cycle would otherwise
    // spin here forever.
    for _ in 0..16 {
        let Some((_, parent, _)) = table.iter().find(|(p, _, _)| *p == current) else { break };
        let parent = *parent;
        if parent == 0 || parent == current {
            break;
        }
        match table.iter().find(|(p, _, _)| *p == parent) {
            Some((_, _, pexe)) if pexe.eq_ignore_ascii_case(&exe) => current = parent,
            _ => break,
        }
    }
    current
}

/// `Spotify.exe` -> `Spotify`. Good enough, and honest about what it is.
fn pretty(exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").unwrap_or(exe);
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => stem.to_string(),
    }
}

/// The process to capture for a given executable name, or `None` if it is not
/// running.
///
/// Resolved fresh every time rather than remembered, because a process id is
/// meaningless across a reboot — the executable name is the part that is stable
/// enough to write to a config file.
pub fn pid_for_exe(exe: &str) -> Option<u32> {
    let table = process_table();
    // Lowest pid first is a decent proxy for "started earliest", which for a
    // multi-process app is usually the parent; `tree_root` then confirms it.
    let mut candidates: Vec<u32> = table
        .iter()
        .filter(|(_, _, e)| e.eq_ignore_ascii_case(exe))
        .map(|(pid, _, _)| *pid)
        .collect();
    candidates.sort_unstable();
    candidates.first().map(|pid| tree_root(*pid, &table))
}

/// Every application with an audio session on the default output device.
pub fn list() -> Vec<AppSource> {
    com_init();

    let mut out: Vec<AppSource> = Vec::new();
    let table = process_table();
    let self_pid = std::process::id();

    unsafe {
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return out;
        };
        let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) else {
            return out;
        };
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
            return out;
        };
        let Ok(sessions) = manager.GetSessionEnumerator() else {
            return out;
        };
        let Ok(count) = sessions.GetCount() else {
            return out;
        };
        crate::log::event(&format!("audio: {count} raw audio session(s)"));

        for i in 0..count {
            let Ok(control) = sessions.GetSession(i) else { continue };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };

            // Not `IsSystemSoundsSession()`.
            //
            // That call returns S_OK when the session *is* system sounds and
            // S_FALSE when it is not — and windows-rs folds both into `Ok(())`,
            // because S_FALSE is a success code. Testing it with `.is_ok()`
            // therefore matched every session and emptied the entire list.
            //
            // The system sounds session reports process id 0, which is the same
            // filter and is not ambiguous.
            let Ok(pid) = control2.GetProcessId() else { continue };
            if pid == 0 || pid == self_pid {
                continue;
            }

            let Some(exe) = exe_name(pid) else {
                crate::log::event(&format!("audio: session pid {pid} — no executable name"));
                continue;
            };

            // Never offer to capture ourselves: it is a feedback loop, and the
            // loopback stream gives us a session of our own.
            if exe.eq_ignore_ascii_case("roomtone.exe") {
                continue;
            }

            // Compared with `==`, not matched as a pattern.
            //
            // `matches!(x, Ok(AudioSessionStateActive))` reads like a
            // comparison and happens to be one here — but only because the
            // constant is in scope. Take that import away and the same line
            // silently becomes a binding that matches anything, and every
            // session would report as playing. Not a trap worth leaving.
            let active = control
                .GetState()
                .map(|state| state == AudioSessionStateActive)
                .unwrap_or(false);
            let root = tree_root(pid, &table);

            // Collapse by executable, not by process id. Discord holds several
            // sessions across several processes; listing it five times is not a
            // feature. If any of them is making sound, the app is.
            if let Some(existing) = out.iter_mut().find(|a| a.exe.eq_ignore_ascii_case(&exe)) {
                existing.active |= active;
                // Prefer the highest ancestor found so far — capturing that one
                // covers the whole family.
                if root < existing.pid {
                    existing.pid = root;
                }
                continue;
            }

            out.push(AppSource {
                pid: root,
                name: pretty(&exe),
                exe,
                active,
            });
        }
    }

    // Whatever is making sound right now goes first; then alphabetical, so the
    // list does not reshuffle itself every time the picker opens.
    out.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}
