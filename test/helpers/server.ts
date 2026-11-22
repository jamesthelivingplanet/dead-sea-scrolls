import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Config } from '../../src/config.js';
import { loadConfig } from '../../src/config.js';
import { Mutex } from '../../src/lock.js';
import { startServer, type RunningServer, type ServerOptions } from '../../src/server.js';
import { makeTempBundle } from './bundle.js';

export interface TestServer {
  root: string;
  url: string;
  port: number;
  server: RunningServer;
  client: Client;
  lock: Mutex;
  /** A further connected client with its own session. */
  connect(name: string): Promise<Client>;
  close(): Promise<void>;
}

export function testConfig(root: string): Config {
  return { ...loadConfig({ DSS_BUNDLE_DIR: root, DSS_CONFIG_DIR: `${root}/.cfg` }), host: '127.0.0.1', port: 0 };
}

export async function startTestServer(
  opts: { clientName?: string; serverOptions?: Partial<ServerOptions>; connectClient?: boolean } = {},
): Promise<TestServer> {
  const bundle = await makeTempBundle({ git: true });
  const lock = new Mutex();
  const server = await startServer({
    config: testConfig(bundle.root),
    root: bundle.root,
    lock,
    log: () => undefined,
    ...opts.serverOptions,
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const clients: Client[] = [];
  const connect = async (name: string) => {
    const c = new Client({ name, version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    clients.push(c);
    return c;
  };
  const client = opts.connectClient === false ? (undefined as unknown as Client) : await connect(opts.clientName ?? 'test-agent');
  return {
    root: bundle.root,
    url,
    port: server.port,
    server,
    client,
    lock,
    connect,
    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
      await server.close();
      await bundle.cleanup();
    },
  };
}
