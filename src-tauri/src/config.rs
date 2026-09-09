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

//! Where ROOMTONE keeps its settings: the Spotify Client ID, the interface's
//! own remembered state, and the window's last size and position.
//!
//! The ID is deliberately *not* compiled into the binary. Spotify applications
//! start in development mode and only permit up to 25 hand-added users, so a
//! shared ID would not work for anyone but its owner anyway. Each user
//! registers their own free application and pastes the ID in on first run.
//!
//! Resolution order:
//!   1. `%APPDATA%/roomtone/config.json`  — what the app itself writes
//!   2. `SPOTIFY_CLIENT_ID` environment variable
//!   3. a `.env` file at the repository root  — developer convenience only
//!
//! None of these are ever committed. See `.env.example`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CONFIG_DIR: &str = "roomtone";
const CONFIG_FILE: &str = "config.json";
const ENV_KEY: &str = "SPOTIFY_CLIENT_ID";

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub spotify_client_id: Option<String>,

    /// Whatever the interface wants remembered — chosen device, preset, slider
    /// positions, per-shader parameters. Deliberately opaque here: the front end
    /// owns the shape, and a new setting should not need a Rust change to
    /// survive a restart.
    #[serde(default)]
    pub ui: Option<serde_json::Value>,

    /// Last window geometry, so the app opens where it was left.
    #[serde(default)]
    pub window: Option<WindowBox>,

    /// Anything written by a newer version of ROOMTONE than this one.
    ///
    /// Without this, opening an older build would silently delete settings it
    /// did not recognise the moment anything else was saved. Round-tripping
    /// unknown keys costs one line and makes downgrades harmless.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowBox {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn config_dir() -> Option<PathBuf> {
    // %APPDATA% on Windows.
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(CONFIG_DIR))
}

fn config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(CONFIG_FILE))
}

pub fn load() -> AppConfig {
    let mut cfg: AppConfig = read_config().unwrap_or_default();

    if cfg.spotify_client_id.is_none() {
        cfg.spotify_client_id = client_id_from_env();
    }
    cfg
}

/// Same as `load`, but never inherits the Client ID from the environment.
///
/// `load` falls back to `.env` for developer convenience, and `save` writes
/// whatever it is handed — so saving a settings change during `cargo run` would
/// bake the developer's `.env` Client ID into the user's config file. Reading
/// the file alone keeps that from leaking.
fn load_file_only() -> AppConfig {
    read_config().unwrap_or_default()
}

/// Read and parse the config file, tolerating a byte-order mark.
///
/// Anything that hand-edits this file on Windows is liable to save it with a
/// UTF-8 BOM — Notepad and PowerShell's `Set-Content -Encoding utf8` both do.
/// `serde_json` treats those three bytes as a syntax error, and the whole file
/// then parses as "no settings at all", which looks exactly like the app having
/// forgotten everything. Three bytes are cheap to skip.
fn read_config() -> Option<AppConfig> {
    let text = config_path().and_then(|p| std::fs::read_to_string(p).ok())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match serde_json::from_str(text) {
        Ok(cfg) => Some(cfg),
        Err(e) => {
            // Say so rather than silently starting from defaults: a config that
            // will not parse is the difference between "I forgot your settings"
            // and "your settings file has a typo on line 12".
            crate::log::event(&format!("config: could not parse config.json ({e}) — using defaults"));
            None
        }
    }
}

/// The Client ID, or `None` if the user has not supplied one yet.
pub fn client_id() -> Option<String> {
    load()
        .spotify_client_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn set_client_id(id: &str) -> Result<(), String> {
    let mut cfg = load_file_only();
    cfg.spotify_client_id = Some(id.trim().to_string());
    save(&cfg)
}

/// The interface's remembered state, or `None` on a first run.
pub fn ui_state() -> Option<serde_json::Value> {
    load().ui
}

pub fn set_ui_state(value: serde_json::Value) -> Result<(), String> {
    let mut cfg = load_file_only();
    cfg.ui = Some(value);
    save(&cfg)
}

pub fn window_box() -> Option<WindowBox> {
    load().window
}

pub fn set_window_box(b: WindowBox) -> Result<(), String> {
    let mut cfg = load_file_only();
    cfg.window = Some(b);
    save(&cfg)
}

/// Write the config, atomically.
///
/// The settings and the Spotify Client ID share one file, and this is written
/// every time a slider settles. A half-written file would cost the user their
/// authentication setup as well as their preferences, so it goes to a temp file
/// beside the real one and is renamed into place — on Windows a rename over an
/// existing file is atomic, so a crash mid-write leaves the old config intact
/// rather than a truncated one.
fn save(cfg: &AppConfig) -> Result<(), String> {
    let dir = config_dir().ok_or("could not resolve %APPDATA%")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let final_path = dir.join(CONFIG_FILE);
    let temp_path = dir.join(format!("{CONFIG_FILE}.tmp"));

    std::fs::write(&temp_path, json).map_err(|e| e.to_string())?;
    std::fs::rename(&temp_path, &final_path).map_err(|e| e.to_string())
}

/// Environment variable, then a `.env` beside the project. Development only —
/// a shipped build never has a `.env` next to it.
fn client_id_from_env() -> Option<String> {
    if let Ok(v) = std::env::var(ENV_KEY) {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }

    // Walk up from the executable and from the working directory looking for a
    // `.env`. Covers both `cargo run` and `npm run tauri dev`.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        roots.extend(exe.ancestors().take(6).map(PathBuf::from));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.extend(cwd.ancestors().take(4).map(PathBuf::from));
    }

    for root in roots {
        let candidate = root.join(".env");
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    if k.trim() == ENV_KEY {
                        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
                        if !v.is_empty() {
                            return Some(v);
                        }
                    }
                }
            }
        }
    }
    None
}
