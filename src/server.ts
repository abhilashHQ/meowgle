import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { runTurn, type AgentEvent } from './agent.js';
import { now } from './clock.js';
import { config } from './config.js';
import { getTurnsByConversation, openDb } from './db.js';
import { friendlyError } from './errors.js';
import type { Reasoning } from './llm/types.js';
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
const HEARTBEAT_MS = 15_000;

const REASONING_LEVELS = new Set<Reasoning>(['low', 'medium', 'high', 'xhigh']);

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
    let settled = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (settled) return;
      data += chunk;
      if (data.length > 1_000_000) {
        settled = true;
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
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
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function writeChunk(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

async function writeEvent(res: ServerResponse, event: AgentEvent): Promise<boolean> {
  return writeChunk(res, `data: ${JSON.stringify(event)}\n\n`);
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
      const requested = typeof body.reasoning === 'string' ? body.reasoning.trim() : '';
      const reasoning: Reasoning = REASONING_LEVELS.has(requested as Reasoning)
        ? (requested as Reasoning)
        : 'medium';
      const level =
        body.level === 'instant' || body.level === 'quick' ? body.level : undefined;

      if (!conversationId || !message) {
        sendJson(res, 400, { error: 'conversationId and message are required' });
        return;
      }

      req.socket.setNoDelay(true);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();
      await writeChunk(res, 'retry: 3000\n\n: connected\n\n');

      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      const heartbeat = setInterval(() => {
        void writeChunk(res, ': keepalive\n\n');
      }, HEARTBEAT_MS);

      try {
        const events = runTurn(
          { db, llm, search, now },
          { conversationId, message, tz, reasoning, level, signal: controller.signal },
        );
        for await (const event of events) {
          const ok = await writeEvent(res, event);
          if (!ok) {
            controller.abort();
            break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const text = friendlyError(error);
          await writeEvent(res, { type: 'error', message: text });
        }
      } finally {
        clearInterval(heartbeat);
        res.off('close', onClose);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal error' });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(config.port, () => {
  console.log(`minimi listening on http://localhost:${config.port}`);
});
