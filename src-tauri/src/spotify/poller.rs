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

//! Path B: what is playing right now.
//!
//! Polls `/me/player/currently-playing` every three seconds and emits one
//! event to the window. Three seconds is deliberately slow — the progress bar
//! is interpolated locally between polls, so the endpoint does not need
//! hammering to look smooth.
//!
//! This path is allowed to fail. If Spotify is unreachable the visuals carry on
//! from the audio path regardless; the window simply shows nothing playing.
//!
//! ## Why this does not use rspotify's model types
//!
//! rspotify handles the OAuth dance well, but its `FullTrack` model does not
//! currently deserialise Spotify's live `currently-playing` payload — the
//! response arrives with `currently_playing_type: "track"` and then falls
//! through to `PlayableItem::Unknown`, so the track silently never appears.
//!
//! Rather than pin an older rspotify and hope, this reads the endpoint directly
//! and parses only the seven fields ROOMTONE actually needs. Unknown fields are
//! ignored, so the next thing Spotify adds cannot break playback display.
//! rspotify still owns authorisation and token refresh, where it earns its keep.

use rspotify::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "track";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const ENDPOINT: &str =
    "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode";

#[derive(Debug, Clone, Default, Serialize)]
pub struct NowPlaying {
    /// Is ROOMTONE authorised at all?
    pub connected: bool,
    /// Does Spotify have an active player? (No device open = no track.)
    pub active: bool,
    pub is_playing: bool,
    pub track_id: Option<String>,
    pub name: Option<String>,
    pub artists: Option<String>,
    pub album: Option<String>,
    pub duration_ms: u64,
    pub progress_ms: u64,
    pub cover_url: Option<String>,
    /// Local path once the image has been cached to disk.
    pub cover_cached: Option<String>,
    /// Accent colour pulled out of the cover art. This is what makes the room
    /// follow the album rather than the app.
    pub accent: Option<String>,
    /// A second, genuinely different hue from the same cover, and the dark
    /// ground beneath both. Absent when the artwork has no colour in it.
    pub accent2: Option<String>,
    pub deep: Option<String>,
    /// Milliseconds the Spotify request itself took — shown in diagnostics.
    pub poll_ms: u64,
    pub error: Option<String>,
}

/// Log a palette the first time it is seen, and never again.
///
/// The obvious version compared against the field being filled in — which is
/// freshly empty on every poll, so it logged the same three colours every three
/// seconds forever. The comparison has to be against what was last *logged*,
/// which means remembering it.
fn log_palette_once(p: &super::artwork::Palette) {
    use std::sync::Mutex;
    static LAST: Mutex<Option<String>> = Mutex::new(None);

    let Ok(mut last) = LAST.lock() else { return };
    if last.as_deref() == Some(p.accent.as_str()) {
        return;
    }
    *last = Some(p.accent.clone());
    crate::log::event(&format!(
        "cover: palette {} / {} / {}",
        p.accent, p.second, p.deep
    ));
}

/* -- the slice of Spotify's response ROOMTONE reads ---------------------- */

#[derive(Debug, Deserialize)]
struct Response {
    #[serde(default)]
    is_playing: bool,
    #[serde(default)]
    progress_ms: Option<u64>,
    #[serde(default)]
    item: Option<Item>,
}

#[derive(Debug, Deserialize)]
struct Item {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    /// Tracks.
    #[serde(default)]
    artists: Vec<Named>,
    #[serde(default)]
    album: Option<Album>,
    /// Podcast episodes carry their own images and a show instead.
    #[serde(default)]
    images: Vec<Image>,
    #[serde(default)]
    show: Option<Named>,
}

#[derive(Debug, Deserialize)]
struct Album {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Debug, Deserialize)]
struct Named {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Image {
    url: String,
    #[serde(default)]
    width: Option<u32>,
}

fn largest(images: &[Image]) -> Option<String> {
    images
        .iter()
        .max_by_key(|i| i.width.unwrap_or(0))
        .map(|i| i.url.clone())
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/* -- the loop ------------------------------------------------------------ */

pub const LYRICS_EVENT: &str = "lyrics";

pub fn spawn(app: AppHandle) {
    crate::log::event("poller: starting");
    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        let mut last_track = String::new();
        loop {
            let payload = poll_once().await;

            // Log only when the picture changes, so the file stays readable.
            //
            // The comparison deliberately leaves out `poll_ms`. It was in here,
            // and because the round trip is a few milliseconds different every
            // single time, the "has anything changed" test was always true — so
            // this logged every three seconds forever, which is roughly thirty
            // thousand lines for a day of listening. A changing measurement can
            // be *in* the line; it cannot be part of deciding whether to write
            // the line.
            let state = format!(
                "connected={} active={} playing={} has_track={} err={}",
                payload.connected,
                payload.active,
                payload.is_playing,
                payload.name.is_some(),
                payload.error.as_deref().unwrap_or("-")
            );
            if state != last {
                crate::log::event(&format!("poll: {state} poll_ms={}", payload.poll_ms));
                last = state;
            }

            // Path C fires once, when the track changes — never on a poll.
            if let Some(id) = payload.track_id.clone() {
                if id != last_track {
                    last_track = id.clone();
                    let handle = app.clone();
                    let name = payload.name.clone().unwrap_or_default();
                    let artists = payload.artists.clone().unwrap_or_default();
                    let album = payload.album.clone().unwrap_or_default();
                    let duration = payload.duration_ms;

                    tauri::async_runtime::spawn(async move {
                        let lyrics =
                            crate::lyrics::resolve(&id, &name, &artists, &album, duration).await;
                        let _ = handle.emit(LYRICS_EVENT, lyrics);
                    });
                }
            } else if !last_track.is_empty() {
                last_track.clear();
                let _ = app.emit(
                    LYRICS_EVENT,
                    crate::lyrics::Lyrics {
                        track_id: String::new(),
                        lines: Vec::new(),
                        source: "none",
                    },
                );
            }

            if let Err(e) = app.emit(EVENT, payload) {
                crate::log::event(&format!("poller: emit FAILED: {e}"));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

/// Current access token, refreshing first if it has expired.
pub async fn access_token(client: &rspotify::AuthCodePkceSpotify) -> Result<String, String> {
    let expired = {
        let guard = client
            .token
            .lock()
            .await
            .map_err(|_| "token lock poisoned".to_string())?;
        guard.as_ref().map(|t| t.is_expired()).unwrap_or(true)
    };

    if expired {
        client
            .refresh_token()
            .await
            .map_err(|e| format!("could not refresh Spotify token: {e}"))?;
        super::persist_if_changed(client).await;
    }

    let guard = client
        .token
        .lock()
        .await
        .map_err(|_| "token lock poisoned".to_string())?;
    guard
        .as_ref()
        .map(|t| t.access_token.clone())
        .ok_or_else(|| "no access token".to_string())
}

async fn poll_once() -> NowPlaying {
    let started = std::time::Instant::now();

    let session = super::session();
    let guard = session.lock().await;

    let Some(client) = guard.as_ref() else {
        return NowPlaying::default();
    };

    let mut out = NowPlaying {
        connected: true,
        ..Default::default()
    };

    let token = match access_token(client).await {
        Ok(t) => t,
        Err(e) => {
            out.error = Some(e);
            out.poll_ms = started.elapsed().as_millis() as u64;
            return out;
        }
    };

    let response = http()
        .get(ENDPOINT)
        .bearer_auth(&token)
        .timeout(Duration::from_secs(8))
        .send()
        .await;

    out.poll_ms = started.elapsed().as_millis() as u64;

    let response = match response {
        Ok(r) => r,
        Err(e) => {
            out.error = Some(format!("Spotify unreachable: {e}"));
            return out;
        }
    };

    // 204: authorised, but nothing is loaded in any player.
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return out;
    }

    if !response.status().is_success() {
        out.error = Some(format!("Spotify returned {}", response.status()));
        return out;
    }

    let body = match response.text().await {
        Ok(b) => b,
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    };

    // An empty 200 body means the same as a 204 in practice.
    if body.trim().is_empty() {
        return out;
    }

    let parsed: Response = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => {
            out.error = Some(format!("could not read Spotify's response: {e}"));
            return out;
        }
    };

    out.active = true;
    out.is_playing = parsed.is_playing;
    out.progress_ms = parsed.progress_ms.unwrap_or(0);

    if let Some(item) = parsed.item {
        out.name = item.name;
        out.duration_ms = item.duration_ms.unwrap_or(0);
        out.track_id = item.id;

        let artists: Vec<&str> = item
            .artists
            .iter()
            .filter_map(|a| a.name.as_deref())
            .collect();

        if !artists.is_empty() {
            out.artists = Some(artists.join(", "));
        } else if let Some(show) = item.show.as_ref().and_then(|s| s.name.clone()) {
            // Podcast episode.
            out.artists = Some(show);
        }

        if let Some(album) = item.album {
            out.cover_url = largest(&album.images);
            out.album = album.name;
        } else {
            out.cover_url = largest(&item.images);
            out.album = item.show.and_then(|s| s.name);
        }
    }

    // Cache the cover once per track. `ensure` returns immediately on a hit.
    if let (Some(id), Some(url)) = (out.track_id.as_deref(), out.cover_url.as_deref()) {
        out.cover_cached = super::artwork::ensure(id, url).await;

        if let Some(path) = out.cover_cached.as_deref() {
            if let Some(p) = super::artwork::palette(path) {
                log_palette_once(&p);
                out.accent = Some(p.accent);
                out.accent2 = Some(p.second);
                out.deep = Some(p.deep);
            }
        }
    }

    out
}
