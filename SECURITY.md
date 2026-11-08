# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository.
Include what you found, how to reproduce it, and the version or commit. You will get an answer within a few days.

## What matters most here

aution handles voice recordings, transcripts, a Google sign-in and (optionally) a per-person Google Drive connection, so reports about
the following are especially welcome: authentication or pairing bypass, one person reading another person's notes, token handling,
the OAuth flows, and anything that makes the server fetch or write somewhere it should not.

## Running your own server

- Keep `.env` out of version control (it is git-ignored) and treat `MCP_TOKEN`, `GOOGLE_CLIENT_SECRET` and the data directory as secrets.
- Serve it over HTTPS only (the Caddyfile example does this).
- Keep `ALLOWED_EMAILS` set so only the people you intend can sign in.
