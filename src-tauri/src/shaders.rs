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

//! Shader presets: the six built-ins, plus whatever the user drops in.
//!
//! Built-ins are compiled into the binary from `shaders/` at the repository
//! root — the same plain `.frag` files a contributor reads, never inlined into
//! JavaScript, so the files in the repo are literally the ones that ship.
//!
//! User shaders live in `%APPDATA%/roomtone/shaders/` and are read fresh every
//! time, which is what makes hot-reload possible: save the file, see it.

use serde::Serialize;
use std::path::PathBuf;

/// The order here is the order in the preset dock.
const BUILTIN: [(&str, &str); 12] = [
    ("edge-glow.frag", include_str!("../../shaders/edge-glow.frag")),
    ("art-bloom.frag", include_str!("../../shaders/art-bloom.frag")),
    ("kinetic-type.frag", include_str!("../../shaders/kinetic-type.frag")),
    ("video-edit.frag", include_str!("../../shaders/video-edit.frag")),
    ("spectrum-ring.frag", include_str!("../../shaders/spectrum-ring.frag")),
    ("flow-field.frag", include_str!("../../shaders/flow-field.frag")),
    ("warp-tunnel.frag", include_str!("../../shaders/warp-tunnel.frag")),
    ("starfield.frag", include_str!("../../shaders/starfield.frag")),
    ("aurora.frag", include_str!("../../shaders/aurora.frag")),
    ("liquid-metal.frag", include_str!("../../shaders/liquid-metal.frag")),
    ("kaleido.frag", include_str!("../../shaders/kaleido.frag")),
    ("spotlights.frag", include_str!("../../shaders/spotlights.frag")),
];

#[derive(Debug, Clone, Serialize)]
pub struct Shader {
    pub file: String,
    pub source: String,
    /// "builtin" or "user" — the dock marks user shaders with the accent colour.
    pub kind: &'static str,
    /// Modification time in milliseconds, 0 for built-ins. Drives hot-reload.
    pub mtime: u64,
}

pub fn user_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("roomtone").join("shaders"))
}

/// Create the user shader folder and drop a starter file in it, once.
///
/// An empty folder teaches nobody anything. A working example that already
/// appears in the dock is the difference between a feature people know about
/// and a feature people use.
pub fn ensure_user_dir() {
    let Some(dir) = user_dir() else { return };
    if dir.exists() {
        return;
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join("bass-rings.frag"), STARTER);
}

const STARTER: &str = include_str!("../../shaders/examples/bass-rings.frag");

pub fn list() -> Vec<Shader> {
    let mut out: Vec<Shader> = BUILTIN
        .iter()
        .map(|(file, source)| Shader {
            file: (*file).to_string(),
            source: (*source).to_string(),
            kind: "builtin",
            mtime: 0,
        })
        .collect();

    let Some(dir) = user_dir() else { return out };
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };

    let mut user: Vec<Shader> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("frag") {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&path) else { continue };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        user.push(Shader {
            file: path
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default(),
            source,
            kind: "user",
            mtime,
        });
    }

    user.sort_by(|a, b| a.file.cmp(&b.file));
    out.extend(user);
    out
}

/// Just the user files and their timestamps — cheap enough to poll, so the app
/// can notice a saved edit without pulling every shader's source across.
#[derive(Debug, Clone, Serialize)]
pub struct Stamp {
    pub file: String,
    pub mtime: u64,
}

pub fn stamps() -> Vec<Stamp> {
    let Some(dir) = user_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };

    let mut out: Vec<Stamp> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("frag"))
        .map(|e| Stamp {
            file: e.file_name().to_string_lossy().into_owned(),
            mtime: e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        })
        .collect();

    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}
