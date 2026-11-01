# Security

## Reporting
Please report vulnerabilities privately through GitHub: **Security > Report a vulnerability** on this repo. Don't open a public issue.

## How keys are handled
- Your TypeSafe key lives only on the server: `TYPESAFE_API_KEY` env var, a git-ignored `.env`, or a key file. It is never sent to the browser, logged, or baked into the Docker image.
- `.env`, `.env.*` and `*.key` are in `.gitignore`; CI runs gitleaks on every push.
- On Cloud Run the key goes in Secret Manager and the service account has no project roles.

## What local mode does NOT do
Local mode has **no sign-in**. Anyone who can reach the port can spend your key, up to the daily cap. The server binds to `127.0.0.1` by default; don't set `HOST=0.0.0.0` on a shared network without putting sign-in in front (see `deploy/cloudrun.sh` or set `AUTH_HEADER` behind your own proxy).

## Your text
Text you type is sent to TypeSafe's API. Read [TypeSafe's terms](https://typesafe.ai/legal/privacy-policy) before pasting anything private.
