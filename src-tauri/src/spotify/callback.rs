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

//! The one-shot loopback listener that catches Spotify's redirect.
//!
//! Spotify requires the authorisation step to happen in the user's real
//! browser, not an embedded webview, so the app opens the system browser and
//! then waits here for the browser to come back to
//! `http://127.0.0.1:8888/callback?code=...`.
//!
//! This is hand-written rather than pulling in an HTTP server crate: it accepts
//! exactly one request, reads one line of it, and replies with one page. A web
//! framework would be more code, not less.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

pub const REDIRECT_URI: &str = "http://127.0.0.1:8888/callback";
const BIND_ADDR: &str = "127.0.0.1:8888";
const TIMEOUT: Duration = Duration::from_secs(180);

/// Binds the port. Do this *before* opening the browser, so there is no window
/// in which the redirect can arrive at a closed port.
pub fn bind() -> Result<TcpListener, String> {
    let listener = TcpListener::bind(BIND_ADDR).map_err(|e| {
        format!(
            "could not listen on {BIND_ADDR} ({e}). Another program may be using port 8888."
        )
    })?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(listener)
}

/// Blocks until the browser hits the callback, then returns the `code`.
/// Runs on a blocking thread — never call this on the UI thread.
pub fn wait_for_code(listener: TcpListener) -> Result<String, String> {
    let deadline = Instant::now() + TIMEOUT;

    loop {
        if Instant::now() > deadline {
            return Err("timed out waiting for Spotify to redirect back".into());
        }

        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).ok();
                match handle(stream) {
                    // Ignore favicon and other stray requests; keep waiting.
                    Ok(None) => continue,
                    Ok(Some(result)) => return result,
                    Err(_) => continue,
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(60));
            }
            Err(e) => return Err(format!("callback listener failed: {e}")),
        }
    }
}

/// `Ok(None)` means "not the callback, keep listening".
fn handle(mut stream: TcpStream) -> Result<Option<Result<String, String>>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;

    let mut request_line = String::new();
    BufReader::new(
        stream
            .try_clone()
            .map_err(|e| e.to_string())?,
    )
    .read_line(&mut request_line)
    .map_err(|e| e.to_string())?;

    // "GET /callback?code=... HTTP/1.1"
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    if !path.starts_with("/callback") {
        respond(&mut stream, 404, &page("Not found", "This is not the page you want.", false));
        return Ok(None);
    }

    let full = format!("http://127.0.0.1:8888{path}");
    let parsed = url::Url::parse(&full).map_err(|e| e.to_string())?;

    let mut code = None;
    let mut error = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.to_string()),
            "error" => error = Some(v.to_string()),
            _ => {}
        }
    }

    if let Some(code) = code {
        respond(
            &mut stream,
            200,
            &page(
                "Connected",
                "ROOMTONE has your Spotify authorisation. You can close this tab and go back to the app.",
                true,
            ),
        );
        return Ok(Some(Ok(code)));
    }

    let reason = error.unwrap_or_else(|| "no code in the redirect".into());
    let hint = if reason == "access_denied" {
        "You declined the authorisation request.".to_string()
    } else {
        format!(
            "Spotify said: {reason}. If this is a 403, add your own Spotify account under \
             User Management in the developer dashboard — apps in development mode only \
             allow users you add by hand."
        )
    };
    respond(&mut stream, 400, &page("Not connected", &hint, false));
    Ok(Some(Err(reason)))
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn page(title: &str, message: &str, ok: bool) -> String {
    let accent = if ok { "#7c5cff" } else { "#ff5c7c" };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>ROOMTONE</title>
<style>
html,body{{margin:0;height:100%;background:#08040f;color:#fff;
font-family:'Space Grotesk',Segoe UI,Helvetica,Arial,sans-serif;
display:flex;align-items:center;justify-content:center}}
main{{text-align:center;max-width:520px;padding:40px}}
h1{{font-size:13px;letter-spacing:.34em;text-transform:uppercase;color:{accent};margin:0 0 28px}}
h2{{font-size:30px;margin:0 0 16px;font-weight:600}}
p{{color:#8f8a99;line-height:1.65;font-size:14px;margin:0}}
.dot{{width:8px;height:8px;border-radius:50%;background:{accent};margin:0 auto 28px;
box-shadow:0 0 32px 6px {accent}}}
</style></head><body><main>
<div class="dot"></div><h1>ROOMTONE</h1><h2>{title}</h2><p>{message}</p>
</main></body></html>"#
    )
}
