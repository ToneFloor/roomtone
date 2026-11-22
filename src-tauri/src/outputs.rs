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

//! Output windows: the visualizer on other monitors.
//!
//! Each one is a borderless window loading the same front end in viewer mode
//! (`?output=N`). The main window is untouched; outputs are labelled
//! `output-{N}` where N indexes the list the `displays` command returns, so the
//! picker and the windows can never disagree about which screen is which.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PREFIX: &str = "output-";

fn label(display: usize) -> String {
    format!("{PREFIX}{display}")
}

/// Open (or bring forward) the output window for one monitor.
///
/// `async` on purpose: building a window from a synchronous command runs on the
/// thread that services the window's own message loop, which deadlocks on
/// Windows. Async commands run on the runtime and Tauri marshals the build.
#[tauri::command]
pub async fn output_open(app: AppHandle, display: usize) -> Result<(), String> {
    let label = label(display);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // Same source and order as the `displays` command.
    let main = app.get_webview_window("main").ok_or("no main window")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .get(display)
        .ok_or_else(|| format!("no display {display}"))?;
    let pos = *monitor.position();
    let size = *monitor.size();

    // Created hidden and placed before it is shown, so it never flashes up on
    // the main monitor first.
    let window = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html?output={display}").into()),
    )
    .title(format!("ROOMTONE — Display {}", display + 1))
    .decorations(false)
    .resizable(false)
    .background_color(tauri::window::Color(8, 4, 15, 255))
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    #[cfg(windows)]
    crate::windows::cover_rect(&window, pos.x, pos.y, size.width, size.height)?;
    #[cfg(not(windows))]
    {
        let _ = window.set_position(pos);
        let _ = window.set_size(size);
        let _ = window.show();
    }
    Ok(())
}

#[tauri::command]
pub async fn output_close(app: AppHandle, display: usize) {
    if let Some(window) = app.get_webview_window(&label(display)) {
        let _ = window.close();
    }
}

/// Which displays currently have an output window, in ascending order.
#[tauri::command]
pub fn outputs_open(app: AppHandle) -> Vec<usize> {
    let mut open: Vec<usize> = app
        .webview_windows()
        .keys()
        .filter_map(|l| l.strip_prefix(PREFIX)?.parse().ok())
        .collect();
    open.sort_unstable();
    open
}

/// Close every output window. Called when the main window goes, because a
/// window left open would keep the process alive with nothing to control it.
pub fn close_all(app: &AppHandle) {
    for (l, window) in app.webview_windows() {
        if l.starts_with(PREFIX) {
            let _ = window.destroy();
        }
    }
}
