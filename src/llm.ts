// Low-level types shared with the agent loop and the OpenAI-compatible API.
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  extra_content?: unknown;
};

export type Message =
  | { role: 'system' | 'developer' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type Chunk =
  { kind: 'reasoning' | 'content'; text: string } | { kind: 'tools'; calls: ToolCall[] };

export type LLM = {
  stream(body: Record<string, unknown>): AsyncIterable<Chunk>;
  complete(body: Record<string, unknown>): Promise<any>;
};

// ---------------------------------------------------------------------------
// <reasoning> tag splitting
//
// gpt-oss wraps its chain of thought in <reasoning> tags. Text arrives in
// arbitrary chunks, so a tag can be split across chunks ("</rea" + "soning>").
// The splitter buffers everything, streams out text that cannot be part of a
// tag yet, and labels each piece reasoning or content depending on whether we
// are inside the tags.
// ---------------------------------------------------------------------------
export function reasoningSplitter() {
  let buf = '';
  let inside = false;
  const tagFor = () => (inside ? '</reasoning>' : '<reasoning>');

  function push(text: string): Chunk[] {
    const out: Chunk[] = [];
    const emit = (t: string) => t && out.push({ kind: inside ? 'reasoning' : 'content', text: t });
    buf += text;

    for (;;) {
      // found a tag boundary: emit everything before it and flip sides
      const tag = tagFor();
      const i = buf.indexOf(tag);
      if (i >= 0) {
        emit(buf.slice(0, i));
        buf = buf.slice(i + tag.length);
        inside = !inside;
        continue;
      }

      // no tag here: emit up to the longest suffix that could still grow into
      // one, and keep that suffix buffered
      let keep = Math.min(buf.length, tag.length - 1);
      while (keep > 0 && !tag.startsWith(buf.slice(-keep))) keep--;
      emit(buf.slice(0, buf.length - keep));
      buf = buf.slice(buf.length - keep);
      return out;
    }
  }

  function flush(): Chunk[] {
    // end of stream: no tag can arrive anymore, so empty the buffer
    const out: Chunk[] = buf ? [{ kind: inside ? 'reasoning' : 'content', text: buf }] : [];
    buf = '';
    return out;
  }

  return { push, flush };
}

// Splits an OpenAI-style SSE body into its `data:` payload strings.
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buf = '';
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    buf += text;
    const lines = buf.split('\n');
    buf = lines.pop()!; // hold the last, possibly partial line back
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield data;
    }
  }
}

// Streamed tool calls arrive as deltas that may lack index, id or name. This
// finds which already-started call a delta belongs to, or opens a new slot.
function callSlot(calls: ToolCall[], tc: { index?: number; id?: string }): number {
  if (tc.index !== undefined) return tc.index;
  if (!tc.id) return Math.max(calls.length - 1, 0); // same as the last one
  const i = calls.findIndex((c) => c?.id === tc.id);
  return i >= 0 ? i : calls.length; // unknown id: open a new slot
}

// Turns the raw SSE stream into logical chunks: reasoning, content and
// complete tool calls.
export async function* parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const split = reasoningSplitter();
  const calls: ToolCall[] = [];

  for await (const data of sseData(body)) {
    const delta = JSON.parse(data).choices?.[0]?.delta;
    if (!delta) continue;

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) yield { kind: 'reasoning', text: reasoning };
    if (delta.content) yield* split.push(delta.content); // content may hold <reasoning> tags

    // tool call deltas: append name and argument pieces into their slot
    for (const tc of delta.tool_calls ?? []) {
      const slot = callSlot(calls, tc);
      const c = (calls[slot] ??= {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
      if (tc.id) c.id = tc.id;
      if (tc.extra_content) c.extra_content = tc.extra_content;
      if (tc.function?.name) c.function.name += tc.function.name;
      if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
    }
  }

  yield* split.flush();
  if (calls.length) yield { kind: 'tools', calls: calls.filter(Boolean) };
}

// ---------------------------------------------------------------------------
// The LLM client: POST to an OpenAI-compatible endpoint, one retry on 429/5xx.
// ---------------------------------------------------------------------------
export function makeLLM(cfg: {
  baseUrl: string;
  apiKey: string;
  model: string;
  effort: string;
}): LLM {
  async function post(body: Record<string, unknown>): Promise<Response> {
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, reasoning_effort: cfg.effort, ...body }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      if (attempt === 0 && retryable) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  return {
    async *stream(body) {
      const res = await post({ ...body, stream: true });
      yield* parseStream(res.body!);
    },
    async complete(body) {
      return (await post({ ...body, stream: false })).json();
    },
  };
}
