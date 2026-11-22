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
//!
//! Two things beat the model whenever they are available. Enhanced LRC puts a
//! real `<mm:ss.xx>` time in front of each word, and those are used as they
//! stand. Otherwise the model only spends as long on a line as the words could
//! plausibly be sung in, so an instrumental break after a line is not mistaken
//! for a very slow line.

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
    /// When the singing of this line stops. Words carry a start and no end, so
    /// without this the last word of a line appears to last until the next line
    /// begins — through however many bars of music sit in between.
    pub end: f64,
}

/// The slowest a weight unit (about one syllable) is sung. A line never spans
/// more than its words could take at this pace, however long the gap to the
/// next line — the rest of the gap is silence, not a drawn-out last word.
const MAX_UNIT_SECS: f64 = 0.65;

/// How long the last word of a line is taken to last when the file gives real
/// word times, which say when it starts and never when it stops.
const LAST_WORD_SECS: f64 = 1.2;

/// Hard ceiling on one line's sung span, for very long lines.
const MAX_SPAN: f64 = 8.0;

/// The last word of a line is held a little. In weight units, so it also pulls
/// the earlier words slightly forward when the line is squeezed.
const LAST_HOLD: f64 = 1.3;

/// A gap this small is not a gap but two lines sharing a timestamp (a duet, a
/// stacked translation). There is no next-line limit to respect then.
const MIN_GAP: f64 = 0.05;

/// A lone dash, ellipsis or note between words occupies a beat of its own.
const MARK_WEIGHT: f64 = 0.5;

/// Pauses a singer takes after punctuation, in weight units.
const PAUSE_COMMA: f64 = 0.6;
const PAUSE_DASH: f64 = 0.9;
const PAUSE_STOP: f64 = 0.7;

/// Characters that carry no vowel-group signal in plain ASCII: accented Latin,
/// Cyrillic and Greek vowels. Without them every word in those scripts would
/// count as one syllable.
const VOWELS: &str = "aeiouy\
    àáâãäåæāăąèéêëēĕęìíîïĩīĭįòóôõöøōŏőœùúûüũūŭůűųýÿ\
    аеёиоуыэюяіїєѣ\
    αεηιουωάέήίόύώϊϋΐΰ";

/// A character that is its own beat and is not space-separated from its
/// neighbours: Han, kana. Hangul is spaced, and handled by syllable block.
fn is_unit(c: char) -> bool {
    if is_attach(c) {
        return false;
    }
    matches!(c,
        '\u{3005}'
        | '\u{3041}'..='\u{3096}'
        | '\u{30A1}'..='\u{30FA}'
        | '\u{31F0}'..='\u{31FF}'
        | '\u{FF66}'..='\u{FF9D}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{4E00}'..='\u{9FFF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{20000}'..='\u{2FA1F}')
}

/// Small kana and the long-vowel mark lengthen the kana before them rather than
/// being a beat of their own.
fn is_attach(c: char) -> bool {
    "ゃゅょぁぃぅぇぉゎっャュョァィゥェォヮッーｰ゛゜".contains(c)
}

fn is_hangul(c: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&c)
}

fn is_opener(c: char) -> bool {
    "「『（([{“‘《〈【〔«".contains(c)
}

/// A token with nothing sung in it: a dash, an ellipsis, a ♪.
fn is_mark(token: &str) -> bool {
    !token.chars().any(char::is_alphanumeric)
}

/// Rough syllable count. Vowel groups, minus a silent trailing e. Scripts that
/// have no vowel signal here fall back to length; Hangul blocks and Han/kana
/// are one syllable apiece.
///
/// It is wrong for plenty of words. It does not need to be right — it only
/// needs to make long words last longer than short ones.
fn syllables(word: &str) -> f64 {
    let mut count = 0usize;
    let mut letters = 0usize;
    let mut prev_vowel = false;
    let mut last: Option<char> = None;

    for c in word.chars().flat_map(|c| c.to_lowercase()) {
        if is_unit(c) || is_hangul(c) {
            count += 1;
            letters += 1;
            prev_vowel = false;
            last = Some(c);
        } else if is_attach(c) {
            // Part of the mora before it.
            prev_vowel = false;
        } else if c.is_alphabetic() {
            letters += 1;
            let vowel = VOWELS.contains(c);
            if vowel && !prev_vowel {
                count += 1;
            }
            prev_vowel = vowel;
            last = Some(c);
        } else if c == '\'' {
            prev_vowel = false;
        }
    }

    if letters == 0 {
        return 1.0;
    }

    if count == 0 {
        // No vowels we recognise (Arabic, Hebrew, Devanagari, "hmm"): roughly
        // one syllable to three letters.
        return (letters as f64 / 3.0).ceil().max(1.0);
    }

    if last == Some('e') && count > 1 {
        count -= 1;
    }

    count.max(1) as f64
}

/// Split a line into the things that get a timestamp. Spaces separate words,
/// except in Han and kana, where each character is one — a Chinese line has no
/// spaces and would otherwise be a single word for the whole line.
fn split_words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in text.split_whitespace() {
        segment_token(token, &mut out);
    }
    out
}

fn segment_token(token: &str, out: &mut Vec<String>) {
    if !token.chars().any(is_unit) {
        out.push(token.to_string());
        return;
    }

    let mut run = String::new();
    let mut after_unit = false;
    for c in token.chars() {
        if is_unit(c) {
            let mut piece = String::new();
            if !run.is_empty() {
                if run.chars().any(char::is_alphanumeric) {
                    out.push(std::mem::take(&mut run));
                } else {
                    // An opening quote or bracket rides with what it opens.
                    piece = std::mem::take(&mut run);
                }
            }
            piece.push(c);
            out.push(piece);
            after_unit = true;
        } else if after_unit && run.is_empty() && (is_attach(c) || (!c.is_alphanumeric() && !is_opener(c))) {
            // Small kana and closing punctuation stay with their character.
            if let Some(last) = out.last_mut() {
                last.push(c);
            }
        } else {
            run.push(c);
            after_unit = false;
        }
    }
    if !run.is_empty() {
        out.push(run);
    }
}

fn is_closer(c: char) -> bool {
    matches!(c, '"' | '\'' | '”' | '’' | ')' | ']' | '」' | '』' | '）' | '»')
}

/// How long a singer pauses after this word, from its trailing punctuation.
fn pause_after(token: &str) -> f64 {
    let core = token.trim_end_matches(is_closer);
    if core.ends_with("...") || core.ends_with('…') {
        return PAUSE_DASH;
    }
    match core.chars().next_back() {
        Some(',' | ';' | ':' | '，' | '、' | '；' | '：') => PAUSE_COMMA,
        Some('-' | '–' | '—' | '―') => PAUSE_DASH,
        Some('.' | '!' | '?' | '。' | '！' | '？') => PAUSE_STOP,
        _ => 0.0,
    }
}

/// Weight of each word: its syllables, plus the pause that follows it. The
/// pause is counted against the word before it because only start times are
/// kept — the next word lands later, which is what a pause looks like.
fn unit_weights(tokens: &[String], hold_last: bool) -> Vec<f64> {
    let hold = if hold_last { tokens.iter().rposition(|t| !is_mark(t)) } else { None };
    let last = tokens.len().saturating_sub(1);

    tokens
        .iter()
        .enumerate()
        .map(|(i, token)| {
            if is_mark(token) {
                return MARK_WEIGHT;
            }
            let mut w = syllables(token);
            // The end of a line is already a pause; do not add another.
            if i != last {
                w += pause_after(token);
            }
            if hold == Some(i) {
                w *= LAST_HOLD;
            }
            w
        })
        .collect()
}

/// Parse `mm:ss.xx`, `mm:ss.xxx`, `mm:ss` or `mm:ss:xx` into seconds. Strict on
/// digits so that `[ar:...]` and friends can never be mistaken for a time.
fn parse_stamp(body: &str) -> Option<f64> {
    let (m, rest) = body.trim().split_once(':')?;
    let m = m.trim();
    if m.is_empty() || !m.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    let (whole, frac) = match rest.trim().split_once(|c| c == '.' || c == ':') {
        Some((w, f)) => (w, Some(f)),
        None => (rest.trim(), None),
    };
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    let minutes: f64 = m.parse().ok()?;
    let mut seconds: f64 = whole.parse().ok()?;
    if let Some(f) = frac {
        // One digit is tenths, two are centiseconds, three are milliseconds.
        if f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        seconds += format!("0.{f}").parse::<f64>().ok()?;
    }
    Some(minutes * 60.0 + seconds)
}

/// `[offset:+500]`, in seconds. Positive means the lyrics should appear sooner.
fn parse_offset(body: &str) -> Option<f64> {
    let (key, value) = body.split_once(':')?;
    if !key.trim().eq_ignore_ascii_case("offset") {
        return None;
    }
    let ms: f64 = value.trim().parse().ok()?;
    ms.is_finite().then_some(ms / 1000.0)
}

/// A piece of a line between enhanced word tags.
struct Segment {
    t: Option<f64>,
    text: String,
}

fn inline_segments(text: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut current_t = None;
    let mut rest = text;

    while let Some(open) = rest.find('<') {
        let Some(len) = rest[open..].find('>') else { break };
        match parse_stamp(&rest[open + 1..open + len]) {
            Some(t) => {
                current.push_str(&rest[..open]);
                segments.push(Segment { t: current_t, text: std::mem::take(&mut current) });
                current_t = Some(t);
                rest = &rest[open + len + 1..];
            }
            None => {
                // A literal '<' in the lyric.
                current.push_str(&rest[..=open]);
                rest = &rest[open + 1..];
            }
        }
    }
    current.push_str(rest);
    segments.push(Segment { t: current_t, text: current });
    segments
}

/// Whether text that starts a segment continues the word before it, as in
/// `<t>hel<t>lo`. Han and kana never do — each is its own word — but closing
/// punctuation and small kana stay with what they follow.
fn continues_word(prev: char, next: char) -> bool {
    if prev.is_whitespace() || next.is_whitespace() {
        return false;
    }
    (!is_unit(prev) && !is_unit(next)) || is_attach(next) || !next.is_alphanumeric()
}

/// Real word times from a tagged line, as absolute seconds. A segment holding
/// several words spreads them across itself with the model; its end is the
/// next tag.
fn enhanced_words(segments: &[Segment], line_t: f64) -> Vec<(f64, String)> {
    let mut out: Vec<(f64, String)> = Vec::new();
    let mut prev_last: Option<char> = None;

    for (i, seg) in segments.iter().enumerate() {
        let Some(first_char) = seg.text.chars().next() else { continue };
        let last_char = seg.text.chars().next_back();
        let mut tokens = split_words(&seg.text);
        if tokens.is_empty() {
            prev_last = last_char;
            continue;
        }

        if let (Some(p), false) = (prev_last, out.is_empty()) {
            if continues_word(p, first_char) {
                let head = tokens.remove(0);
                if let Some(word) = out.last_mut() {
                    word.1.push_str(&head);
                }
            }
        }
        prev_last = last_char;
        if tokens.is_empty() {
            continue;
        }

        let t = seg.t.unwrap_or(line_t);
        let weights = unit_weights(&tokens, false);
        let total: f64 = weights.iter().sum();
        let span = match segments.get(i + 1).and_then(|s| s.t) {
            Some(end) => (end - t).max(0.0),
            None => (total * MAX_UNIT_SECS).min(MAX_SPAN),
        };

        let mut acc = 0.0;
        for (token, weight) in tokens.into_iter().zip(&weights) {
            out.push((t + span * (acc / total), token));
            acc += weight;
        }
    }
    out
}

/// A line as read, before its words are timed. Word times, when the line has
/// them, are offsets from the line's own timestamp so that a repeated chorus
/// stamped twice carries them to both places.
struct Raw {
    t: f64,
    text: String,
    words: Option<Vec<(f64, String)>>,
}

/// Parse an LRC document into timed lines with derived word timings.
pub fn parse(lrc: &str) -> Vec<Line> {
    let mut raws: Vec<Raw> = Vec::new();
    let mut offset = 0.0;

    for raw in lrc.trim_start_matches('\u{feff}').lines() {
        // A line may carry several timestamps: [00:12.00][01:04.00] text
        let mut rest = raw.trim_start();
        let mut stamps: Vec<f64> = Vec::new();

        while rest.starts_with('[') {
            let Some(close) = rest.find(']') else { break };
            let body = &rest[1..close];
            if let Some(t) = parse_stamp(body) {
                stamps.push(t);
            } else if let Some(o) = parse_offset(body) {
                offset = o;
            }
            // [ar:...] and friends — metadata, not timing.
            rest = rest[close + 1..].trim_start();
        }

        let Some(&first) = stamps.first() else { continue };

        let segments = inline_segments(rest);
        let (text, words) = if segments.len() > 1 {
            let text = segments.iter().map(|s| s.text.as_str()).collect::<String>();
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            let words = enhanced_words(&segments, first);
            let words = (!words.is_empty())
                .then(|| words.into_iter().map(|(t, w)| (t - first, w)).collect());
            (text, words)
        } else {
            (rest.trim().to_string(), None)
        };

        for t in stamps {
            raws.push(Raw { t, text: text.clone(), words: words.clone() });
        }
    }

    // Applied once the whole file is read: the tag usually sits in the header,
    // but nothing says it has to.
    for raw in &mut raws {
        raw.t = (raw.t - offset).max(0.0);
    }
    raws.sort_by(|a, b| a.t.total_cmp(&b.t));
    time_words(raws)
}

fn time_words(raws: Vec<Raw>) -> Vec<Line> {
    let starts: Vec<f64> = raws.iter().map(|r| r.t).collect();

    raws.into_iter()
        .enumerate()
        .map(|(i, raw)| {
            let avail = starts.get(i + 1).map(|next| next - raw.t).filter(|gap| *gap >= MIN_GAP);
            let next = starts.get(i + 1).copied().filter(|next| *next > raw.t);
            let (words, end) = match &raw.words {
                Some(words) => {
                    // Real word times give the last word a start and nothing
                    // else; allow it a beat or so, short of the next line.
                    let words = explicit_words(raw.t, words);
                    let last = words.last().map(|w| w.t).unwrap_or(raw.t);
                    (words, last + LAST_WORD_SECS)
                }
                None => model_words(raw.t, &raw.text, avail),
            };
            let end = next.map_or(end, |next| end.min(next)).max(raw.t);
            Line { t: raw.t, text: raw.text, words, end }
        })
        .collect()
}

/// Times the lyric file gave us. Kept in order, since a front end that walks the
/// words assumes they only move forward.
fn explicit_words(line_t: f64, words: &[(f64, String)]) -> Vec<Word> {
    let mut floor = 0.0f64;
    words
        .iter()
        .map(|(dt, w)| {
            floor = floor.max(line_t + dt);
            Word { t: floor, w: w.clone() }
        })
        .collect()
}

/// Spread a line's words over the time it could be sung in, weighted by
/// syllables.
fn model_words(start: f64, text: &str, avail: Option<f64>) -> (Vec<Word>, f64) {
    let tokens = split_words(text);
    if tokens.is_empty() {
        return (Vec::new(), start);
    }

    // A ♪ line is a marker for music, not words to be sung one at a time.
    if tokens.iter().all(|t| is_mark(t)) {
        return (vec![Word { t: start, w: text.to_string() }], start);
    }

    let weights = unit_weights(&tokens, true);
    let total: f64 = weights.iter().sum();

    // Never let one line hog more than its words could take — instrumental gaps
    // would otherwise stretch a word across half a minute. A short gap wins the
    // other way: a fast line is squeezed into it rather than spilling into the
    // next one. The last line has no next timestamp and is bounded by the rate
    // alone.
    let mut span = (total * MAX_UNIT_SECS).min(MAX_SPAN);
    if let Some(avail) = avail {
        span = span.min(avail);
    }

    let mut acc = 0.0;
    let mut words = Vec::with_capacity(tokens.len());
    for (token, weight) in tokens.into_iter().zip(&weights) {
        words.push(Word { t: start + span * (acc / total), w: token });
        acc += weight;
    }
    (words, start + span)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn times(line: &Line) -> Vec<f64> {
        line.words.iter().map(|w| w.t).collect()
    }

    fn texts(line: &Line) -> Vec<&str> {
        line.words.iter().map(|w| w.w.as_str()).collect()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn line_end_stops_short_of_a_long_gap() {
        let lines = parse("[00:10.00]one two three
[00:40.00]four");
        assert!(lines[0].end > lines[0].words[2].t);
        assert!(lines[0].end < 16.0, "end was {}", lines[0].end);
        // A fast line is bounded by the next line instead.
        let fast = parse("[00:10.00]one two three four five six
[00:11.00]seven");
        assert!(close(fast[0].end, 11.0));
    }

    #[test]
    fn enhanced_tags_replace_the_model() {
        let lines = parse("[00:10.00]<00:10.00>Hello <00:10.80>world <00:12.50>again");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello world again");
        assert_eq!(texts(&lines[0]), ["Hello", "world", "again"]);
        let t = times(&lines[0]);
        assert!(close(t[0], 10.0) && close(t[1], 10.8) && close(t[2], 12.5));
    }

    #[test]
    fn enhanced_tags_after_untagged_start_and_with_trailing_end_tag() {
        let lines = parse("[00:10.00]Oh <00:11.00>yeah<00:12.00>");
        assert_eq!(texts(&lines[0]), ["Oh", "yeah"]);
        let t = times(&lines[0]);
        assert!(close(t[0], 10.0) && close(t[1], 11.0));
    }

    #[test]
    fn enhanced_syllable_tags_join_into_one_word() {
        let lines = parse("[00:01.00]<00:01.00>hel<00:01.30>lo <00:02.00>there");
        assert_eq!(lines[0].text, "hello there");
        assert_eq!(texts(&lines[0]), ["hello", "there"]);
        assert!(close(lines[0].words[1].t, 2.0));
    }

    #[test]
    fn enhanced_cjk_tags_stay_separate_words() {
        let lines = parse("[00:01.00]<00:01.00>你<00:01.50>好，<00:02.00>世");
        assert_eq!(texts(&lines[0]), ["你", "好，", "世"]);
    }

    #[test]
    fn enhanced_tags_survive_repeated_stamps_and_offset() {
        let lines = parse("[offset:+500]\n[00:10.00][00:50.00]<00:10.00>a <00:10.40>b");
        assert_eq!(lines.len(), 2);
        // The second copy carries the same relative word times.
        assert!(close(lines[0].words[1].t, 9.9));
        assert!(close(lines[1].t, 49.5));
        assert!(close(lines[1].words[1].t, 49.9));
    }

    #[test]
    fn enhanced_word_times_never_go_backwards() {
        let lines = parse("[00:10.00]<00:10.00>a <00:11.00>b <00:10.50>c");
        let t = times(&lines[0]);
        assert!(t.windows(2).all(|p| p[0] <= p[1]));
    }

    #[test]
    fn enhanced_segment_with_several_words_is_spread_to_next_tag() {
        let lines = parse("[00:00.00]<00:00.00>one two three four <00:04.00>end");
        let t = times(&lines[0]);
        assert_eq!(t.len(), 5);
        assert!(close(t[0], 0.0) && close(t[4], 4.0));
        assert!(t[1] > 0.0 && t[3] < 4.0);
    }

    #[test]
    fn a_literal_angle_bracket_is_just_text() {
        let lines = parse("[00:01.00]I <3 you");
        assert_eq!(lines[0].text, "I <3 you");
        assert_eq!(lines[0].words.len(), 3);
    }

    #[test]
    fn instrumental_gap_does_not_stretch_a_line() {
        let lines = parse("[00:00.00]Hello there\n[00:30.00]Next");
        let t = times(&lines[0]);
        assert!(t[1] < 3.0, "second word landed at {}", t[1]);
    }

    #[test]
    fn last_line_gets_a_rate_bounded_tail() {
        let lines = parse("[00:00.00]Hi there");
        let t = times(&lines[0]);
        assert!(t[1] > 0.0 && t[1] < 2.0);
    }

    #[test]
    fn a_long_line_is_still_capped() {
        let words = vec!["word"; 40].join(" ");
        let lines = parse(&format!("[00:00.00]{words}\n[01:00.00]x"));
        assert!(lines[0].words.last().unwrap().t <= MAX_SPAN);
    }

    #[test]
    fn fast_line_compresses_evenly_inside_its_gap() {
        let lines = parse("[00:00.00]go to the sun and run on by\n[00:01.00]x");
        let t = times(&lines[0]);
        assert_eq!(t.len(), 8);
        assert!(t.iter().all(|&x| x >= 0.0 && x < 1.0));
        // Seven equal one-syllable words before the held last one.
        let step = t[1] - t[0];
        assert!(t[..7].windows(2).all(|p| close(p[1] - p[0], step)));
    }

    #[test]
    fn same_timestamp_lines_keep_their_own_spread() {
        let lines = parse("[00:05.00]first line here\n[00:05.00]second line here");
        let t = times(&lines[0]);
        assert!(t[0] < t[1] && t[1] < t[2]);
    }

    #[test]
    fn a_blank_marker_ends_the_line_before_it() {
        let lines = parse("[00:00.00]Hello there you all\n[00:00.50]\n[00:09.00]Next");
        assert!(lines[0].words.iter().all(|w| w.t < 0.5));
        assert!(lines[1].words.is_empty());
    }

    #[test]
    fn music_note_lines_are_one_marker_word() {
        let lines = parse("[00:01.00]♪\n[00:05.00]♪ ♪\n[00:09.00]Hi");
        assert_eq!(texts(&lines[0]), ["♪"]);
        assert_eq!(texts(&lines[1]), ["♪ ♪"]);
        assert!(close(lines[1].words[0].t, 5.0));
    }

    #[test]
    fn comma_adds_a_pause_before_the_next_word() {
        let plain = parse("[00:00.00]well now my friend\n[00:20.00]x");
        let comma = parse("[00:00.00]well, now my friend\n[00:20.00]x");
        // The pause is real time, not a share taken from later words.
        assert!(comma[0].words[1].t > plain[0].words[1].t);
    }

    #[test]
    fn dash_and_ellipsis_pause_longer_than_a_comma() {
        let pause = |mark: &str| {
            let doc = format!("[00:00.00]well{mark} now my friend\n[00:20.00]x");
            let t = times(&parse(&doc)[0]);
            t[1] - t[0]
        };
        assert!(pause("—") > pause(","));
        assert!(pause("...") > pause(","));
        assert!(pause("…") > pause(","));
        assert!(pause(",") > pause(""));
    }

    #[test]
    fn standalone_dash_takes_a_beat_of_its_own() {
        let lines = parse("[00:00.00]well - now\n[00:20.00]x");
        assert_eq!(texts(&lines[0]), ["well", "-", "now"]);
        let t = times(&lines[0]);
        assert!(t[1] > t[0] && t[2] > t[1]);
    }

    #[test]
    fn last_word_is_held_longer() {
        let words: Vec<String> = ["go", "now"].iter().map(|s| s.to_string()).collect();
        let held = unit_weights(&words, true);
        let flat = unit_weights(&words, false);
        assert!(close(held[0], flat[0]));
        assert!(held[1] > flat[1]);
        // And so the last word starts earlier than half way.
        let lines = parse("[00:00.00]go now\n[00:01.00]x");
        assert!(lines[0].words[1].t < 0.5);
    }

    #[test]
    fn closing_punctuation_does_not_add_a_line_end_pause() {
        let tokens = vec!["go".to_string(), "now.".to_string()];
        let w = unit_weights(&tokens, false);
        assert!(close(w[1], syllables("now.")));
    }

    #[test]
    fn multiple_timestamps_repeat_the_line() {
        let lines = parse("[00:10.00][00:50.00]Chorus line\n[00:20.00]Verse");
        let at: Vec<f64> = lines.iter().map(|l| l.t).collect();
        assert_eq!(at, [10.0, 20.0, 50.0]);
        assert_eq!(lines[0].text, "Chorus line");
        assert_eq!(lines[2].text, "Chorus line");
        assert_eq!(lines[2].words.len(), 2);
        assert!(close(lines[2].words[0].t, 50.0));
    }

    #[test]
    fn offset_tag_moves_every_line() {
        let early = parse("[offset:+500]\n[00:10.00]Hi\n[00:12.00]There");
        assert!(close(early[0].t, 9.5) && close(early[1].t, 11.5));
        let late = parse("[00:10.00]Hi\n[offset: -250]\n");
        assert!(close(late[0].t, 10.25));
        // Cannot start before the track does.
        let clamped = parse("[offset:+5000]\n[00:01.00]Hi");
        assert!(close(clamped[0].t, 0.0));
    }

    #[test]
    fn stamp_precision_variants() {
        assert!(close(parse_stamp("00:01.250").unwrap(), 1.25));
        assert!(close(parse_stamp("00:01.25").unwrap(), 1.25));
        assert!(close(parse_stamp("01:02.5").unwrap(), 62.5));
        assert!(close(parse_stamp("01:02").unwrap(), 62.0));
        assert!(close(parse_stamp("120:00.00").unwrap(), 7200.0));
        assert!(close(parse_stamp("00:01:50").unwrap(), 1.5));
        assert!(parse_stamp("ar:Someone").is_none());
        assert!(parse_stamp("length: 03:45").is_none());
        assert!(parse_stamp("00:xx").is_none());
        assert!(parse_stamp("nan:1").is_none());
    }

    #[test]
    fn three_digit_milliseconds_in_a_document() {
        let lines = parse("[00:01.234]a b");
        assert!(close(lines[0].t, 1.234));
    }

    #[test]
    fn metadata_tags_are_not_lines() {
        let doc = "[ar:Artist]\n[ti:Title]\n[al:Album]\n[by:someone]\n[length: 03:45]\n[00:01.00]Hi";
        let lines = parse(doc);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hi");
    }

    #[test]
    fn crlf_and_bom_are_handled() {
        let lines = parse("\u{feff}[00:01.00]a b\r\n[00:02.00]c d\r\n");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "a b");
        assert_eq!(texts(&lines[1]), ["c", "d"]);
    }

    #[test]
    fn out_of_order_lines_are_sorted_and_timed_against_neighbours() {
        let lines = parse("[00:20.00]third line here\n[00:00.00]first one go now\n[00:00.50]second");
        let at: Vec<f64> = lines.iter().map(|l| l.t).collect();
        assert_eq!(at, [0.0, 0.5, 20.0]);
        assert_eq!(lines[0].text, "first one go now");
        assert!(lines[0].words.iter().all(|w| w.t < 0.5));
    }

    #[test]
    fn han_lines_split_per_character() {
        let lines = parse("[00:00.00]你好世界\n[00:04.00]x");
        assert_eq!(texts(&lines[0]), ["你", "好", "世", "界"]);
        let t = times(&lines[0]);
        assert!(t.windows(2).all(|p| p[1] > p[0]));
        assert!(t[3] < 4.0);
    }

    #[test]
    fn kana_small_letters_stay_with_their_character() {
        let lines = parse("[00:00.00]きょうは「あした」\n[00:09.00]x");
        assert_eq!(texts(&lines[0]), ["きょ", "う", "は", "「あ", "し", "た」"]);
    }

    #[test]
    fn mixed_latin_and_cjk_keeps_latin_words_whole() {
        assert_eq!(split_words("Hello世界 ok"), ["Hello", "世", "界", "ok"]);
    }

    #[test]
    fn cjk_punctuation_pauses_after_its_character() {
        let lines = parse("[00:00.00]你好，世界\n[00:20.00]x");
        assert_eq!(texts(&lines[0]), ["你", "好，", "世", "界"]);
        let t = times(&lines[0]);
        assert!((t[2] - t[1]) > (t[1] - t[0]));
    }

    #[test]
    fn syllables_beyond_plain_english() {
        assert_eq!(syllables("привет"), 2.0);
        assert_eq!(syllables("мама"), 2.0);
        assert_eq!(syllables("καλημέρα"), 4.0);
        assert_eq!(syllables("사랑해요"), 4.0);
        assert_eq!(syllables("café"), 2.0);
        // No vowel signal: falls back to length.
        assert_eq!(syllables("مرحبا"), 2.0);
        assert_eq!(syllables("hmm"), 1.0);
        // Unchanged English behaviour.
        assert_eq!(syllables("the"), 1.0);
        assert_eq!(syllables("make"), 1.0);
        assert_eq!(syllables("unbelievable"), 4.0);
        assert_eq!(syllables("..."), 1.0);
    }

    #[test]
    fn longer_words_take_longer_in_non_latin_scripts() {
        let lines = parse("[00:00.00]да привет\n[00:20.00]x");
        let t = times(&lines[0]);
        assert_eq!(t.len(), 2);
        // "да" is one unit, so it lasts exactly one unit of the rate cap.
        assert!(close(t[1] - t[0], MAX_UNIT_SECS));
    }
}
