# Decision Wall: specification

| | |
|---|---|
| Spec version | 1.0, 2026-11-04 (first spec; written from the code, README, CHANGELOG and the two deployments) |
| Applies to | Decision Wall v1.2.3 (CHANGELOG, tag/release v1.2.3, 2026-11-02) |
| Status | Released. Public repo, GitHub Pages app in recorded mode, and a UCR-only Cloud Run instance with a live key |
| Owner | Charles Forsyth. Independent experiment; not affiliated with or endorsed by TypeSafe. |
| Repos | Public: https://github.com/charles-forsyth/jev-decision-wall (MIT, this repo). Private dev twin: `charles-forsyth/jev-decision-wall-dev` (checkout `~/Projects/jev-decision-wall`), holds the Cloud Run deploy and syncs to public releases |
| Cite | Zenodo concept DOI 10.5281/zenodo.23874577 (a version DOI is minted per GitHub release) |

## 1. What it is

A web app that breaks a judgment about a piece of text into 200 small yes/no questions, asks
TypeSafe's Jev all of them in one parallel call (about 150-300 ms measured), and draws the
answers as a live heatmap. Code, not the model, decides what crosses the threshold.

Seven question sets (tabs), each 8 categories x 25 questions: Everyday Signal, Scam Shield,
Homestead, Research Computing, Ops & Security, News & Claims, Story Engine. "Fire all 7 sets"
sends 7 calls in parallel (1,400 answers in about one call's wall clock).

Features (v1.2): live typing (380 ms debounce, stale requests aborted, cache per set + text);
question drawer; threshold slider; Explain (leave each sentence out, re-ask in parallel, colour
the words that drive a question); flip strip (what crossed the threshold after an edit); burst
race (parallel vs back-to-back sum); share link (all 200 answers in the URL, one byte each);
fingerprint PNG (1200x630) and JSON export, each labelled live, recorded or shared.

## 2. Architecture

| Part | File | Lines (v1.2.3) |
|---|---|---|
| Key-holding proxy and static server, Node >= 20, zero dependencies | `server.js` | 212 |
| Front end | `public/index.html`, `public/app.js`, `public/codec.js` (share-link codec), `public/sets/0N-*.js` ("Label|Question" strings) | about 760 |
| Recorded answers for keyless demos | `public/replays.js` (from `scripts/record-replays.js`) | |
| Pages build | `scripts/build-pages.js` -> `docs/app/` | |
| Set checker | `scripts/check-sets.js` (8 x 25 per set, lengths) | |

The browser never sees the key. The server calls Jev (`JEV_MODEL`, default `jev-latest`) with the
key from `TYPESAFE_API_KEY` or `~/.config/jev/.key`.

## 3. Modes

| Mode | Where | Key | Notes |
|---|---|---|---|
| Recorded | GitHub Pages `https://charles-forsyth.github.io/jev-decision-wall/app/` | none | only when there is no server at all; results labelled recorded |
| Local | `node server.js` -> `http://127.0.0.1:8770/` | the user's own | usage log `~/.config/jev/usage.jsonl` |
| UCR Cloud Run | service `jev-decision-wall` in project `ucr-research-computing` (us-central1), behind IAP | Secret Manager `jev-decision-wall-key` | from the private dev repo, `deploy/deploy.sh`; only `domain:ucr.edu` via IAP plus a server-side domain check on the IAP email header; runtime SA has no project roles; scales to zero, max 1 instance; revision 00004 on 2026-11-04 |

## 4. Guards (server)

| Guard | Default |
|---|---|
| Daily input-token cap, all users | `JEV_DAILY_TOKEN_CAP` 5,000,000 (about $0.21 at $0.042/M) |
| Per signed-in user | `JEV_USER_DAILY_TOKEN_CAP` 1,000,000 |
| Upstream timeout | `JEV_TIMEOUT_MS` 15,000 |
| Request limits | at most 220 questions, 400 chars per question, a cap on total question text, 12,000-char state |
| Auth | `AUTH_HEADER` + `ALLOWED_DOMAIN`; `ALLOWED_DOMAIN` without `AUTH_HEADER` refuses to start; the deploy guard fails closed |
| Robustness | a client that disconnects mid-upload cannot crash the server; token reservations released exactly once; a 200 with no answers is an error and never cached |
| Audit (Cloud Run) | structured JSON per page view, ask (text preview, hash, tokens), sample, burst, denial -> Cloud Logging `jsonPayload.component="jev-decision-wall"` |

Data rule: synthetic samples only; do not paste UCR work data (TypeSafe terms). Share links contain
the text, and the README says so.

## 5. Build, test, release

- `npm test`: 21 tests (`test/server.test.js` 15, `test/frontend.test.js` 6), each server fix with a
  regression test. `npm run check` adds the set checker. CI on every push and PR.
- `npm run pages` rebuilds `docs/app/`; `npm run record` refreshes replays (needs a key).
- Release: CHANGELOG entry, tag, GitHub release (mints a Zenodo version DOI). The private dev repo
  syncs to the public release ("Sync to public vX.Y.Z") and redeploys Cloud Run.

## 6. Open items

1. The dev repo and public repo are kept in step by hand; record each sync in both histories.
2. Demo video and screenshots must be retaken whenever the header or layout changes (v1.2.1 precedent).

## 7. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-11-01 | 7 sets x 200, live heatmap, parallel burst, local key proxy |
| 1.1 | 2026-11-01 | crash fixes (malformed URL, null bodies); Cloud Run + IAP, per-user caps, audit log |
| 1.2.0 | 2026-11-01 | Explain, flip strip, burst race, share link, fingerprint PNG, JSON export |
| 1.2.1 | 2026-11-01 | independent-demo framing, not-affiliated footer |
| 1.2.2 | 2026-11-01 | fourth review panel fixes, 21 tests |
| 1.2.3 | 2026-11-02 | CITATION.cff, Zenodo DOI |
| spec 1.0 | 2026-11-04 | First SPEC |
