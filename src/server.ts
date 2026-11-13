import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { openDb, listConversations, conversationTurns } from './memory.ts';
import { handleMcp, makeClaude } from './llm.ts';
import { makeExaTools } from './tools.ts';
import { runTurn } from './agent.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

try {
  process.loadEnvFile();
} catch {}

const env = (k: string, fallback = '') => process.env[k]?.trim() || fallback;
for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'EXA_API_KEY']) {
  if (!env(k)) console.warn(`Missing ${k} in .env, requests will fail.`);
}
if (!env('AGENT_API_TOKEN')) {
  console.warn('AGENT_API_TOKEN is not set: /api is open to anyone who can reach this server.');
}

// The CLI binary, spawned without a shell. On Windows the npm install puts a
// .cmd shim on PATH that wraps a native claude.exe; we run the exe directly.
function claudeBin(): string {
  if (env('CLAUDE_BIN')) return env('CLAUDE_BIN');
  const win = process.platform === 'win32';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const direct = join(dir, win ? 'claude.exe' : 'claude');
    if (existsSync(direct)) return direct;
    const shimmed = join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    if (win && existsSync(join(dir, 'claude.cmd')) && existsSync(shimmed)) return shimmed;
  }
  throw new Error('claude CLI not found on PATH. Install it or set CLAUDE_BIN.');
}

const port = Number(env('PORT', '3000'));
const db = openDb(env('DB_PATH', 'data/minimi.db'));
const model = makeClaude({
  bin: claudeBin(),
  model: env('CLAUDE_MODEL', 'sonnet'),
  effort: env('CLAUDE_EFFORT', 'low'),
  configDir: env('CLAUDE_CONFIG_DIR'),
  token: env('CLAUDE_CODE_OAUTH_TOKEN'),
  mcpBase: `http://127.0.0.1:${port}`,
});
const tools = makeExaTools(env('EXA_API_KEY'));
const indexHtml = new URL('../public/index.html', import.meta.url);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error('Body too large');
  }
  return JSON.parse(raw);
}

// POST /api/chat: validates the request, then streams AgentEvents as SSE
// frames. If the client hangs up mid-stream, the loop just stops.
async function chat(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON body' });
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 8000) {
    return json(res, 400, { error: 'message must be 1-8000 characters' });
  }

  const conversationId =
    typeof body.conversationId === 'string' && /^[\w-]{1,64}$/.test(body.conversationId)
      ? body.conversationId
      : undefined;
  const effort = ['low', 'medium', 'high'].includes(body.effort) ? body.effort : undefined;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let closed = false;
  res.on('close', () => (closed = true));

  for await (const event of runTurn(
    { db, model, tools },
    { conversationId, message, tz: body.tz, effort }
  )) {
    if (closed) break;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

// With AGENT_API_TOKEN set, every /api route needs it as a Bearer token. The
// page itself stays public so it can ask for the token.
const digest = (s: string) => createHash('sha256').update(s).digest();
const apiToken = env('AGENT_API_TOKEN');

function authorized(req: IncomingMessage): boolean {
  if (!apiToken) return true;
  const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  return timingSafeEqual(digest(given), digest(apiToken));
}

// ---------------------------------------------------------------------------
// Routing
//
//   POST /mcp/:runId             -> MCP endpoint for an in-flight model run
//   POST /api/chat               -> chat, SSE stream
//   GET  /api/conversations      -> conversation list
//   GET  /api/conversations/:id  -> turns of one conversation
//   GET  /                       -> the single-page app
// ---------------------------------------------------------------------------
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const mcp = url.pathname.match(/^\/mcp\/([\w-]{36})$/);
    if (mcp) return await handleMcp(req, res, mcp[1]);
    if (url.pathname.startsWith('/api/') && !authorized(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      return await chat(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      return json(res, 200, listConversations(db));
    }
    const match = url.pathname.match(/^\/api\/conversations\/([\w-]{1,64})$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, conversationTurns(db, match[1]));
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(await readFile(indexHtml));
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    else res.end();
  }
}).listen(port, () => console.log(`minimi on http://localhost:${port}`));
