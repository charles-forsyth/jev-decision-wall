# Changelog

## 1.0.0 - 2026-11-01
First public release.
- Live heatmap: 200 yes/no questions answered by TypeSafe Jev in one call (~150-300 ms), debounced as you type.
- Seven question sets of 200 (8 categories x 25): Everyday Signal, Scam Shield, Homestead, Research Computing, Ops & Security, News & Claims, Story Engine.
- Fire all 7 sets: 1,400 answers from 7 parallel calls in about the time of one.
- Threshold slider, sort by heat, lit-only view, per-question drawer with history.
- Zero-dependency Node server: key stays server-side, answer cache, daily token cap, usage log.
- Optional sign-in mode (`AUTH_HEADER`, `ALLOWED_DOMAIN`) with structured audit logs; Cloud Run + IAP deploy script.
