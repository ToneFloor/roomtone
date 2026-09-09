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

//! Cover-art disk cache.
//!
//! Spotify returns cover art as a CDN URL that changes per release but not per
//! play, so each track's image only ever needs fetching once. Cached by track
//! ID under `%APPDATA%/roomtone/artwork/`.
//!
//! Later steps read these files to extract the accent colour that tints every
//! visual layer; caching here means that work happens once per track rather
//! than once per poll.

use std::path::PathBuf;

/// The colours pulled out of one cover.
///
/// `accent` is the lead — the one the whole room takes its hue from. `second`
/// is a genuinely different hue from the same artwork, used where a preset needs
/// two colours and would otherwise invent the second by darkening the first;
/// a darkened copy of one colour reads as a shadow, two real colours read as
/// artwork. `deep` is the dark ground everything sits on.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Palette {
    pub accent: String,
    pub second: String,
    pub deep: String,
}

/// Every usable colour cluster in a cover, as HSL, most vivid first.
fn clusters(path: &str) -> Option<Vec<[f32; 3]>> {
    let img = image::open(path).ok()?;
    let small = img
        .resize_exact(32, 32, image::imageops::FilterType::Triangle)
        .to_rgb8();

    let palette =
        color_thief::get_palette(small.as_raw(), color_thief::ColorFormat::Rgb, 5, 8).ok()?;

    let mut scored: Vec<(f32, [f32; 3])> = Vec::new();
    for c in palette {
        let (h, s, l) = to_hsl(c.r, c.g, c.b);

        // Ignore near-black and near-white clusters — they carry no hue and
        // would produce a grey "accent".
        if !(0.08..=0.94).contains(&l) {
            continue;
        }

        // Saturation decides, with a mild preference for mid lightness so a
        // very dark saturated corner does not win outright.
        let score = s * (1.0 - (l - 0.5).abs());
        scored.push((score, [h, s, l]));
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Some(scored.into_iter().map(|(_, hsl)| hsl).collect())
}

/// Shortest distance between two hues on the colour wheel, in degrees.
fn hue_gap(a: f32, b: f32) -> f32 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

fn hex(h: f32, s: f32, l: f32) -> String {
    let (r, g, b) = from_hsl(h, s, l);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// The full palette for a cover, or `None` when the artwork has no colour in it.
pub fn palette(path: &str) -> Option<Palette> {
    let list = clusters(path)?;
    let [h, s, l] = *list.first()?;

    // A black-and-white cover has no colour to follow. Flooring the saturation
    // of a near-grey cluster invents a hue that is not in the artwork — which
    // is how a monochrome sleeve ends up tinting the whole room muddy red. When
    // there is genuinely no colour, say so and let the app use its own accent.
    if s < 0.14 {
        return None;
    }

    let accent_h = h;
    let accent = hex(h, s.max(0.55), l.clamp(0.45, 0.68));

    // The second colour has to be a different hue, not merely the next cluster
    // along — covers are often five shades of the same blue, and picking the
    // runner-up would give two colours nobody can tell apart. At least 40
    // degrees away is the smallest gap that still reads as "another colour".
    let second = list
        .iter()
        .skip(1)
        .find(|[hh, ss, _]| *ss >= 0.14 && hue_gap(*hh, accent_h) >= 40.0)
        .map(|[hh, ss, ll]| hex(*hh, ss.max(0.50), ll.clamp(0.40, 0.66)))
        // Nothing far enough away: rotate the lead hue instead. Invented, but
        // invented in a way that stays inside the cover's own character.
        .unwrap_or_else(|| hex((accent_h + 42.0) % 360.0, s.max(0.48), 0.34));

    // The ground. Same hue as the lead, taken almost to black, so the darkness
    // behind the visual belongs to the artwork rather than being flat grey.
    let deep = hex(accent_h, (s * 0.8).clamp(0.25, 0.7), 0.12);

    Some(Palette { accent, second, deep })
}

fn to_hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;

    if d.abs() < f32::EPSILON {
        return (0.0, 0.0, l);
    }

    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) * 60.0
    } else if max == g {
        ((b - r) / d + 2.0) * 60.0
    } else {
        ((r - g) / d + 4.0) * 60.0
    };
    (h, s, l)
}

fn from_hsl(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - (((h / 60.0) % 2.0) - 1.0).abs());
    let m = l - c / 2.0;

    let (r, g, b) = match h as u32 / 60 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };

    (
        ((r + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b + m) * 255.0).round().clamp(0.0, 255.0) as u8,
    )
}

fn cache_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("roomtone").join("artwork"))
}

/// Track IDs are base62, but never trust an ID from the network with a file
/// path. Anything unexpected is dropped.
fn safe(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(64)
        .collect()
}

/// Returns the local path, downloading the image if it is not cached yet.
pub async fn ensure(track_id: &str, url: &str) -> Option<String> {
    let id = safe(track_id);
    if id.is_empty() {
        return None;
    }

    let dir = cache_dir()?;
    let path = dir.join(format!("{id}.jpg"));

    if path.is_file() {
        return Some(path.to_string_lossy().into_owned());
    }

    std::fs::create_dir_all(&dir).ok()?;

    let bytes = reqwest::get(url).await.ok()?.bytes().await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    std::fs::write(&path, &bytes).ok()?;

    Some(path.to_string_lossy().into_owned())
}
