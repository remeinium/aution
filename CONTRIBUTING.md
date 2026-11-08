# Contributing to aution

Thanks for helping. aution is a self-hostable voice-notes app: a PWA / Tauri client in the repository root and a Node server in `server/`.

## Set up

Node 24 is recommended (the server needs 22.18+).

```bash
npm ci && npm --prefix server ci
npm run dev                  # the web app
npm --prefix server start    # the server (see server/README.md for the .env it needs)
```

## Before you open a pull request

```bash
npm run lint && npm run build && npm test     # web app
npm --prefix server run typecheck && npm run server:test
```

CI runs the same commands. A change that fixes a bug should include a test that fails without the fix.

## Ground rules

- Keep a pull request to one subject, and explain *why* in the description, not only what changed.
- User-facing text is plain language and uses the name **aution** (lowercase).
- Never commit secrets, real hostnames, IP addresses or personal data. Use `example.com` style placeholders in docs and tests.
- Some names are kept on purpose so existing installs keep working: the IndexedDB name `trapper-voice`, token prefixes `vbd_` and `vbk_`, and the Drive marker `vbRole`. Do not rename them.
- Report security problems privately: see [SECURITY.md](SECURITY.md).
