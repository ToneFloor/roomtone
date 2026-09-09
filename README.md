# ROOMTONE

Audio-reactive room lighting for Windows. It listens to what your speakers are
actually playing, reads the track and its timed lyrics from Spotify, and turns a
screen into light that follows the music.

Twelve WebGL2 shader presets, word-by-word karaoke, kinetic typography on the
beat, and a colour palette pulled out of the album art so the room follows the
record rather than the app.

Built by Robin.

---

## ⚠️ Photosensitivity warning

**ROOMTONE produces bright, rapidly changing, full-screen light, including
flashing that tracks the beat of the music.**

A small proportion of people can have seizures triggered by flashing lights or
patterns, and this software is capable of producing them. If you have
photosensitive epilepsy, a history of seizures, or any reason to be careful with
flashing imagery, do not run this without reading the following first.

There is a **Flash guard** in Settings → MASTER, with three positions:

| Setting | What it does |
| --- | --- |
| **Off** (default) | No limiting. The visualizer reacts at full depth. |
| **Gentle** | Caps the beat response and limits how fast overall brightness can change. |
| **Strong** | Tighter caps on both, and lower overall intensity. |

The guard is applied to the values every shader receives, so it affects **all**
presets, including any you write yourself. It works by putting the kick response
through a falling envelope — so a fast run of beats reads as one sustained push
rather than a strobe — and by slew-limiting overall intensity, so no single frame
can jump the screen from dark to bright.

**Be clear about what this is:** it is a reduction, not a guarantee. A shader can
do anything it likes with time, and the guard cannot make an arbitrary one safe.
It removes the two mechanisms every built-in preset uses to flash. If you are at
risk, treat *Strong* as a mitigation and not as protection, and stop using the
software if anything about it feels uncomfortable.

---

## What it does

- **Listens to real audio.** WASAPI loopback capture, a 2048-point FFT on a
  512-sample hop, and onset and tempo detection. Roughly 21 ms from speaker to
  pixel, measured rather than estimated — you can see the numbers yourself by
  pressing `D`.
- **Listens to one app if you want.** Point it at Spotify and a Discord
  notification will not land in the visual. Windows process loopback, with a
  fallback to whole-device capture.
- **Follows the record.** The accent colour, a second hue, and the dark ground
  are all pulled out of the cover art.
- **Knows the words.** Timed lyrics from LRCLIB, with a syllable-weighted word
  model, per-track timing memory, and a karaoke mode where the line fills in word
  by word with a count-in before you come in.
- **Takes shaders you write.** Drop a `.frag` file in a folder and it appears in
  the dock, with sliders generated from a comment at the top of the file. See
  [docs/SHADERS.md](docs/SHADERS.md).

## What it needs

- **Windows 10 or 11.** Per-app capture additionally needs build 20348 or newer;
  on anything older that one feature falls back to capturing the whole output.
- **A Spotify account.** Track metadata needs any account. Playback control
  (play, pause, skip from inside ROOMTONE) is a Premium-only API.
- **Your own Spotify Client ID** — see below. Two minutes, no cost.
- To build it: [Rust](https://rustup.rs) 1.88 or newer,
  [Node.js](https://nodejs.org), and the WebView2 runtime (already present on
  Windows 11 and on up-to-date Windows 10).

## Setting up Spotify

ROOMTONE does not ship with a Client ID, and this is deliberate rather than an
omission. Spotify applications start in *development mode*, which allows at most
25 hand-added users — so a shared ID genuinely would not work for you. There is
no client secret anywhere in this project: authentication uses the PKCE flow,
which does not need one.

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and create an app.
2. Add the redirect URI `http://127.0.0.1:8888/callback`.
3. Tick **Web API** under the SDKs question, and save.
4. Open the app → **Settings** → **User Management**, and add your own account.
5. Copy the Client ID and paste it into ROOMTONE on first run.

## Building

```
git clone https://github.com/ToneFloor/roomtone.git
cd roomtone
npm install
npm run tauri build
```

For development, `npm run tauri dev` gives you the app with shader hot-reload:
edit any `.frag` and the change appears without a restart.

## Keyboard

| Key | |
| --- | --- |
| `1`–`9`, `0` | Pick a preset |
| `F` | Fullscreen · `ESC` leaves it |
| `K` | Karaoke |
| `L` | Lyric sheet |
| `S` | Settings |
| `D` | Diagnostics |
| `M` | Minimise to the tray |
| `G` | Switch between the WebGL and CSS renderers |
| `B` | Cover art behind the lyric sheet |
| `SPACE` | Play or pause |
| `←` `→` | Previous or next track |
| `[` `]` | Nudge lyric timing by 50 ms |
| `\` | Auto-align lyrics to the vocal |

Everything here is also a switch in Settings — the keys are a shortcut, not the
only way in.

## Privacy

This matters, so it is stated precisely rather than reassuringly.

**What leaves your machine:**

- Requests to **Spotify's Web API**, authenticated as you, to read what is
  playing and to control playback. This is the same API the Spotify app uses.
- Requests to **[LRCLIB](https://lrclib.net)** for lyrics, containing the track
  title, artist, album and duration. LRCLIB requires no account and no API key.

**What does not leave your machine, ever:**

- Captured audio. It is analysed in memory and never written to disk or sent
  anywhere.
- Your Spotify tokens. The refresh token is held in the **Windows Credential
  Manager**, not in a file in this project.
- Any telemetry, analytics, crash reporting or update check. There is none. The
  app makes no network request other than the two above.

**Files it writes,** all under `%APPDATA%\roomtone\`:

| | |
| --- | --- |
| `config.json` | Your settings and your Spotify Client ID |
| `auth.log` | A plain-text event log — no tokens, no IDs, no paths. Rotates at 1 MB. |
| `lyrics.sqlite` | Cached lyrics |
| `artwork/` | Cached cover images |
| `shaders/` | Your own shaders |

The log is deliberately safe to paste into a bug report. If you ever find
something identifying in it, that is a bug worth reporting on its own.

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).

The choice is not incidental: ROOMTONE uses [aubio](https://aubio.org) for onset
and tempo detection, which is GPL-3.0, and linking to it means this project is
GPL-3.0 too. Full attribution for every dependency is in
[CREDITS.md](CREDITS.md).

## Documentation

- [docs/SHADERS.md](docs/SHADERS.md) — writing your own presets
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the three paths fit together
- [docs/ROADMAP.md](docs/ROADMAP.md) — what is done and what is next
- [CONTRIBUTING.md](CONTRIBUTING.md) — before opening a pull request
