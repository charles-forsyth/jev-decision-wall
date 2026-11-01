# Changelog

## 1.1.0 - 2026-11-01
Fixes from three 10-reviewer adversarial panels (security, usability, uniqueness). Every crash below was reproduced first and now has a regression test.

Security and reliability
- Fixed three one-request crashes: a malformed URL, and a `null` JSON body sent to `/api/jev` or `/api/event`.
- `.env` inline comments (`JEV_DAILY_TOKEN_CAP=5000000  # note`) no longer turn the cap off; any non-numeric cap falls back to the default with a warning.
- Parallel calls now reserve budget before they start, so a burst can't run past the daily or per-user cap.
- A corrupt line in the usage log no longer resets the day's total.
- TypeSafe calls time out after 15 s (`JEV_TIMEOUT_MS`) with a clear 504.
- Only yes/no questions of at most 400 characters are forwarded; the model can't be overridden from the browser.
- TypeSafe error bodies are summarized rather than relayed verbatim.
- Content-Security-Policy header with `frame-ancestors 'none'`; request and header timeouts.
- Audit-log text fingerprint is now a keyed hash (`LOG_HASH_SALT`).
- Cloud Run script: fails closed if the IAM policy can't be read, stores a new secret version whenever a key is supplied (rotation works), reads only the key from `.env`, validates `DOMAIN`, and ships a `.gcloudignore`.
- Docker quick start binds to localhost only.

Usability
- First visit runs a sample, so nobody lands on an empty wall; `?text=` and `?set=` open a specific text and set.
- Phone layout fits (no sideways scrolling).
- Steeper heat ramp: .55 and .95 are clearly different tiers; larger numbers on lit cells.
- The wall dims while typing and on errors, so old answers never look current; clearing the box mid-request no longer paints stale answers; the burst no longer overwrites the wall if you've edited the text.
- The top-answers readout follows the threshold slider below 0.5.
- Honest HUD: real call count, "shown from cache" instead of "0 ms".
- Keyboard focus rings, aria labels on cells, live status announcements, dialogs with focus return.
- Labels no longer break mid-word.

Question sets
- Replaced "absence" questions that light up when nothing is there (e.g. "No money involved", "Nothing new") with real signals.
- Scam Shield no longer treats non-native English as a scam sign ("Wrong idioms", "Odd grammar" replaced with "Style mismatch", "Missing specifics").

Docs
- Tagline and copy no longer overclaim ("about a quarter second"; calibration attributed to TypeSafe); sign-in mode warning; best-effort caps on Cloud Run.

## 1.0.0 - 2026-11-01
First public release.
- Live heatmap: 200 yes/no questions answered by TypeSafe Jev in one call (~150-300 ms), debounced as you type.
- Seven question sets of 200 (8 categories x 25): Everyday Signal, Scam Shield, Homestead, Research Computing, Ops & Security, News & Claims, Story Engine.
- Fire all 7 sets: 1,400 answers from 7 parallel calls in about the time of one.
- Threshold slider, sort by heat, lit-only view, per-question drawer with history.
- Zero-dependency Node server: key stays server-side, answer cache, daily token cap, usage log.
- Optional sign-in mode (`AUTH_HEADER`, `ALLOWED_DOMAIN`) with structured audit logs; Cloud Run + IAP deploy script.
