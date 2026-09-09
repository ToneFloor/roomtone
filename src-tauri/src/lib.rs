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

//! ROOMTONE core.
//!
//! Three independent data paths feed the visuals, at three different rates:
//!
//!   A  audio     WASAPI loopback → FFT → bands + onsets      ~93 frames/sec
//!   B  metadata  Spotify Web API → track, art, accent        every 3 seconds
//!   C  lyrics    LRCLIB → LRC → word timings → SQLite        once per track
//!
//! They are deliberately independent. A stalled API call or a track with no
//! lyrics never touches the visuals, because path A alone is a complete
//! visualizer.

mod audio;
mod autostart;
mod config;
mod log;
mod lyrics;
mod shaders;
mod spotify;
#[cfg(windows)]
mod tray;
#[cfg(windows)]
mod windows;

use spotify::Status;

#[tauri::command]
async fn spotify_status() -> Status {
    spotify::restore().await
}

#[tauri::command]
async fn spotify_connect() -> Status {
    spotify::connect().await
}

#[tauri::command]
async fn spotify_disconnect() -> Status {
    spotify::disconnect().await
}

/// Open a link in the user's browser.
///
/// Deliberately an allowlist rather than "any https URL": the window renders
/// text that ultimately comes from a music API, and a general-purpose "open
/// anything" command reachable from the front end is a hole worth not having.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    const ALLOWED: [&str; 3] = [
        "https://github.com/",
        "https://developer.spotify.com/",
        "https://lrclib.net/",
    ];
    if !ALLOWED.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("link not allowed".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    Err("Windows only".into())
}

#[tauri::command]
fn audio_info() -> audio::AudioInfo {
    audio::info()
}

/// The lyrics for whatever is playing, pulled rather than pushed.
#[tauri::command]
fn lyrics_current() -> Option<lyrics::Lyrics> {
    lyrics::current()
}

/// Borderless fullscreen. Escape comes back.
#[tauri::command]
fn set_fullscreen(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::set_fullscreen(&app, on)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, on);
        Err("Windows only".into())
    }
}

/// This track's remembered lyric offset, in milliseconds.
#[tauri::command]
fn lyric_offset_get(track_id: String) -> i64 {
    lyrics::cache::offset_get(&track_id)
}

#[tauri::command]
fn lyric_offset_set(track_id: String, ms: i64) {
    lyrics::cache::offset_set(&track_id, ms);
}

/// Forget every cached lyric miss and look again.
#[tauri::command]
fn lyrics_recheck() {
    lyrics::cache::clear_misses();
}

/// Every shader preset, built-in and user-written, with its source.
#[tauri::command]
fn shader_presets() -> Vec<shaders::Shader> {
    shaders::list()
}

/// File timestamps only. Polled so a saved edit reloads while the app runs.
#[tauri::command]
fn shader_stamps() -> Vec<shaders::Stamp> {
    shaders::stamps()
}

/// Open the folder where user shaders live, in Explorer.
#[tauri::command]
fn open_shader_folder() -> Result<(), String> {
    shaders::ensure_user_dir();
    let dir = shaders::user_dir().ok_or("no %APPDATA%")?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    Err("Windows only".into())
}

/// Play, pause, skip and seek. Premium-only, and the first place a free
/// account finds that out.
#[tauri::command]
async fn spotify_control(action: String, position_ms: Option<u64>) -> Result<(), String> {
    spotify::transport::run(&action, position_ms).await
}

/// Output endpoints loopback can bind to. Feeds the onboarding device picker.
/// Switch what ROOMTONE listens to.
///
/// Returns the source that is actually running afterwards, which is not always
/// the one asked for: a failed per-app capture falls back to the whole device,
/// and the interface needs to show what is true rather than what was requested.
#[tauri::command]
fn set_audio_source(source: audio::Source) -> Result<audio::Source, String> {
    let result = audio::set_source(source);
    let now = audio::current_source();
    match result {
        Ok(()) => Ok(now),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn audio_source() -> audio::Source {
    audio::current_source()
}

/// Applications with an audio session right now, for the per-app picker.
#[tauri::command]
fn audio_apps() -> Vec<audio::sessions::AppSource> {
    #[cfg(windows)]
    {
        audio::sessions::list()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
fn audio_devices() -> Vec<String> {
    audio::devices()
}

#[derive(serde::Serialize)]
struct Display {
    name: String,
    width: u32,
    height: u32,
    scale: f64,
    primary: bool,
}

/// Real monitors, for the onboarding display picker. Per-display output modes
/// land in step 8; this is the enumeration they will use.
#[tauri::command]
fn displays(app: tauri::AppHandle) -> Vec<Display> {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return Vec::new();
    };

    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned());

    window
        .available_monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .enumerate()
                .map(|(i, m)| {
                    let name = m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1));
                    let size = m.size();
                    Display {
                        primary: Some(&name) == primary.as_ref(),
                        name,
                        width: size.width,
                        height: size.height,
                        scale: m.scale_factor(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Read a cached cover into a data URL.
///
/// The window cannot open arbitrary local files, and it should not be able to.
/// This reads only from ROOMTONE's own artwork cache.
#[tauri::command]
fn cover_data_url(path: String) -> Result<String, String> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Err("no %APPDATA%".into());
    };
    let root = std::path::PathBuf::from(appdata).join("roomtone").join("artwork");

    // Only the file name is taken from the caller, and it is joined onto the
    // cache directory here. Path traversal is impossible by construction, so
    // there is nothing to compare and nothing to get wrong.
    //
    // The previous version canonicalised both sides and compared prefixes, and
    // it refused every cover on this machine. A check that rejects the
    // legitimate case is not a security measure, it is a bug wearing one.
    let name = std::path::Path::new(&path)
        .file_name()
        .ok_or_else(|| "cover: no file name in path".to_string())?;

    if !std::path::Path::new(name)
        .extension()
        .map(|e| e.eq_ignore_ascii_case("jpg"))
        .unwrap_or(false)
    {
        return Err("cover: not a cached cover".into());
    }

    let file = root.join(name);
    let bytes = std::fs::read(&file).map_err(|e| {
        let msg = format!("cover: read failed for {}: {e}", file.display());
        log::event(&msg);
        msg
    })?;

    Ok(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)))
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Record something the interface noticed — an uncaught error, a rejected
/// promise — in the same log as everything else.
///
/// Without this a JavaScript exception is invisible: it lands in a developer
/// console nobody has open, and the symptom reaching the user is a panel that
/// stopped working for no stated reason. Truncated and prefixed, so a bug
/// report carries the failure rather than a description of it.
#[tauri::command]
fn ui_log(message: String) {
    let mut text = message.replace('\n', " ").replace('\r', " ");
    text.truncate(400);
    log::event(&format!("ui: {text}"));
}

/// The interface's remembered state, or nothing on a first run.
#[tauri::command]
fn ui_state_get() -> Option<serde_json::Value> {
    config::ui_state()
}

/// Save the interface's state.
///
/// Called from a debounce on the front end, not on every keystroke — a slider
/// drag emits values continuously and this touches the disk.
#[tauri::command]
fn ui_state_set(state: serde_json::Value) -> Result<(), String> {
    config::set_ui_state(state)
}

/// Is ROOMTONE in the Windows startup list? Read from the registry every time,
/// because the user can remove it from Task Manager behind our back.
#[tauri::command]
fn autostart_get() -> bool {
    autostart::enabled()
}

#[tauri::command]
fn autostart_set(on: bool) -> Result<bool, String> {
    autostart::set(on)?;
    // Report what the registry actually says now, not what was asked for.
    Ok(autostart::enabled())
}

#[tauri::command]
fn client_id_present() -> bool {
    config::client_id().is_some()
}

#[tauri::command]
fn set_client_id(client_id: String) -> Result<(), String> {
    let id = client_id.trim();
    // Spotify Client IDs are 32 lowercase hex characters.
    if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("that does not look like a Spotify Client ID — it should be 32 characters of letters and numbers".into());
    }
    config::set_client_id(id)
}

/// Does this saved rectangle still land on a monitor that exists?
///
/// Requires a decent overlap rather than a single corner: a window whose title
/// bar sits a pixel above the top of every screen cannot be dragged back, and
/// "mostly on screen" is the property that actually matters.
fn geometry_visible(window: &tauri::WebviewWindow, b: &config::WindowBox) -> bool {
    let Ok(monitors) = window.available_monitors() else { return false };
    let (l, t) = (b.x, b.y);
    let (r, bo) = (b.x + b.width as i32, b.y + b.height as i32);
    let area = (b.width as i64) * (b.height as i64);
    if area <= 0 {
        return false;
    }

    for m in monitors {
        let p = *m.position();
        let sz = *m.size();
        let ml = p.x;
        let mt = p.y;
        let mr = p.x + sz.width as i32;
        let mb = p.y + sz.height as i32;

        let ow = (r.min(mr) - l.max(ml)).max(0) as i64;
        let oh = (bo.min(mb) - t.max(mt)).max(0) as i64;
        if ow * oh * 4 >= area {
            return true;
        }
    }
    false
}

/// Is this window covering an entire monitor?
fn fills_a_monitor(window: &tauri::Window) -> bool {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let Ok(monitors) = window.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let ms = *m.size();
        // A snapped window overhangs the screen by its invisible border, so
        // "as large as the monitor" has to mean "at least", not "equal to".
        size.width + 20 >= ms.width
            && size.height + 20 >= ms.height
            && pos.x <= m.position().x + 20
            && pos.y <= m.position().y + 20
    })
}

/// Remember the window's size and position.
///
/// Only while it is an ordinary window. Fullscreen strips the frame and resizes
/// to the monitor, and saving *that* would mean every launch after a fullscreen
/// session opened as an undecorated screen-filling window with no title bar —
/// so the decorated check is not a nicety, it is what keeps the app openable.
fn remember_geometry(window: &tauri::Window) {
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST: AtomicI64 = AtomicI64::new(0);

    if !window.is_decorated().unwrap_or(false) {
        return;
    }
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    // `is_maximized` does not catch a window snapped to fill the screen by
    // dragging it to the top edge — that reports as an ordinary window with a
    // full-monitor rectangle. Restoring one is not wrong exactly, but it is
    // never what someone meant to save, so treat covering the screen as a
    // signal to leave the last real size alone.
    if fills_a_monitor(window) {
        return;
    }

    // Dragging a window emits a move event per frame. One write a second is
    // plenty for something only read at launch.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let last = LAST.load(Ordering::Relaxed);
    if now - last < 1000 {
        return;
    }
    LAST.store(now, Ordering::Relaxed);

    // inner_size, not outer_size.
    //
    // On Windows `set_size` sets the *client* area while `outer_size` reports
    // the frame around it, so saving one and restoring with the other made the
    // window grow by the width of its own border on every single launch. Both
    // ends of the round trip have to speak the same units.
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else { return };
    log::event(&format!(
        "window: remembering {},{} {}x{}",
        pos.x, pos.y, size.width, size.height
    ));
    let _ = config::set_window_box(config::WindowBox {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One instance only. Beyond the usual tidiness, two instances would
        // both refresh the Spotify token on launch, and because PKCE rotates
        // refresh tokens the second refresh invalidates the first — which
        // presents to the user as being silently logged out.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // Path B starts polling as soon as the app is up. It reports
            // "not connected" harmlessly until authorisation lands.
            spotify::poller::spawn(app.handle().clone());

            // Drops a working example shader in %APPDATA% on first run.
            shaders::ensure_user_dir();

            #[cfg(windows)]
            tray::build(app.handle())?;

            // Open where it was left. Checked against the monitors that exist
            // right now: a window restored onto a screen that has since been
            // unplugged is a window you cannot reach.
            use tauri::Manager as _;
            if let Some(window) = app.get_webview_window("main") {
                match config::window_box() {
                    Some(b) if geometry_visible(&window, &b) => {
                        let _ = window
                            .set_position(tauri::PhysicalPosition::new(b.x, b.y));
                        let _ = window.set_size(tauri::PhysicalSize::new(b.width, b.height));
                        log::event(&format!(
                            "window: restored to {},{} {}x{}",
                            b.x, b.y, b.width, b.height
                        ));
                    }
                    Some(b) => log::event(&format!(
                        "window: saved geometry {},{} {}x{} is off-screen — ignoring",
                        b.x, b.y, b.width, b.height
                    )),
                    None => log::event("window: no saved geometry"),
                }
            }

            // Path A. Independent of Spotify entirely — it visualises whatever
            // the speakers are playing, from any application.
            // Start on whatever was being listened to last time. Stored as an
            // executable name, resolved to a live process here.
            let preferred = config::ui_state()
                .and_then(|v| v.get("source").cloned())
                .and_then(|v| serde_json::from_value::<audio::Source>(v).ok())
                .unwrap_or_default();
            audio::start(app.handle().clone(), preferred);

            log::event(&format!(
                "autostart: start with Windows is {}",
                if autostart::enabled() { "on" } else { "off" }
            ));

            #[cfg(windows)]
            {
                let apps = audio::sessions::list();
                log::event(&format!(
                    "audio: {} app session(s): {}",
                    apps.len(),
                    apps.iter()
                        .map(|a| format!(
                            "{}{}",
                            a.exe,
                            if a.active { "*" } else { "" }
                        ))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember_geometry(window),
                // On the way out the throttle does not apply: this is the last
                // chance to record where the window ended up.
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                    if window.is_decorated().unwrap_or(false)
                        && !window.is_minimized().unwrap_or(false)
                        && !window.is_maximized().unwrap_or(false)
                    {
                        if let (Ok(pos), Ok(size)) =
                            (window.outer_position(), window.inner_size())
                        {
                            let _ = config::set_window_box(config::WindowBox {
                                x: pos.x,
                                y: pos.y,
                                width: size.width,
                                height: size.height,
                            });
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            spotify_status,
            spotify_connect,
            spotify_disconnect,
            client_id_present,
            set_client_id,
            ui_log,
            ui_state_get,
            ui_state_set,
            autostart_get,
            autostart_set,
            open_external,
            audio_info,
            audio_devices,
            audio_apps,
            audio_source,
            set_audio_source,
            displays,
            cover_data_url,
            spotify_control,
            lyrics_current,
            lyrics_recheck,
            set_fullscreen,
            lyric_offset_get,
            lyric_offset_set,
            shader_presets,
            shader_stamps,
            open_shader_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ROOMTONE");
}
