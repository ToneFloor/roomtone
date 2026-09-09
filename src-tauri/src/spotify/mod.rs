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

//! Path B, part one: getting and keeping Spotify authorisation.
//!
//! Desktop applications cannot keep a secret, so ROOMTONE uses the
//! Authorization Code flow with PKCE. There is no backend and no client secret
//! anywhere in the binary. The refresh token lives in the Windows Credential
//! Manager; see `tokens.rs`.

pub mod artwork;
pub mod callback;
pub mod poller;
pub mod transport;
pub mod tokens;

use rspotify::{prelude::*, scopes, AuthCodePkceSpotify, Config, Credentials, OAuth};
use serde::Serialize;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

/// The one authorised client, shared by every path that talks to Spotify.
///
/// It is a single mutex rather than a client per caller on purpose: PKCE
/// refresh tokens rotate, so two callers refreshing at once would invalidate
/// each other and lock the user out until they reconnected by hand.
type Session = Arc<AsyncMutex<Option<AuthCodePkceSpotify>>>;

static SESSION: OnceLock<Session> = OnceLock::new();

/// Last refresh token written to the Credential Manager, so repeated polls do
/// not rewrite an unchanged value every three seconds.
static LAST_SAVED: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();

pub fn session() -> Session {
    SESSION
        .get_or_init(|| Arc::new(AsyncMutex::new(None)))
        .clone()
}

/// What the front end knows about the Spotify connection.
#[derive(Debug, Default, Clone, Serialize)]
pub struct Status {
    /// Has the user supplied a Client ID yet?
    pub client_id_set: bool,
    pub connected: bool,
    pub display_name: Option<String>,
    /// "premium" or "free". Playback control is Premium-only.
    pub product: Option<String>,
    pub error: Option<String>,
}

fn oauth() -> OAuth {
    OAuth {
        redirect_uri: callback::REDIRECT_URI.to_string(),
        scopes: scopes!(
            "user-read-playback-state",
            "user-read-currently-playing",
            "user-modify-playback-state"
        ),
        ..Default::default()
    }
}

/// No on-disk token cache — we store tokens in the Credential Manager instead,
/// and rspotify's default would drop a JSON file next to the executable.
fn config() -> Config {
    Config {
        token_cached: false,
        token_refreshing: true,
        ..Default::default()
    }
}

fn creds(client_id: &str) -> Credentials {
    Credentials::new_pkce(client_id)
}

/// Read the token currently held by a client and persist it.
///
/// Called after every request and every refresh, because Spotify rotates PKCE
/// refresh tokens: the old one stops working the moment a new one is issued.
async fn persist(client: &AuthCodePkceSpotify) -> Result<(), String> {
    let guard = client
        .token
        .lock()
        .await
        .map_err(|_| "token lock poisoned".to_string())?;
    if let Some(token) = guard.as_ref() {
        tokens::save(token)?;
        remember(token.refresh_token.clone());
    }
    Ok(())
}

fn remember(refresh_token: Option<String>) {
    let cell = LAST_SAVED.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut slot) = cell.lock() {
        *slot = refresh_token;
    }
}

/// The most recent refresh token we know about.
fn known_refresh() -> Option<String> {
    LAST_SAVED
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
}

/// Spotify's refresh response does not always carry a new refresh token, and
/// rspotify does not carry the old one forward when it is absent. Left alone,
/// that writes a token with no refresh token at all to the Credential Manager —
/// which looks fine until the next launch, when there is nothing to refresh
/// with and the user is silently logged out.
///
/// So after every refresh, put the refresh token back if it went missing.
async fn patch_refresh(client: &AuthCodePkceSpotify) {
    let Ok(mut guard) = client.token.lock().await else {
        return;
    };
    let Some(token) = guard.as_mut() else {
        return;
    };
    if token.refresh_token.is_none() {
        token.refresh_token = known_refresh();
        if token.refresh_token.is_some() {
            crate::log::event("refresh token was absent from the response — carried the old one forward");
        }
    }
}

fn already_saved(refresh_token: &Option<String>) -> bool {
    LAST_SAVED
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .map(|slot| slot.as_ref() == refresh_token.as_ref())
        .unwrap_or(false)
}

/// Write the token back only when Spotify has issued a new refresh token.
///
/// rspotify refreshes transparently mid-request. Because PKCE rotates the
/// refresh token, missing one of those rotations means the next app launch
/// cannot reauthorise — so every path that makes a request calls this after.
pub async fn persist_if_changed(client: &AuthCodePkceSpotify) {
    patch_refresh(client).await;

    let Ok(guard) = client.token.lock().await else {
        return;
    };
    let Some(token) = guard.as_ref() else {
        return;
    };
    if already_saved(&token.refresh_token) {
        return;
    }
    if tokens::save(token).is_ok() {
        crate::log::event("token rotated and re-saved");
        remember(token.refresh_token.clone());
    }
}

async fn describe(client: &AuthCodePkceSpotify) -> Result<(Option<String>, Option<String>), String> {
    let me = client.me().await.map_err(|e| e.to_string())?;

    // Spotify is retiring the `product` field, and it was only ever populated
    // with the `user-read-private` scope, which ROOMTONE does not request. So
    // treat it as a bonus if present and confirm Premium the honest way
    // instead: the first playback-control call either works or returns 403.
    #[allow(deprecated)]
    let product = me.product.map(|p| format!("{p:?}").to_lowercase());

    Ok((me.display_name, product))
}

/// Called at startup. Restores a stored session without any user interaction.
pub async fn restore() -> Status {
    let Some(client_id) = crate::config::client_id() else {
        return Status::default();
    };

    let mut status = Status {
        client_id_set: true,
        ..Default::default()
    };

    let session = session();
    let mut guard = session.lock().await;

    // Already live — describe it rather than refreshing again. Two refreshes in
    // flight at once would invalidate each other.
    if let Some(client) = guard.as_ref() {
        match describe(client).await {
            Ok((display_name, product)) => {
                status.connected = true;
                status.display_name = display_name;
                status.product = product;
            }
            Err(e) => status.error = Some(e),
        }
        return status;
    }

    let Some(token) = tokens::load() else {
        return status;
    };

    // No refresh token means nothing can be renewed — the stored session is
    // already dead. Say so plainly rather than failing later with a confusing
    // "token is not valid".
    let Some(stored_refresh) = token.refresh_token.clone() else {
        crate::log::event("restore: stored token has no refresh token — clearing");
        let _ = tokens::clear();
        status.error = Some("your saved Spotify session expired — please reconnect".into());
        return status;
    };
    remember(Some(stored_refresh));

    let client = AuthCodePkceSpotify::from_token_with_config(
        token,
        creds(&client_id),
        oauth(),
        config(),
    );

    crate::log::event("restore: loaded stored token");

    // Always refresh on launch: the stored access token has almost certainly
    // expired (they last an hour), and refreshing proves the session is still
    // good before the UI claims it is.
    if let Err(e) = client.refresh_token().await {
        crate::log::event(&format!("restore: refresh FAILED: {e}"));
        // The stored token is dead — most often because a previous refresh was
        // interrupted after Spotify rotated it. Clear it and ask for a fresh
        // login rather than leaving the user stuck.
        let _ = tokens::clear();
        status.error = Some(format!("stored session expired, please reconnect ({e})"));
        return status;
    }

    patch_refresh(&client).await;
    crate::log::event("restore: refresh ok");

    if let Err(e) = persist(&client).await {
        crate::log::event(&format!("restore: persist FAILED: {e}"));
        status.error = Some(e);
        return status;
    }

    match describe(&client).await {
        Ok((display_name, product)) => {
            crate::log::event("restore: me() ok, session live");
            status.connected = true;
            status.display_name = display_name;
            status.product = product;
            *guard = Some(client);
        }
        Err(e) => {
            crate::log::event(&format!("restore: me() FAILED: {e}"));
            let _ = tokens::clear();
            remember(None);
            status.error = Some("your saved Spotify session expired — please reconnect".into());
            let _ = e;
        }
    }
    status
}

/// The full interactive flow. Opens the user's real browser.
pub async fn connect() -> Status {
    let Some(client_id) = crate::config::client_id() else {
        return Status {
            error: Some("no Spotify Client ID set".into()),
            ..Default::default()
        };
    };

    let mut status = Status {
        client_id_set: true,
        ..Default::default()
    };

    let mut client = AuthCodePkceSpotify::with_config(creds(&client_id), oauth(), config());

    let url = match client.get_authorize_url(None) {
        Ok(u) => u,
        Err(e) => {
            status.error = Some(e.to_string());
            return status;
        }
    };

    // Bind before opening the browser so the redirect cannot arrive early.
    let listener = match callback::bind() {
        Ok(l) => l,
        Err(e) => {
            status.error = Some(e);
            return status;
        }
    };

    if let Err(e) = open_in_browser(&url) {
        status.error = Some(e);
        return status;
    }

    let code = match tauri::async_runtime::spawn_blocking(move || callback::wait_for_code(listener))
        .await
    {
        Ok(Ok(code)) => code,
        Ok(Err(e)) => {
            status.error = Some(e);
            return status;
        }
        Err(e) => {
            status.error = Some(e.to_string());
            return status;
        }
    };

    crate::log::event("connect: got authorisation code");

    if let Err(e) = client.request_token(&code).await {
        crate::log::event(&format!("connect: token exchange FAILED: {e}"));
        status.error = Some(format!("token exchange failed: {e}"));
        return status;
    }

    if let Err(e) = persist(&client).await {
        status.error = Some(e);
        return status;
    }

    crate::log::event("connect: token stored");
    patch_refresh(&client).await;

    match describe(&client).await {
        Ok((display_name, product)) => {
            crate::log::event("connect: session live");
            status.connected = true;
            status.display_name = display_name;
            status.product = product;
            *session().lock().await = Some(client);
        }
        Err(e) => status.error = Some(e),
    }
    status
}

pub async fn disconnect() -> Status {
    *session().lock().await = None;
    remember(None);
    let err = tokens::clear().err();
    Status {
        client_id_set: crate::config::client_id().is_some(),
        connected: false,
        error: err,
        ..Default::default()
    }
}

/// Hand the URL to Windows' default browser.
///
/// `rundll32 url.dll,FileProtocolHandler` is used rather than `cmd /C start`
/// because the authorise URL contains `&`, which `cmd` would try to interpret.
fn open_in_browser(url: &str) -> Result<(), String> {
    use std::process::Command;

    #[cfg(windows)]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open your browser: {e}"))
    }

    #[cfg(not(windows))]
    {
        let _ = url;
        Err("ROOMTONE is Windows-only".into())
    }
}
