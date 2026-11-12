# Design

## How it works

One turn is a fixed pipeline, not a loop. On each message the server inserts the user turn, resolves date phrases with `resolveDates` (code, no model), recalls matching turns and claims from SQLite (code, no model), and asks the fast model for a plan: level, one to four standalone search queries, and which old claims the user wants re-checked. If the plan asks for search, queries run in parallel through Exa with an 8 second timeout, one retry, URL dedupe, one result per domain, and results interleaved by rank across queries so no query gets crowded out. Published dates go to the model instead of driving the ranking, because vendor pricing pages often have no date and a pure recency sort pushes them below blog posts. The main model then streams (instant turns use the fast model) an answer with `[S#]` markers. Once the stream ends, code checks every marker against the sources fetched this turn, saves the assistant turn with its trace, and extracts atomic claims with the fast model after the response is already sent.

## Why

Memory questions are date arithmetic and lookup. "What did I ask on 3 November" on a fresh install has one correct answer: there is no record. Making that a model guess invites a hallucinated turn. Code resolves the date, code queries SQLite, and the prompt tells the model what exists.

Storing answers as dated claims with a source URL and fetch date makes "is this still correct?" checkable per claim. A claim is a single sentence plus where it came from and when it was fetched, so a later re-check can compare against a fresh source instead of rereading a whole conversation.

Latency comes from structure. The fast planner is small, search is one round, and the main model starts streaming as soon as sources exist. Instant level skips search entirely for greetings and pure memory questions. If search fails, the agent says so in the answer and continues from memory. Every model call has a timeout, and if the main model errors before its first token (Gemini returns 503 under load) the answer falls back to the fast model instead of failing the turn.

Citations are verified in code, not trusted from the model. Anything outside the source set is marked invalid. Page text is treated as untrusted data, and the prompt says to ignore instructions found inside sources. There is exactly one tool, and recall is not it. Recall runs before the model so every answer sees the same deterministic memory.

## Considered and rejected

Agent frameworks. They hide the control flow, add a dependency, and make the pipeline harder to explain than the code it replaces.

Vector DB and embeddings. One user with a small history does not need approximate recall. Date plus keyword lookup is exact, inspectable, and answers the questions the app is for.

Letting the model call search in a free loop. It reads flexibly, but each extra round adds a model decision and a network wait. A fixed plan gives predictable time to first token and an explainable trace.

better-sqlite3. It is faster, but native builds break `npm install` on machines without a compiler. `node:sqlite` ships with Node and removes that failure mode.

Login and multi-user. There is one owner of one history. Auth would add sessions, user scoping, and migration work without changing the core question this version answers.

## Another week

A deep level: split the question into sub-questions, run a second search round when the first leaves gaps, and use a stronger model for synthesis.

An eval harness built from the three example prompts plus trap questions. Each case measures whether the answer is correct, whether it invents memory, and time to first token. Traps include "what did I ask on 3 Nov" on an empty database and claims that changed after they were saved.

Embedding recall as a fallback when keyword search misses. Keyword recall is exact but brittle to paraphrases, so embeddings would be a second pass, not the primary path.

Vendor-source ranking. Prefer official pricing pages over blog summaries when both match a query.

Full page text for re-checks. Exa highlights are fast, but they often miss the exact number a stored claim makes, so re-checks honestly end in "can't verify" more than they should. Re-checks would fetch capped full text from the vendor page instead.

Per-claim freshness TTL. Claims about pricing could expire faster than claims about an API shape, and a TTL would let the planner decide what to re-check without asking.
