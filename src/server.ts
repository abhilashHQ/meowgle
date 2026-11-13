import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { openDb, listConversations, conversationTurns } from './memory.ts';
import { makeLLM } from './llm.ts';
import { makeExaTools } from './tools.ts';
import { runTurn } from './agent.ts';

try {
  process.loadEnvFile();
} catch {}

const env = (k: string, fallback = '') => process.env[k]?.trim() || fallback;
for (const k of ['LLM_API_KEY', 'EXA_API_KEY']) if (!env(k)) console.warn(`Missing ${k} in .env, requests will fail.`);

const db = openDb(env('DB_PATH', 'data/minimi.db'));
const llm = makeLLM({
  baseUrl: env('LLM_BASE_URL', 'https://bedrock-runtime.ap-south-1.amazonaws.com/openai/v1'),
  apiKey: env('LLM_API_KEY'),
  model: env('LLM_MODEL', 'openai.gpt-oss-120b-1:0'),
  effort: env('LLM_EFFORT', 'low'),
});
const tools = makeExaTools(env('EXA_API_KEY'));
const indexHtml = new URL('../public/index.html', import.meta.url);

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

async function chat(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON body' });
  }
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 8000) return json(res, 400, { error: 'message must be 1-8000 characters' });
  const conversationId = typeof body.conversationId === 'string' && /^[\w-]{1,64}$/.test(body.conversationId) ? body.conversationId : undefined;
  const effort = ['low', 'medium', 'high'].includes(body.effort) ? body.effort : undefined;

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let closed = false;
  res.on('close', () => (closed = true));
  for await (const event of runTurn({ db, llm, tools }, { conversationId, message, tz: body.tz, effort })) {
    if (closed) break;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, res);
    if (req.method === 'GET' && url.pathname === '/api/conversations') return json(res, 200, listConversations(db));
    const m = url.pathname.match(/^\/api\/conversations\/([\w-]{1,64})$/);
    if (req.method === 'GET' && m) return json(res, 200, conversationTurns(db, m[1]));
    if (req.method === 'GET' && url.pathname === '/') {
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(indexHtml));
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    else res.end();
  }
}).listen(Number(env('PORT', '3000')), () => console.log(`minimi on http://localhost:${env('PORT', '3000')}`));
