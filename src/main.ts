import { stat } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { startControl } from './control.js';
import { Mutex } from './lock.js';
import { startServer } from './server.js';
import { runSync, startSyncLoop } from './sync.js';

const log = (line: string) => console.log(line);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`Configuration error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  const root = config.bundleDir;
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    console.error(`Bundle directory '${root}' does not exist or is not a directory. Import the bundle first (mise run import) and check DSS_BUNDLE_DIR.`);
    process.exit(1);
  }

  const lock = new Mutex();
  const server = await startServer({ config, root, lock, log });
  const control = await startControl({
    config,
    root,
    lock,
    runSyncNow: () => runSync({ config, lock, log }),
    sessionCount: server.sessionCount,
  });
  const stopSync = startSyncLoop({ config, lock, log });
  log(`dead-sea-scrolls listening: mcp ${config.host}:${server.port}/mcp, control 127.0.0.1:${control.port}, bundle ${root}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal} received, shutting down`);
    stopSync();
    // Let an in-flight write or sync finish before closing the servers.
    await lock.runExclusive(async () => undefined).catch(() => undefined);
    await Promise.allSettled([server.close(), control.close()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  console.error('Fatal:', e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
