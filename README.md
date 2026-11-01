<div align="center">

# Decision Wall

### 200 questions. One call. A quarter second.

Type anything. Two hundred yes/no judgments light up as a live heatmap, all answered in **one parallel call** to [TypeSafe Jev](https://typesafe.ai).

[![CI](https://github.com/charles-forsyth/jev-decision-wall/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/charles-forsyth/jev-decision-wall/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-6fd3ff)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[▶ Watch the 70-second demo](https://charles-forsyth.github.io/jev-decision-wall/)** · [Quick start](#quick-start) · [How it works](#how-it-works) · [Question sets](#seven-question-sets)

<img src="docs/media/live-typing.gif" alt="Typing into Decision Wall: safety questions light up as the sentence grows" width="800">

</div>

---

## Why this exists

Most AI models write. **Jev answers.** It's a "System One" model: give it some text and a list of questions, and it returns a calibrated probability for each one. No prose, no reasoning chains, just typed answers your code can use.

The surprising part is **width**. Asking 200 questions about one text costs almost the same time as asking one:

| questions in one call | latency (measured) | per question |
|---:|---:|---:|
| 1 | ~185 ms | 185 ms |
| 50 | ~200 ms | 4 ms |
| 200 | **~150–300 ms** | **~1.5 ms** |

Decision Wall makes that visible. Every cell on the wall is a separate question. They all go out together, come back together, and light up in about the time it takes to blink.

## What you can do

- **Type and watch it think.** The wall recalculates every time you pause typing (~0.4 s). Add *"...and I smell gas"* to a sentence about a truck that won't start, and the safety panel lights up.
- **Paste anything.** An email, a scam text, a log line, a news post, a story pitch.
- **Click any cell** to see the exact question, its probability, its rank, and how it changed across your recent inputs.
- **Slide the threshold.** The wall re-sorts instantly with **no new call**: the model gives probabilities once, your code decides what counts.
- **Fire all 7 sets.** 1,400 questions across seven parallel calls. Measured: **1,400 answers in 283 ms** wall clock.

<table>
<tr>
<td width="50%"><img src="docs/media/01-hero-scam.jpg" alt="Scam Shield reading a grandparent scam text"><br><sub><b>Scam Shield</b> on a grandparent scam: <i>Grandparent scam .98, Gift cards .98, Urgency .98</i></sub></td>
<td width="50%"><img src="docs/media/02-wall-scam.jpg" alt="The full 200-cell heatmap in eight categories"><br><sub><b>The wall:</b> 8 categories × 25 questions, brightness = probability</sub></td>
</tr>
<tr>
<td><img src="docs/media/04-drawer.jpg" alt="Clicking a cell opens its question, score ring and history"><br><sub><b>Click a cell:</b> the exact question, score, rank and history</sub></td>
<td><img src="docs/media/05-burst.jpg" alt="Seven question sets fired in parallel"><br><sub><b>Parallel burst:</b> 7 sets, 1,400 answers, one blink</sub></td>
</tr>
</table>

## Quick start

You need **Node 20+** and a **TypeSafe API key** ([typesafe.ai](https://typesafe.ai)). No `npm install`; there are zero dependencies.

```bash
git clone https://github.com/charles-forsyth/jev-decision-wall.git
cd jev-decision-wall
cp .env.example .env          # then paste your key after TYPESAFE_API_KEY=
node server.js                # → http://127.0.0.1:8770
```

Or pass the key inline: `TYPESAFE_API_KEY=ts-... node server.js`

Or with Docker:

```bash
docker build -t jev-decision-wall .
docker run --rm -p 8770:8080 -e TYPESAFE_API_KEY=ts-... jev-decision-wall
```

**What does it cost?** Jev charges for input tokens only. One 200-question call is about 3,000–4,700 tokens, so at TypeSafe's published $0.042 per million input tokens a full wall costs roughly **$0.0002**. The server stops calling at a daily cap (default 5M tokens ≈ $0.21) and logs every call to `~/.config/jev/usage.jsonl`.

## Seven question sets

Each set is **exactly 200 unique questions** in 8 categories of 25, plus sample texts to try. Pick one from the tabs.

| Set | What it reads | Categories |
|---|---|---|
| ✉ **Everyday Signal** | Any message or email | Intent · Asks & Actions · Time · Tone · Relationship · Content · Risk · Writing Quality |
| ⛨ **Scam Shield** | Texts, emails, DMs, listings | Pressure · Impersonation · Payment Rails · Data Grab · Too Good To Be True · Language Tells · Scam Type · Verdict |
| ❦ **Homestead** | Farm and rural field notes | Animals · Wildlife & Predators · Garden & Soil · Weather · Machines · Power & Water · Safety · Tasks |
| ⌬ **Research Computing** | Researcher requests and tickets | Request Type · Workload · Data Risk · Money · Urgency · Routing · Next Step · Strategy |
| ⚡ **Ops & Security** | Log lines, alerts, CVEs | Event Type · Subsystem · Security · Severity · Root Cause · Response · Environment · Signal Quality |
| ◎ **News & Claims** | Headlines and viral posts | Topic · Claims · Framing · Style & Source · Impact · Credibility · Emotion · Reader Action |
| ✦ **Story Engine** | Scenes, pitches, dreams | Genre · Characters · Setting · Plot & Stakes · Mood · Themes · Craft · Audience & Format |

Sets are plain JavaScript files in [`public/sets/`](public/sets/). Each line is `"Short label|Full yes/no question?"`. Writing your own takes about an hour; see [CONTRIBUTING.md](CONTRIBUTING.md). `npm run check` validates the count and uniqueness.

## How it works

```
 browser                      server.js (Node, 0 deps)                TypeSafe
┌────────────┐  POST /api/jev  ┌─────────────────────────┐   1 call    ┌──────────┐
│ text box   │ ──────────────▶ │ adds your key (env/.env)│ ──────────▶ │   Jev    │
│ 200 cells  │                 │ cache · daily cap · log │  200 nouls  │ System 1 │
│ threshold  │ ◀────────────── │ never sends key back    │ ◀────────── │          │
└────────────┘  200 probs      └─────────────────────────┘  ~200 ms    └──────────┘
```

- Every question is a Jev **noul** (a yes/no question that returns the probability of "yes"). The page sends all 200 as one request over the same text.
- Typing is **debounced** and stale requests are **aborted**, so the wall never jumps back to an older answer.
- Answers are **cached** by set + text, so backspacing to a previous sentence costs nothing.
- The browser never talks to TypeSafe directly. The API doesn't allow cross-origin calls, and this way your key stays on the server.

## Configuration

All optional. Set as environment variables or in `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | – | Your key (or put it in a file at `JEV_KEY_FILE`, default `~/.config/jev/.key`) |
| `PORT` / `HOST` | `8770` / `127.0.0.1` | Where to listen. Keep localhost unless you add sign-in. |
| `JEV_DAILY_TOKEN_CAP` | `5000000` | Stop calling after this many input tokens per day (all users) |
| `JEV_USER_DAILY_TOKEN_CAP` | `1000000` | Per signed-in user (sign-in mode only) |
| `JEV_USAGE_FILE` | `~/.config/jev/usage.jsonl` | Usage log |
| `AUTH_HEADER` | – | Header carrying the signed-in email (e.g. `x-goog-authenticated-user-email` behind Google IAP). Turns on sign-in mode and structured audit logs. |
| `ALLOWED_DOMAIN` | – | Only allow emails at this domain |
| `NOTICE` | – | Banner text shown under the wall |

## Hosting it for a team

Local mode has **no sign-in**: anyone who can reach the port can spend your key. To share it, put sign-in in front. A ready script deploys to **Google Cloud Run behind Identity-Aware Proxy**, limited to one Google Workspace domain, with the key in Secret Manager, per-user caps, and every action logged to Cloud Logging:

```bash
PROJECT=my-gcp-project DOMAIN=example.edu TYPESAFE_API_KEY=ts-... ./deploy/cloudrun.sh
```

It scales to zero, so it costs nothing when nobody is using it.

## Honest limits

- **Probabilities, not facts.** Jev is calibrated, but it's a fast judgment, not research. Treat differences under ~0.1 as noise, and don't set thresholds finer than that.
- **Soft concepts under-fire** when the text only implies them. Name the concrete thing in the question ("Does it ask for gift cards?") instead of the vague one ("Is it shady?").
- **Your text goes to TypeSafe.** Read their [privacy policy](https://typesafe.ai/legal/privacy-policy) before pasting anything private.
- Latency figures were measured on `jev-1.14` from a US home connection; yours will vary.

## Development

```bash
npm run check     # validate all question sets + run tests (no key or network needed)
npm start         # same as node server.js
```

The tests run the server against a fake TypeSafe endpoint and check that the key never leaks, caching, caps, request limits and the sign-in gate.

## License

MIT © Charles Forsyth. Not affiliated with TypeSafe; Jev and TypeSafe are their trademarks.
