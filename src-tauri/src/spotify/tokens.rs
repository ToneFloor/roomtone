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

//! Refresh token storage, via the Windows Credential Manager.
//!
//! The token never touches a config file or the repository. `keyring` writes it
//! to the Credential Manager, where it is encrypted at rest under the Windows
//! user account.
//!
//! One PKCE quirk worth knowing: Spotify *rotates* the refresh token. Each
//! refresh returns a new one and invalidates the old. So every refresh has to
//! be written straight back here or the next app launch will fail to
//! reauthorise.

use keyring::Entry;
use rspotify::Token;

const SERVICE: &str = "ROOMTONE";
const ACCOUNT: &str = "spotify-token";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("credential manager unavailable: {e}"))
}

pub fn save(token: &Token) -> Result<(), String> {
    let json = serde_json::to_string(token).map_err(|e| e.to_string())?;
    entry()?
        .set_password(&json)
        .map_err(|e| format!("could not write token: {e}"))
}

pub fn load() -> Option<Token> {
    let e = entry().ok()?;
    let json = e.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not clear token: {e}")),
    }
}
