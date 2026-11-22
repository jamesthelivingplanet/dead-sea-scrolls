import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { Mutex } from './lock.js';
import { registerTools } from './tools.js';

export interface ServerOptions {
  config: Config;
  root: string;
  lock: Mutex;
  /** Drop sessions idle longer than this. Default 30 minutes. */
  idleTimeoutMs?: number;
  /** How often to look for idle sessions. Default 60 seconds. */
  sweepIntervalMs?: number;
  /** Open session cap; the least recently used is evicted. Default 20. */
  maxSessions?: number;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
  sessionCount(): number;
}

interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  clientName: string | undefined;
  lastSeen: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

const SERVER_VERSION: string = (() => {
  try {
    const url = new URL('../package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientNameOf(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (isInitializeRequest(m)) {
      const name = m.params.clientInfo?.name;
      return typeof name === 'string' && name.trim() !== '' ? name.slice(0, 200) : undefined;
    }
  }
  return undefined;
}

function hasInitialize(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).some((m) => isInitializeRequest(m));
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { config, root, lock } = opts;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
  const sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
  const maxSessions = opts.maxSessions ?? 20;
  const log = opts.log ?? ((line: string) => console.log(line));
  const sessions = new Map<string, Session>();

  async function dropSession(s: Session, why: string): Promise<void> {
    if (sessions.get(s.id) !== s) return;
    sessions.delete(s.id);
    log(`session closed id=${s.id.slice(0, 8)} client=${JSON.stringify(s.clientName ?? null)} reason=${why} open=${sessions.size}`);
    try {
      await s.server.close(); // closes the transport too
    } catch {
      /* already closed */
    }
  }

  function evictIfNeeded(keep: Session): void {
    while (sessions.size > maxSessions) {
      let oldest: Session | undefined;
      for (const s of sessions.values()) {
        if (s !== keep && (!oldest || s.lastSeen < oldest.lastSeen)) oldest = s;
      }
      if (!oldest) return;
      void dropSession(oldest, 'evicted');
    }
  }

  function newSession(clientName: string | undefined): Session {
    const session = { clientName, lastSeen: Date.now() } as Session;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.set(id, session);
        log(`session opened id=${id.slice(0, 8)} client=${JSON.stringify(clientName ?? null)} open=${sessions.size}`);
        evictIfNeeded(session);
      },
    });
    const server = new McpServer(
      { name: 'dead-sea-scrolls', version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    registerTools(server, { root, lock, clientName: () => session.clientName });
    session.transport = transport;
    session.server = server;
    transport.onclose = () => {
      if (session.id) void dropSession(session, 'closed');
    };
    return session;
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? '';
    if (method === 'GET') {
      res.setHeader('Allow', 'POST, DELETE');
      rpcError(res, 405, -32000, 'Method not allowed: this server has no server-initiated stream. Use POST.', { Allow: 'POST, DELETE' });
      return;
    }
    if (method !== 'POST' && method !== 'DELETE') {
      rpcError(res, 405, -32000, 'Method not allowed.', { Allow: 'POST, DELETE' });
      return;
    }

    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;

    if (method === 'DELETE') {
      const s = sessionId ? sessions.get(sessionId) : undefined;
      if (!s) {
        rpcError(res, sessionId ? 404 : 400, -32001, sessionId ? 'Session not found' : 'Missing Mcp-Session-Id header');
        return;
      }
      await s.transport.handleRequest(req, res);
      await dropSession(s, 'deleted');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        rpcError(res, 413, -32600, 'Request body too large (limit 1 MB).', { Connection: 'close' });
        req.destroy();
        return;
      }
      rpcError(res, 400, -32700, 'Parse error: body is not valid JSON.');
      return;
    }

    let session: Session | undefined;
    if (sessionId) {
      session = sessions.get(sessionId);
      if (!session) {
        rpcError(res, 404, -32001, 'Session not found. Send a new initialize request.');
        return;
      }
    } else if (hasInitialize(parsed)) {
      session = newSession(clientNameOf(parsed));
      await session.server.connect(session.transport);
    } else {
      rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required (initialize first).');
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res, parsed);
    session.lastSeen = Date.now();
    // A rejected initialize never produces a session id; release it.
    if (!session.id) {
      void session.server.close().catch(() => undefined);
    }
  }

  const httpServer = http.createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
      return;
    }
    handleMcp(req, res).catch((e: unknown) => {
      console.error('Unhandled /mcp error:', e instanceof Error ? (e.stack ?? e.message) : e);
      rpcError(res, 500, -32603, 'Internal server error');
    });
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const s of [...sessions.values()]) {
      if (s.lastSeen < cutoff) void dropSession(s, 'idle');
    }
  }, sweepIntervalMs);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return {
    port: (httpServer.address() as AddressInfo).port,
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((s) => dropSession(s, 'shutdown')));
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}
