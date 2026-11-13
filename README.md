# MeowGle

A chat agent that searches the web and remembers everything you asked it, with dates.

Ask it about Postgres hosting on Monday. On Friday ask "has anything changed since Monday". It knows which day Monday was, what it told you, which page each number came from, and it goes back and re-reads those pages live before answering.

That's the whole product. One capability, done properly.

## What you need

- Node 22.13 or newer
- The Claude Code CLI installed, plus a Claude subscription
- An Exa API key

No runtime dependencies. `npm install` only pulls TypeScript, tsx, prettier and Node types.

## Run it

```bash
npm install
cp .env.example .env
```

Fill in `.env`. The two that matter:

- `CLAUDE_CODE_OAUTH_TOKEN`: generate it against an isolated config dir so MeowGle never touches your own Claude Code setup.
  ```bash
  cmd /c "set CLAUDE_CONFIG_DIR=C:\claude-agent-cfg&& claude setup-token"
  ```
  On macOS or Linux: `CLAUDE_CONFIG_DIR=~/claude-agent-cfg claude setup-token`.
- `EXA_API_KEY`: from exa.ai.

Then:

```bash
npm run dev
```

Open http://localhost:3000.

If you're exposing it beyond localhost, set `AGENT_API_TOKEN` first. Every `/api` route then needs it as a Bearer token, and the page asks for it once.

## Using it

Type a question. While it works you see what it's doing: what it searched, how many results came back and from where, which pages it's reading live. That trail folds into one line when the answer starts streaming.

The effort toggle (low, medium, high) controls how much it checks, not how much it talks:

| Effort | Tool calls | What it does |
| --- | --- | --- |
| low | 3 | one search round, opens the primary page if the answer is a number that moves |
| medium | 6 | searches every part of the question, reads the pages the answer rests on |
| high | 12 | searches wide, reads pages in full, cross-checks the figures |

Citations show up as small numbers in the reply and a sources row underneath.

Things worth trying:

- Ask about something with a price, then a few days later ask if it's still right.
- Ask "what did I ask you last Tuesday".
- Say hi. It says hi back. No search, no "how can I help you today".

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
src/server.ts    HTTP routes, SSE, auth gate, the MCP endpoint
src/agent.ts     runTurn(): one chat turn, start to finish
src/llm.ts       spawns `claude -p`, parses its stream, serves MCP
src/tools.ts     web_search and open_page against Exa
src/memory.ts    SQLite, the question ledger, the date strip, claim extraction
src/prompt.ts    the system prompt, effort settings, message building
public/index.html  the whole UI, no build step
```

## Known gaps

- The database starts empty, so the memory features need a few days of real use to show off. A seed script with backdated turns is next.
- Every turn spawns a fresh `claude -p` process. That startup cost is what I pay for running on a subscription instead of an API key.

How it's built and why: [DESIGN.md](DESIGN.md).
