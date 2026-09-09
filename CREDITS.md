# Credits

ROOMTONE is built on other people's work. Everything below is used as a
dependency, unmodified, under its own licence.

## Libraries

| Project | What it does here | Licence |
| --- | --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) | App shell, windowing, IPC, installer | Apache-2.0 / MIT |
| [cpal](https://github.com/RustAudio/cpal) | Audio I/O, and the WASAPI loopback backend | Apache-2.0 |
| [aubio](https://aubio.org) via [aubio-rs](https://github.com/katyo/aubio-rs) | Onset detection and tempo tracking | **GPL-3.0** |
| [RustFFT](https://github.com/ejmahler/RustFFT) | The FFT behind the spectrum | Apache-2.0 / MIT |
| [ringbuf](https://github.com/agerasev/ringbuf) | Lock-free hand-off out of the audio callback | Apache-2.0 / MIT |
| [rspotify](https://github.com/ramsayleung/rspotify) | Spotify Web API client, PKCE flow | MIT |
| [keyring-rs](https://github.com/hwchen/keyring-rs) | Token storage in the Windows Credential Manager | Apache-2.0 / MIT |
| [color-thief-rs](https://github.com/RazrFalcon/color-thief-rs) | Colour clusters out of the cover art | MIT |
| [image](https://github.com/image-rs/image) | Decoding cover art | Apache-2.0 / MIT |
| [windows-rs](https://github.com/microsoft/windows-rs) | Win32 bindings — window shaping, process loopback, registry | Apache-2.0 / MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) · [tokio](https://github.com/tokio-rs/tokio) · [serde](https://github.com/serde-rs/serde) | HTTP, async runtime, serialisation | Apache-2.0 / MIT |
| [rusqlite](https://github.com/rusqlite/rusqlite) | The lyric cache | MIT |

**aubio is why ROOMTONE is GPL-3.0.** It is the strongest copyleft licence in the
dependency tree, and linking against it means the whole work is distributed under
the same terms. This was a deliberate choice — aubio's onset detection is
genuinely better than the alternatives that were tried.

## Services

- **[LRCLIB](https://github.com/tranxuanthang/lrclib)** — a free, open,
  no-account, no-API-key database of synchronised lyrics. ROOMTONE would have no
  karaoke without it. If you use this app a lot, consider
  [contributing lyrics back](https://lrclib.net).
- **[Spotify Web API](https://developer.spotify.com/documentation/web-api)** —
  track metadata, playback position and cover art.

## Reference and inspiration

- **[Cubensis](https://github.com/ginger-code/cubensis)** — a reference for how
  to structure shader-based audio reactivity.
- The **WorkerW** desktop-layer technique, widely documented by the community,
  was explored during development. It is not in the shipped app.

## Typefaces

- **Space Mono** and **Instrument Serif**, both under the SIL Open Font License,
  bundled with the application.

## Everything else

Written for this project. If a technique here is useful to you, take it — that
is rather the point of the licence.

Built by Robin.
