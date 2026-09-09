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

//! LRC parsing, and the part the format cannot give us: word timings.
//!
//! LRC is line-level. Every line carries one timestamp and the whole line of
//! text. Kinetic type wants words, one landing at a time, so each line's words
//! have to be distributed across the interval to the next line.
//!
//! Distributing them evenly sounds fine and looks wrong — "the" and
//! "unbelievable" are not sung for the same length of time. Weighting by
//! syllable count is crude, costs nothing, and looks convincing.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Word {
    /// Seconds from the start of the track.
    pub t: f64,
    pub w: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Line {
    pub t: f64,
    pub text: String,
    pub words: Vec<Word>,
}

/// Rough English syllable count. Vowel groups, minus a silent trailing e.
///
/// It is wrong for plenty of words. It does not need to be right — it only
/// needs to make long words last longer than short ones.
fn syllables(word: &str) -> f64 {
    let lower: String = word
        .chars()
        .filter(|c| c.is_alphabetic() || *c == '\'')
        .flat_map(|c| c.to_lowercase())
        .collect();

    if lower.is_empty() {
        return 1.0;
    }

    let vowels = "aeiouy";
    let mut count = 0usize;
    let mut prev_vowel = false;
    for c in lower.chars() {
        let is_vowel = vowels.contains(c);
        if is_vowel && !prev_vowel {
            count += 1;
        }
        prev_vowel = is_vowel;
    }

    if lower.ends_with('e') && count > 1 {
        count -= 1;
    }

    count.max(1) as f64
}

fn parse_stamp(body: &str) -> Option<f64> {
    // mm:ss.xx or mm:ss.xxx
    let (m, rest) = body.split_once(':')?;
    let minutes: f64 = m.trim().parse().ok()?;
    let seconds: f64 = rest.trim().parse().ok()?;
    Some(minutes * 60.0 + seconds)
}

/// Parse an LRC document into timed lines with derived word timings.
pub fn parse(lrc: &str) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();

    for raw in lrc.lines() {
        // A line may carry several timestamps: [00:12.00][01:04.00] text
        let mut rest = raw;
        let mut stamps: Vec<f64> = Vec::new();

        while rest.starts_with('[') {
            let Some(close) = rest.find(']') else { break };
            let body = &rest[1..close];
            match parse_stamp(body) {
                Some(t) => stamps.push(t),
                // [ar:...] and friends — metadata, not timing.
                None => {}
            }
            rest = rest[close + 1..].trim_start();
        }

        let text = rest.trim().to_string();
        if stamps.is_empty() {
            continue;
        }

        for t in stamps {
            lines.push(Line { t, text: text.clone(), words: Vec::new() });
        }
    }

    lines.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    distribute(&mut lines);
    lines
}

/// Spread each line's words across the gap to the next line, weighted by
/// syllables.
fn distribute(lines: &mut [Line]) {
    let count = lines.len();
    for i in 0..count {
        let start = lines[i].t;

        // The last line has no next timestamp; give it a sensible tail.
        let end = if i + 1 < count {
            lines[i + 1].t
        } else {
            start + 4.0
        };

        let text = lines[i].text.clone();
        let tokens: Vec<&str> = text.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }

        // Never let one line hog more than a few seconds — instrumental gaps
        // would otherwise stretch a word across half a minute.
        let span = (end - start).clamp(0.25, 8.0);

        let weights: Vec<f64> = tokens.iter().map(|w| syllables(w)).collect();
        let total: f64 = weights.iter().sum();

        let mut acc = 0.0;
        let mut words = Vec::with_capacity(tokens.len());
        for (token, weight) in tokens.iter().zip(&weights) {
            words.push(Word { t: start + span * (acc / total), w: (*token).to_string() });
            acc += weight;
        }
        lines[i].words = words;
    }
}
