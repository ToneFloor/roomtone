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

//! A deliberately boring event log for the Spotify path.
//!
//! Written to `%APPDATA%/roomtone/auth.log`. It records *what happened*, never
//! tokens, IDs, paths, or anything else identifying — the file is safe to paste
//! into a bug report, which is the point of it existing.

use std::io::Write;
use std::sync::Mutex;

/// One writer at a time.
///
/// Append mode is not enough on its own: capture, analysis, polling and the UI
/// all log from different threads, and two `writeln!` calls landing together
/// produced a line with both timestamps and both messages spliced into each
/// other. Diagnostics that garble themselves under concurrency are worst
/// exactly when concurrency is the bug being chased.
static WRITER: Mutex<()> = Mutex::new(());

/// Keep the log from growing without limit.
///
/// This file is append-only and the app is meant to be left running for hours,
/// so without a ceiling it is a slow leak that nobody notices until it is
/// hundreds of megabytes. One rename at the limit keeps the last two windows of
/// history — enough to diagnose something that happened a while ago, bounded at
/// twice the cap.
fn rotate(dir: &std::path::Path) {
    const LIMIT: u64 = 1_000_000;

    let path = dir.join("auth.log");
    let Ok(meta) = std::fs::metadata(&path) else { return };
    if meta.len() < LIMIT {
        return;
    }
    let _ = std::fs::rename(&path, dir.join("auth.prev.log"));
}

pub fn event(what: &str) {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    let dir = std::path::PathBuf::from(appdata).join("roomtone");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // A poisoned lock here means another thread panicked mid-log; the file is
    // still fine to append to, so take the guard anyway rather than losing
    // every message after the first panic.
    let _guard = WRITER.lock().unwrap_or_else(|e| e.into_inner());

    rotate(&dir);

    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("auth.log"))
    {
        let _ = writeln!(f, "{stamp}  {what}");
    }
}
