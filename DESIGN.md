# Design

## How it works

One turn starts with code, then a bounded model loop. On each message the server inserts the user turn, resolves date phrases with `resolveDates` (code, no model), recalls matching turns and claims from SQLite (code, no model), and asks the fast model for a plan: instant or quick, one to five standalone search queries, an objective, and which old claims the user wants re-checked. The reasoning level sets the budget: low is 2 queries and 1 round, medium is 3 and 1, high is 4 and 2, xhigh is 5 and 3. If the plan asks for search, queries run in parallel through Exa with a 15 second timeout, retries only for 429 and 5xx, URL dedupe, a per-domain cap, and results interleaved by rank so no query gets crowded out. Published dates go to the model instead of driving the ranking, because vendor pricing pages often have no date and a pure recency sort pushes them below blog posts. High and xhigh then run a coverage review and add follow-up queries when the review finds gaps. The main model streams (instant turns use the fast model) an answer with `[S#]` markers, and thought parts stream while it thinks. Once the stream ends, code checks every marker against the sources fetched this turn, saves the assistant turn with its trace, and extracts atomic claims with the fast model after the response is already sent. xhigh uses the same high thinking level as high and buys its extra depth from more search rounds, not from a hidden model switch.

## Why

Memory questions are date arithmetic and lookup. "What did I ask on 3 November" on a fresh install has one correct answer: there is no record. Making that a model guess invites a hallucinated turn. Code resolves the date, code queries SQLite, and the prompt tells the model what exists.

Storing answers as dated claims with a source URL and fetch date makes "is this still correct?" checkable per claim. A claim is a single sentence plus where it came from and when it was fetched, so a later re-check can compare against a fresh source instead of rereading a whole conversation.

Latency comes from structure. The fast planner is small, search starts as soon as the plan exists, and the main model starts streaming as soon as sources exist. Instant level skips search for greetings and pure memory questions. A failed search with no sources returns a short offer to retry instead of a guess; a partial search failure still answers from the sources that did arrive with a notice. Every model call has a timeout, and if the main model errors before its first thought or token, the answer falls back to the fast model with thinking off instead of failing the turn.

Citations are verified in code, not trusted from the model. Anything outside the source set is marked invalid. Page text is treated as untrusted data, and the prompt says to ignore instructions found inside sources. There is exactly one tool, and recall is not it. Recall runs before the model so every answer sees the same deterministic memory.

## Live trace

The server emits SSE frames for activity start and done, thought chunks, sources, answer tokens, trace data, and the final done event. Recall and plan emit their traces as soon as they finish, the source event arrives before the answer, and thought parts stream while the model is still thinking. The client builds the timeline incrementally and keeps the raw activities in the saved trace so history can rebuild the same timeline later. Heartbeats keep the connection open through slow searches. If the client disconnects, the abort signal stops the model stream and the search.

## Failure behavior

There are three independent fallbacks. If the planner fails, the agent searches the raw message and says so in the activity detail. If the coverage review fails, the current sources are kept and the turn continues. If the main model fails before producing answer text, the fast model finishes the turn with thinking off. A search timeout is not retried, because retrying a 15 second timeout mostly doubles the wait; 429 and 5xx responses are retried once with backoff. When search returns no sources at all, the assistant asks whether to retry instead of answering from stale memory.

## Considered and rejected

Agent frameworks. They hide the control flow, add a dependency, and make the pipeline harder to explain than the code it replaces.

Vector DB and embeddings. One user with a small history does not need approximate recall. Date plus keyword lookup is exact, inspectable, and answers the questions the app is for.

Letting the model call search in a free loop. It reads flexibly, but each extra round adds a model decision and a network wait. The reasoning level sets a fixed round and query budget, and the review decides only whether another round is worth it. That keeps time to first token predictable and the trace explainable.

better-sqlite3. It is faster, but native builds break `npm install` on machines without a compiler. `node:sqlite` ships with Node and removes that failure mode.

Login and multi-user. There is one owner of one history. Auth would add sessions, user scoping, and migration work without changing the core question this version answers.

## Another week

An eval harness built from the example prompts plus trap questions. Each case measures whether the answer is correct, whether it invents memory, and time to first token. Traps include "what did I ask on 3 Nov" on an empty database and claims that changed after they were saved.

Embedding recall as a fallback when keyword search misses. Keyword recall is exact but brittle to paraphrases, so embeddings would be a second pass, not the primary path.

Vendor-source ranking. Prefer official pricing pages over blog summaries when both match a query.

Per-claim freshness TTL. Claims about pricing could expire faster than claims about an API shape, and a TTL would let the planner decide what to re-check without asking.

A second model provider behind the LLM interface. Gemini quota and demand spikes are the current failure mode, so a provider fallback would keep the turn alive when one API is unavailable.
