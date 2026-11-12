import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { runTurn } from './agent.js';
import { now } from './clock.js';
import { config } from './config.js';
import { getTurnsByConversation, openDb } from './db.js';
import { createGeminiLLM } from './llm/gemini.js';
import { createExaSearch } from './search/exa.js';

if (!config.geminiApiKey || !config.exaApiKey) {
  console.error(
    'Missing API keys. Set GEMINI_API_KEY and EXA_API_KEY in the environment or in .env (see .env.example).',
  );
  process.exit(1);
}

const db = openDb(config.dbPath);
const llm = createGeminiLLM(config.geminiApiKey, {
  fast: config.fastModel,
  main: config.mainModel,
});
const search = createExaSearch(config.exaApiKey);
const indexPath = join(process.cwd(), 'public', 'index.html');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      try {
        const html = await readFile(indexPath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('UI not available yet');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, now: now().toISOString() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const conversationId = url.searchParams.get('conversationId');
      if (!conversationId) {
        sendJson(res, 400, { error: 'conversationId is required' });
        return;
      }
      sendJson(res, 200, getTurnsByConversation(db, conversationId));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body: Record<string, unknown>;
      try {
        const parsed = await readBody(req);
        body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }

      const conversationId =
        typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const tz = typeof body.tz === 'string' && body.tz.trim() ? body.tz.trim() : 'UTC';
      const level =
        body.level === 'instant' || body.level === 'quick' ? body.level : ('auto' as const);

      if (!conversationId || !message) {
        sendJson(res, 400, { error: 'conversationId and message are required' });
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();

      const events = runTurn({ db, llm, search, now }, { conversationId, message, tz, level });
      try {
        for await (const event of events) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: text })}\n\n`);
      }
      res.end();
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal error' });
    } else {
      res.end();
    }
  }
});

server.listen(config.port, () => {
  console.log(`minimi listening on http://localhost:${config.port}`);
});