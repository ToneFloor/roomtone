# Contributing

Pull requests and issues are welcome. A few things worth knowing first, so your
time is not wasted.

## The easiest contribution is a shader

You do not need to touch any Rust or JavaScript to add a preset. A shader is a
single `.frag` file with a comment block at the top, and dropping it in the
folder is the entire installation step. [docs/SHADERS.md](docs/SHADERS.md) has
the format and a worked example.

If you write one you like, open a pull request adding it to `shaders/` and
registering it in `src-tauri/src/shaders.rs`. Please include a screenshot or a
short clip in the PR — a shader is very hard to review from source.

## Building

```
npm install
npm run tauri dev
```

Requires [Rust](https://rustup.rs) 1.88+, Node.js, and Windows. The app is
Windows-only by design: the capture path is WASAPI, and the window shaping is
Win32.

You will need your own Spotify Client ID before the app does anything
interesting — see the README.

## House style

The code in this project is commented more heavily than most, and the comments
explain **why**, not what. If a line looks strange, the comment above it should
say what went wrong that made it necessary. Please match that: a comment saying
`// increment the counter` is noise, and a comment saying `// not is_maximized:
it misses snap-to-edge, which reports as an ordinary window` is worth more than
the line it describes.

Other conventions:

- British spelling in prose and comments; the code uses whatever the API uses.
- No abbreviations in names that a newcomer would have to decode.
- If you fix a bug, say what the symptom was in the commit message. "Fix
  geometry drift" is less useful than "window grew by its border width on every
  launch: `set_size` sets the client area, `outer_size` reports the frame".

## Things that will be turned down

- **Telemetry, analytics, or crash reporting of any kind.** The privacy section
  of the README is a promise, not a description of the current state.
- **A bundled Spotify Client ID.** It would not work — development-mode apps are
  limited to 25 hand-added users — and it would tie every user to one account.
- **A client secret anywhere.** The PKCE flow does not need one, and a secret in
  a public repository is not a secret.
- **Anything that makes the flash guard weaker or optional to respect.** It is
  applied at the uniform level precisely so no preset can opt out.

## Reporting a bug

`%APPDATA%\roomtone\auth.log` is written to be safe to paste — no tokens, no
IDs, no paths, no account details. Including it makes a report far easier to act
on. If you ever find something identifying in that file, please report *that*
first; it is a bug in its own right.
