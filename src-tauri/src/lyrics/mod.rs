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

//! Path C: synchronised lyrics.
//!
//! Fired once when the track changes, then never touched again. Spotify's
//! public API exposes no timed lyrics at all, so these come from LRCLIB — free,
//! open, MIT, no API key and no account.
//!
//! This path is allowed to come back empty, and usually does outside popular
//! music. That is why the art-bloom fallback is a first-class visual state
//! rather than an error screen: for most tracks, it *is* the design.

pub mod cache;
pub mod lrc;

use serde::{Deserialize, Serialize};
use std::time::Duration;

const API: &str = "https://lrclib.net/api/get";
const SEARCH: &str = "https://lrclib.net/api/search";

/// LRCLIB asks clients to identify themselves. Naming the app and its repo is
/// the polite minimum for a free service run by volunteers.
const AGENT: &str = concat!(
    "ROOMTONE/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/ToneFloor/roomtone)"
);

/// The most recently resolved lyrics, so the window can ask for them rather
/// than rely on catching a single event.
static CURRENT: std::sync::OnceLock<std::sync::Mutex<Option<Lyrics>>> = std::sync::OnceLock::new();

pub fn current() -> Option<Lyrics> {
    CURRENT
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
}

fn remember(lyrics: &Lyrics) {
    if let Ok(mut slot) = CURRENT.get_or_init(|| std::sync::Mutex::new(None)).lock() {
        *slot = Some(lyrics.clone());
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Lyrics {
    pub track_id: String,
    pub lines: Vec<lrc::Line>,
    /// "cache", "lrclib", "none" — shown in diagnostics, and honest about it.
    pub source: &'static str,
}

#[derive(Debug, Deserialize)]
struct Response {
    #[serde(rename = "syncedLyrics", default)]
    synced: Option<String>,
    #[serde(default)]
    instrumental: bool,
}

/// Spotify's artist string lists every credited artist: "THE SCOTTS, Travis
/// Scott, Kid Cudi". Lyrics databases index the primary one. Try the full
/// string first, since it is right when there is only one artist, then the
/// first name alone.
fn primary_artist(artists: &str) -> &str {
    artists.split(',').next().unwrap_or(artists).trim()
}

/// Strip the decorations Spotify adds and lyrics sites do not carry:
/// "Song (feat. X)", "Song - Remastered 2011", "Song - Radio Edit".
fn plain_title(title: &str) -> String {
    let mut out = title.to_string();
    if let Some(i) = out.find(" - ") {
        out.truncate(i);
    }
    while let Some(open) = out.rfind('(') {
        let lower = out[open..].to_lowercase();
        if lower.contains("feat") || lower.contains("with ") || lower.contains("remaster") {
            out.truncate(open);
        } else {
            break;
        }
    }
    out.trim().to_string()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(AGENT)
        .build()
        .unwrap_or_default()
}

/// Look a track up, cache first.
pub async fn resolve(
    track_id: &str,
    track: &str,
    artist: &str,
    album: &str,
    duration_ms: u64,
) -> Lyrics {
    if let Some(hit) = cache::get(track_id) {
        let lines = hit.as_deref().map(lrc::parse).unwrap_or_default();
        let source = if lines.is_empty() { "none" } else { "cache" };
        crate::log::event(&format!("lyrics: {source} ({} lines)", lines.len()));
        let out = Lyrics { track_id: track_id.to_string(), lines, source };
        remember(&out);
        return out;
    }

    let found = fetch(track, artist, album, duration_ms).await;
    cache::put(track_id, found.as_deref());

    let lines = found.as_deref().map(lrc::parse).unwrap_or_default();
    let source = if lines.is_empty() { "none" } else { "lrclib" };

    crate::log::event(&format!("lyrics: {source} ({} lines)", lines.len()));

    let out = Lyrics { track_id: track_id.to_string(), lines, source };
    remember(&out);
    out
}

async fn fetch(track: &str, artist: &str, album: &str, duration_ms: u64) -> Option<String> {
    let http = client();
    let seconds = (duration_ms as f64 / 1000.0).round() as u64;

    let primary = primary_artist(artist);
    let simple = plain_title(track);

    // Four attempts, cheapest and most exact first. Most tracks stop at the
    // first; the rest are why a naive single lookup feels like the service has
    // no coverage when it actually does.
    let attempts: Vec<(&str, &str, bool)> = vec![
        (track, artist, true),      // exactly what Spotify reported
        (track, primary, true),     // primary artist only
        (simple.as_str(), primary, true),
        (simple.as_str(), primary, false), // search, no album, duration-matched
    ];

    for (name, who, exact) in attempts {
        if name.is_empty() {
            continue;
        }
        let hit = if exact {
            try_get(&http, name, who, album, seconds).await
        } else {
            try_search(&http, name, who, seconds).await
        };
        if hit.is_some() {
            crate::log::event(&format!(
                "lyrics: matched via {} [{name} / {who}]",
                if exact { "get" } else { "search" }
            ));
            return hit;
        }
    }

    // Last resort: search on the title alone and let duration decide.
    try_search(&http, &simple, "", seconds).await
}

async fn try_get(
    http: &reqwest::Client,
    track: &str,
    artist: &str,
    album: &str,
    seconds: u64,
) -> Option<String> {

    let response = http
        .get(API)
        .query(&[
            ("track_name", track),
            ("artist_name", artist),
            ("album_name", album),
            ("duration", &seconds.to_string()),
        ])
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.json::<Response>().await.ok()?;
    if body.instrumental {
        return None;
    }
    body.synced.filter(|s| !s.trim().is_empty())
}

/// Search, then pick by duration. Album names differ between services more
/// often than anything else — deluxe editions, regional releases, remasters —
/// so dropping the album is what turns most misses into hits.
async fn try_search(
    http: &reqwest::Client,
    track: &str,
    artist: &str,
    seconds: u64,
) -> Option<String> {
    if track.is_empty() {
        return None;
    }

    let mut request = http.get(SEARCH).query(&[("track_name", track)]);
    if !artist.is_empty() {
        request = request.query(&[("artist_name", artist)]);
    }

    let results = request.timeout(Duration::from_secs(8)).send().await.ok()?;

    if !results.status().is_success() {
        return None;
    }

    let list: Vec<serde_json::Value> = results.json().await.ok()?;

    // Prefer the candidate closest in duration: same title by the same artist
    // can be an album cut, a single edit and a live version.
    let mut best: Option<(f64, String)> = None;
    for item in list {
        let Some(synced) = item.get("syncedLyrics").and_then(|v| v.as_str()) else { continue };
        if synced.trim().is_empty() {
            continue;
        }
        let their = item.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let drift = (their - seconds as f64).abs();
        if drift > 12.0 {
            continue;
        }
        if best.as_ref().map(|(d, _)| drift < *d).unwrap_or(true) {
            best = Some((drift, synced.to_string()));
        }
    }

    best.map(|(_, synced)| synced)
}
