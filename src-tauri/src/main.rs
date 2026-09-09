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

// No console window, ever — not even in a debug build.
//
// Everything worth reading goes to %APPDATA%/roomtone/auth.log, which is the
// file a bug report should carry anyway. A black terminal opening beside a
// visualizer is just noise.
#![windows_subsystem = "windows"]

fn main() {
    roomtone_lib::run();
}
