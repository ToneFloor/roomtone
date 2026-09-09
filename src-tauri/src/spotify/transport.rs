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

//! Playback control — the transport buttons in the design.
//!
//! Every endpoint here is **Premium-only**. On a free account they return 403,
//! which is the honest place to discover the subscription tier now that
//! Spotify no longer reports it on the user endpoint.

use std::time::Duration;

const API: &str = "https://api.spotify.com/v1/me/player";

#[derive(Debug, Clone, Copy)]
pub enum Action {
    Play,
    Pause,
    Next,
    Previous,
    Seek(u64),
}

impl Action {
    fn parse(name: &str, position_ms: Option<u64>) -> Result<Self, String> {
        Ok(match name {
            "play" => Action::Play,
            "pause" => Action::Pause,
            "next" => Action::Next,
            "previous" => Action::Previous,
            "seek" => Action::Seek(position_ms.ok_or("seek needs a position")?),
            other => return Err(format!("unknown transport action: {other}")),
        })
    }
}

pub async fn run(name: &str, position_ms: Option<u64>) -> Result<(), String> {
    let action = Action::parse(name, position_ms)?;

    let session = super::session();
    let guard = session.lock().await;
    let client = guard.as_ref().ok_or("not connected to Spotify")?;

    let token = super::poller::access_token(client).await?;

    let http = reqwest::Client::new();
    let request = match action {
        Action::Play => http.put(format!("{API}/play")).header("Content-Length", "0"),
        Action::Pause => http.put(format!("{API}/pause")).header("Content-Length", "0"),
        Action::Next => http.post(format!("{API}/next")).header("Content-Length", "0"),
        Action::Previous => http.post(format!("{API}/previous")).header("Content-Length", "0"),
        Action::Seek(ms) => http
            .put(format!("{API}/seek?position_ms={ms}"))
            .header("Content-Length", "0"),
    };

    let response = request
        .bearer_auth(&token)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("Spotify unreachable: {e}"))?;

    match response.status().as_u16() {
        200..=299 => Ok(()),
        403 => Err("Spotify Premium is required for playback control".into()),
        404 => Err("no active Spotify device — start playback somewhere first".into()),
        429 => Err("Spotify is rate limiting; try again shortly".into()),
        other => Err(format!("Spotify returned {other}")),
    }
}
