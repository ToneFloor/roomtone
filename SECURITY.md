# Security

## Reporting

If you find a vulnerability, please open a
[security advisory](https://github.com/ToneFloor/roomtone/security/advisories/new)
rather than a public issue.

## What is worth reporting

ROOMTONE handles two things that matter:

- **Spotify tokens.** The refresh token lives in the Windows Credential Manager.
  Anything that causes a token to be written to disk, logged, or sent anywhere
  other than `accounts.spotify.com` is a vulnerability.
- **The event log.** `%APPDATA%\roomtone\auth.log` is documented as safe to
  share. Anything identifying appearing in it — a token, an account ID, a file
  path, a machine or user name — is a vulnerability, even though it never leaves
  the machine on its own.

The app makes no network requests other than to Spotify and LRCLIB. A request to
anywhere else is a bug worth reporting regardless of what it does.

## What is not a vulnerability

- The Spotify Client ID stored in `config.json`. A PKCE client ID is public by
  design; it is not a secret and cannot be used without the user completing an
  interactive login.
- The app requiring no elevation. It deliberately never asks for administrator
  rights — the startup entry is written under `HKEY_CURRENT_USER` for exactly
  this reason.
