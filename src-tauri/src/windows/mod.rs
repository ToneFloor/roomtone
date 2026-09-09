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

//! Windows integration: the shape of the window in each output mode.

use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, HWND_NOTOPMOST,
    HWND_TOP, SWP_FRAMECHANGED, SWP_NOOWNERZORDER, SWP_SHOWWINDOW, WS_OVERLAPPEDWINDOW, WS_POPUP,
};

/// What the window looked like before it went fullscreen.
struct Restore {
    style: isize,
    rect: RECT,
}

static PRE_FULLSCREEN: Mutex<Option<Restore>> = Mutex::new(None);

/// Put the window back to being an ordinary app window.
pub fn restore(window: &tauri::WebviewWindow) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_always_on_top(false);
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_size(tauri::LogicalSize::new(1440.0, 900.0));
    let _ = window.center();
}

/// Borderless fullscreen, and back.
///
/// Done by hand in Win32 rather than through Tauri, for one specific reason:
/// **the window rectangle has to match the monitor rectangle exactly.** The
/// shell only gets out of the way — hiding the taskbar, stopping notifications
/// from popping over the top — for a window whose rect *equals* its monitor's.
///
/// Setting the size through Tauri does not achieve that. A resizable window
/// keeps an invisible resize border even with its decorations turned off, so
/// asking for 1920x1080 produced a 1936x1089 rectangle: eight pixels of nothing
/// down each side, nine along the bottom, spilling onto the next monitor, and a
/// taskbar still sitting on top because Windows never considered it fullscreen.
///
/// Stripping the window down to `WS_POPUP` removes that border, and then the
/// monitor rect can be applied literally.
///
/// The title bar has no place over a visualizer — but a fullscreen window with
/// no way out is a trap, so Escape always returns.
pub fn set_fullscreen(app: &AppHandle, on: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let handle = window
        .hwnd()
        .map_err(|e| format!("no window handle: {e}"))?;
    let hwnd = HWND(handle.0 as *mut _);

    unsafe {
        if !on {
            let saved = PRE_FULLSCREEN
                .lock()
                .map_err(|_| "fullscreen state poisoned".to_string())?
                .take();

            match saved {
                Some(saved) => {
                    SetWindowLongPtrW(hwnd, GWL_STYLE, saved.style);
                    let r = saved.rect;
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_NOTOPMOST),
                        r.left,
                        r.top,
                        r.right - r.left,
                        r.bottom - r.top,
                        SWP_FRAMECHANGED | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
                    );
                }
                // Never went fullscreen in the first place: put it back to the
                // ordinary window rather than doing nothing.
                None => restore(&window),
            }
            return Ok(());
        }

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return Err("could not read the window rectangle".into());
        }

        {
            let mut slot = PRE_FULLSCREEN
                .lock()
                .map_err(|_| "fullscreen state poisoned".to_string())?;
            // Only remember the *first* time, or going fullscreen twice would
            // record the fullscreen rect as the thing to come back to.
            if slot.is_none() {
                *slot = Some(Restore { style, rect });
            }
        }

        // The monitor the window is actually on, not the primary one.
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("could not read the monitor rectangle".into());
        }
        let m = info.rcMonitor;

        let bare = ((style as u32) & !WS_OVERLAPPEDWINDOW.0) | WS_POPUP.0;
        SetWindowLongPtrW(hwnd, GWL_STYLE, bare as isize);

        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            m.left,
            m.top,
            m.right - m.left,
            m.bottom - m.top,
            SWP_FRAMECHANGED | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        );
    }

    Ok(())
}
