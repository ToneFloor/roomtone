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

//! Start ROOMTONE when Windows starts.
//!
//! Done with the `Run` key under **HKEY_CURRENT_USER**, not HKLM and not a
//! scheduled task. That choice matters: HKCU needs no administrator rights, so
//! the toggle just works instead of throwing a UAC prompt at somebody who only
//! wanted a checkbox, and it applies to this user rather than to everyone who
//! signs in to the machine.
//!
//! The state is read back out of the registry rather than remembered in the
//! config file. A user can delete the entry from Task Manager's Startup tab at
//! any time, and a checkbox that disagrees with what the machine is actually
//! going to do is worse than no checkbox.

use std::path::PathBuf;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE: &str = "ROOMTONE";

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_SZ,
    };

    fn open(access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Option<HKEY> {
        unsafe {
            let mut key = HKEY::default();
            let status = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                Some(0),
                access,
                &mut key,
            );
            if status == ERROR_SUCCESS {
                Some(key)
            } else {
                None
            }
        }
    }

    /// The command the Run key should hold: our own path, quoted.
    ///
    /// Quoted because `C:\Program Files\...` without quotes is read by Windows
    /// as `C:\Program` with arguments, which is a classic way to end up with a
    /// startup entry that silently does nothing.
    fn command() -> Result<String, String> {
        let exe: PathBuf =
            std::env::current_exe().map_err(|e| format!("could not find our own path: {e}"))?;
        Ok(format!("\"{}\"", exe.display()))
    }

    pub fn enabled() -> bool {
        unsafe {
            let Some(key) = open(KEY_READ) else { return false };
            let mut size: u32 = 0;
            let status = RegQueryValueExW(
                key,
                &HSTRING::from(VALUE),
                None,
                None,
                None,
                Some(&mut size),
            );
            let _ = RegCloseKey(key);
            status == ERROR_SUCCESS && size > 0
        }
    }

    pub fn set(on: bool) -> Result<(), String> {
        unsafe {
            let key = open(KEY_READ | KEY_WRITE)
                .ok_or_else(|| "could not open the Windows startup list".to_string())?;

            let result = if on {
                let value = command()?;
                // REG_SZ wants UTF-16 including the terminating null, handed
                // over as raw bytes.
                let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
                let bytes = std::slice::from_raw_parts(
                    wide.as_ptr() as *const u8,
                    wide.len() * std::mem::size_of::<u16>(),
                );
                let status =
                    RegSetValueExW(key, &HSTRING::from(VALUE), None, REG_SZ, Some(bytes));
                if status == ERROR_SUCCESS {
                    Ok(())
                } else {
                    Err(format!("could not write the startup entry ({status:?})"))
                }
            } else {
                // Bound, not inlined: the pointer has to outlive the call, and
                // a temporary inside the argument list is a trap waiting for
                // someone to refactor it.
                let name = HSTRING::from(VALUE);
                let status = RegDeleteValueW(key, PCWSTR(name.as_ptr()));
                // Already absent is the state we wanted, not a failure.
                if status == ERROR_SUCCESS || !enabled_unlocked(key) {
                    Ok(())
                } else {
                    Err(format!("could not remove the startup entry ({status:?})"))
                }
            };

            let _ = RegCloseKey(key);
            result
        }
    }

    unsafe fn enabled_unlocked(key: HKEY) -> bool {
        let mut size: u32 = 0;
        let status = RegQueryValueExW(
            key,
            &HSTRING::from(VALUE),
            None,
            None,
            None,
            Some(&mut size),
        );
        status == ERROR_SUCCESS && size > 0
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn enabled() -> bool {
        false
    }
    pub fn set(_on: bool) -> Result<(), String> {
        Err("Windows only".into())
    }
}

pub use imp::{enabled, set};
