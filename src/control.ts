import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { scanBundle } from './bundle/scan.js';
import type { Config } from './config.js';
import type { Mutex } from './lock.js';
import { readSyncState } from './sync.js';

export interface ControlOptions {
  config: Config;
  root: string;
  lock: Mutex;
  runSyncNow: () => Promise<unknown>;
  sessionCount?: () => number;
}

export interface RunningControl {
  port: number;
  close(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export async function startControl(opts: ControlOptions): Promise<RunningControl> {
  const { config, root } = opts;
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    const run = async () => {
      if (pathname === '/sync' && req.method === 'POST') {
        send(res, 200, await opts.runSyncNow());
      } else if (pathname === '/status' && req.method === 'GET') {
        const state = await readSyncState(config);
        let flaggedCount: number | null = 0;
        let scanError: string | undefined;
        try {
          const snapshot = await scanBundle(root);
          for (const c of snapshot.concepts.values()) if (c.problems.length > 0) flaggedCount++;
        } catch (e) {
          flaggedCount = null;
          scanError = e instanceof Error ? e.message : String(e);
        }
        send(res, 200, {
          resyncDone: state.resyncDone,
          resyncNeeded: state.resyncNeeded,
          lastSync: state.lastResult,
          flaggedCount,
          ...(scanError !== undefined ? { scanError } : {}),
          sessions: opts.sessionCount?.() ?? 0,
        });
      } else if (pathname === '/sync' || pathname === '/status') {
        send(res, 405, { error: 'Method not allowed' });
      } else {
        send(res, 404, { error: 'Not found. Use POST /sync or GET /status.' });
      }
    };
    run().catch((e: unknown) => {
      console.error('Control error:', e instanceof Error ? (e.stack ?? e.message) : e);
      if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.controlPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
