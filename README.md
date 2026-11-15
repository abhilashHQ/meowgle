# MeowGle

A chat agent with one tool, web search, that remembers what you asked it, what it told you, and when.

Ask it about Postgres hosting on Tuesday. On Sunday, ask "has anything changed since then". It knows which day Tuesday was, what it told you, and which page each number came from. Then it re-reads those pages live before answering.

![Asked on Sunday about a CRM shortlist from Monday: MeowGle re-checks each of the five tools against the prices it gave, says which pages it couldn't confirm, and keeps its pick](docs/img/crm.png)

How it's built and why: [DESIGN.md](DESIGN.md).

## What you need

- Node 22.13 or newer
- A Claude subscription (Pro, Max, Team) or an Anthropic API key
- An Exa API key

The only runtime dependency is `@anthropic-ai/claude-code`, pinned. That's the Claude Code CLI, and MeowGle runs the model through it, so you don't need it installed globally. Everything else is dev-only.

## Run it

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `CLAUDE_CODE_OAUTH_TOKEN` for a subscription (run `npx claude setup-token` and paste what it prints), or `ANTHROPIC_API_KEY`. If both are set, the token wins.
- `EXA_API_KEY` from dashboard.exa.ai.

The CLI runs with its own config dir (`data/claude-config`), so your own Claude Code settings are never read or touched.

```bash
npm run dev
```

Open http://localhost:3000. The server listens on 127.0.0.1 only.

## Give it a past (optional)

A fresh install has no history, so "what did I ask you last Tuesday" correctly gets "nothing". To try the memory right away, seed it before the first `npm run dev`:

```bash
npm run seed
```

It asks four questions through the real agent, with the clock set back to the day each was "asked":

| When | Chat | Question |
| --- | --- | --- |
| 3 November, 11:00 | Node | Which Node.js version is the current LTS, and when does it reach end of life? |
| Last Monday, 10:30 | CRM | We're a 20-person sales team and need a CRM. Shortlist 5 options with their per-seat monthly price. |
| Last Monday, 10:45 | CRM | Which one would you pick for us, and why? |
| Last Tuesday, 16:00 | Postgres | What does Postgres hosting cost on Neon, Supabase and Render for a small production app? |

Nothing is written by hand. Each question runs the full path: real Claude, real Exa searches, and the same background filing that runs after every answer. Only the timestamps are moved back. The pages are read when you run it, so the prices are today's, and "has it changed?" will usually find them unchanged.

It costs about four short turns of your Claude access and a handful of Exa calls. It refuses to run on a database that already has chats. To seed a separate one, set `DB_PATH` for both commands.

Then try the brief's questions:

- On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?
- What did I ask you on 3 November? Is your answer still correct today?
- Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?

![What did I ask you on 3 November: it finds the Node.js question, re-reads the releases page live and confirms the answer still holds](docs/img/nov3.png)

![Last Tuesday's Postgres prices: it re-reads the three pricing pages it cited and checks each saved value](docs/img/postgres.png)

## Using it

While it works, you see what it's doing: what it searched, how many results came back and from where, which pages it's reading live. The trail folds into one line once the answer starts streaming.

![The live trail: news searches since Monday for each of the five tools, and the five pricing pages it cited on Monday requested with a live crawl](docs/img/crm-working.png)

Every answer has a **Context** button. It shows exactly what went into the model for that turn: the system prompt, each part of the message, and every `web_search` call with what it returned, each sized in estimated tokens. It's saved with the turn, so old chats have it too (except turns from before I added it).

![The context panel for a follow-up: the system prompt, each part of the message with its estimated tokens, and the one web_search call with its arguments and what it returned](docs/img/context.png)

The effort toggle controls how much it checks. Answer length stays the same.

| Effort | Tool calls | What it does |
| --- | --- | --- |
| low | 3 | one search round, opens the primary page if the answer is a number that moves |
| medium | 6 | searches every part of the question, reads the pages the answer rests on |
| high | 12 | searches wide, reads pages in full, cross-checks the figures |

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

Tests never touch the network. The model and search are passed in as functions, so the tests swap in fakes and drive a full turn: tool calls, streamed events, persistence, the tool budget, live re-reads of stored URLs.

## Layout

```
src/server.ts    HTTP routes, SSE, the MCP endpoint
src/setup.ts     db, model and tools from .env, shared by the server and the seed
src/agent.ts     runTurn(): one chat turn, start to finish
src/llm.ts       spawns `claude -p`, parses its stream, serves MCP
src/tools.ts     web_search (searches and page reads) against Exa
src/memory.ts    SQLite, the question ledger, the date strip, the extractor, the FTS index
src/recall.ts    which past chats ride along with each message
src/prompt.ts    the system prompt, effort settings, message building
scripts/seed.ts  npm run seed
public/index.html  the whole UI, no build step
```

## Known gaps

- Every turn spawns a fresh `claude -p` process. That startup cost is what I pay for one code path that works on a subscription or an API key.
- Exa sometimes serves a cached copy of a page even when asked for a live one. MeowGle says so in the answer.
