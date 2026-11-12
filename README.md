# minimi

A small chat agent with one tool: web search. Dates resolve in code, memory comes from SQLite, a fast model plans the search, Exa fetches sources, and the main model streams an answer with verified citations. The UI shows the live trace as it happens: recall, thinking it through, search, review, thinking again, then writing.

## What you get

- A reasoning selector with four levels. `low` and `medium` do one search round. `high` and `xhigh` review coverage and run extra search rounds when the sources leave gaps.
- A live SSE timeline with streamed thoughts, search queries, sources, timings, and a stop button.
- Modern Exa search: `objective` ranking, query-focused highlights, freshness windows, and full text for re-checks.
- Answers written like a chat rather than a report, with `[S#]` citations checked against the sources fetched that turn.
- Graceful degradation: a failed planner falls back to searching the raw message, a failed coverage review keeps the current sources, and a failed main model falls back to the fast model before any answer text is sent.

## Requirements

Node >= 22.13. SQLite comes from the built-in `node:sqlite`, so there are no native modules to build.

## Setup

```
cp .env.example .env
```

Add `GEMINI_API_KEY` and `EXA_API_KEY` to `.env`, then:

```
npm install
npm run dev
```

Open http://localhost:3000.

The default models are `gemini-3.6-flash` for answers and `gemini-3.1-flash-lite` for planning, review, claims, and streaming fallback. Override them with `GEMINI_MAIN_MODEL` and `GEMINI_FAST_MODEL`. Free-tier API keys have low daily request limits, so a quota error is shown as a friendly message instead of a stack trace.

## Optional

- `npm run seed` inserts demo history relative to the current clock. It refuses if turns already exist; add `--force` to clear both tables and reseed.
- `FAKE_NOW=2026-11-11T10:00:00Z npm run dev` pins the clock for demos and tests.
- The database lives at `data/minimi.db` by default. Override it with `DB_PATH`.

## Tests

```
npm test
npm run typecheck
```
