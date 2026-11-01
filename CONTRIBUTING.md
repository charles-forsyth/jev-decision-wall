# Contributing

Thanks! The most wanted contribution is **new question sets**.

## Run it
```bash
cp .env.example .env   # add your TypeSafe key
node server.js         # http://127.0.0.1:8770
npm run check          # validates sets + runs tests (no key or network needed)
```
No dependencies, no build step. Node 20+.

## Add a question set
1. Copy `public/sets/01-signal.js` to `public/sets/08-yourset.js`.
2. 8 categories x 25 questions = exactly 200. Each entry is `"Short label|Full yes/no question?"`.
3. Add 3-4 sample texts (made up, no real people or private data).
4. Add a `<script src="sets/08-yourset.js">` line in `public/index.html`.
5. `npm run check` must pass.

**Writing good questions:** one narrow judgment each; name the concrete thing ("Does it ask for gift cards?") rather than a vague concept ("Is it sketchy?"). Jev answers each question independently, so don't refer to other questions.

## Pull requests
Branch, small focused PR, CI green. Screenshots welcome for UI changes.
