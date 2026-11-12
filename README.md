# minimi

A small chat agent with one tool: web search. Dates are resolved in code, memory is recalled from SQLite, a fast model plans the search, Exa fetches sources, and the main model streams an answer with verified citations. History is stored as dated turns and claims.

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

## Optional

- `npm run seed` inserts demo history relative to the current clock. It refuses if turns already exist; add `--force` to clear both tables and reseed.
- `FAKE_NOW=2026-11-11T10:00:00Z npm run dev` pins the clock for demos and tests.
- The database lives at `data/minimi.db` by default. Override it with `DB_PATH`.

## Tests

```
npm test
```
