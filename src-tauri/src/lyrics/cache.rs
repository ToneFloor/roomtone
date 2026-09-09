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

//! The lyrics cache.
//!
//! A track's lyrics never change, so a track should be looked up once, ever.
//! SQLite in `%APPDATA%/roomtone/lyrics.sqlite`, keyed by Spotify track ID.
//!
//! Misses are cached too. Coverage outside popular music is thin, and without
//! a negative cache every obscure track re-queries LRCLIB on every play — which
//! is rude to a free service run by volunteers, and slow for the user.

use rusqlite::{params, Connection};
use std::path::PathBuf;

fn db_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let dir = PathBuf::from(appdata).join("roomtone");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("lyrics.sqlite"))
}

fn open() -> Option<Connection> {
    let conn = Connection::open(db_path()?).ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS lyrics (
             track_id TEXT PRIMARY KEY,
             lrc      TEXT,
             found    INTEGER NOT NULL,
             fetched  INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS offsets (
             track_id TEXT PRIMARY KEY,
             ms       INTEGER NOT NULL
         );",
    )
    .ok()?;
    Some(conn)
}

/// Per-track lyric offset, in milliseconds.
///
/// Most timing drift is in the LRC file, not in ROOMTONE — community timings
/// are sometimes made against a different master or a different edit. So the
/// correction belongs to the track and should survive being played again next
/// week, rather than being a slider the user re-finds every time.
pub fn offset_get(track_id: &str) -> i64 {
    let Some(conn) = open() else { return 0 };
    conn.prepare("SELECT ms FROM offsets WHERE track_id = ?1")
        .ok()
        .and_then(|mut stmt| stmt.query_row(params![track_id], |r| r.get(0)).ok())
        .unwrap_or(0)
}

pub fn offset_set(track_id: &str, ms: i64) {
    let Some(conn) = open() else { return };
    let _ = conn.execute(
        "INSERT OR REPLACE INTO offsets (track_id, ms) VALUES (?1, ?2)",
        params![track_id, ms],
    );
}

/// How long a *miss* is trusted.
///
/// A hit is permanent — a track's lyrics do not change. A miss is not: LRCLIB
/// gains entries constantly, and a lookup that failed because the network was
/// down would otherwise mark that track as having no lyrics for ever. Six hours
/// is long enough to spare the service, short enough that nobody has to know
/// this cache exists.
const MISS_TTL: i64 = 6 * 60 * 60;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `Some(Some(lrc))` cached and found, `Some(None)` cached miss that is still
/// fresh, `None` unknown — go and look.
pub fn get(track_id: &str) -> Option<Option<String>> {
    let conn = open()?;
    let mut stmt = conn
        .prepare("SELECT lrc, found, fetched FROM lyrics WHERE track_id = ?1")
        .ok()?;

    let row: Option<(Option<String>, i64, i64)> = stmt
        .query_row(params![track_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .ok();

    let (lrc, found, fetched) = row?;

    if found == 1 {
        return Some(lrc);
    }
    if now() - fetched < MISS_TTL {
        return Some(None);
    }
    None
}

/// Forget every cached miss. Exposed so a user who knows a track *does* have
/// lyrics can force a re-check without hunting for a database file.
pub fn clear_misses() {
    let Some(conn) = open() else { return };
    let _ = conn.execute("DELETE FROM lyrics WHERE found = 0", []);
}

pub fn put(track_id: &str, lrc: Option<&str>) {
    let Some(conn) = open() else { return };
    let now = now();

    let _ = conn.execute(
        "INSERT OR REPLACE INTO lyrics (track_id, lrc, found, fetched) VALUES (?1, ?2, ?3, ?4)",
        params![track_id, lrc, i64::from(lrc.is_some()), now],
    );
}
