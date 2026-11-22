import path from 'node:path';

export interface Config {
  bundleDir: string;
  configDir: string;
  port: number;
  host: string;
  controlPort: number;
  syncIntervalSeconds: number;
  remote: string;
  rclone: string;
  /** <configDir>/rclone.conf */
  rcloneConfPath: string;
  /** <configDir>/bisync (rclone workdir) */
  bisyncDir: string;
  /** <configDir>/sync-state.json */
  syncStatePath: string;
}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = 65535): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got '${raw}'`);
  }
  return n;
}

function strVar(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${name} is required (no default: it must point at the data you mean to serve)`);
  }
  return raw.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bundleDir = required(env, 'DSS_BUNDLE_DIR');
  const configDir = required(env, 'DSS_CONFIG_DIR');
  return {
    bundleDir,
    configDir,
    port: intVar(env, 'DSS_PORT', 32473, 0),
    host: strVar(env, 'DSS_HOST', '0.0.0.0'),
    controlPort: intVar(env, 'DSS_CONTROL_PORT', 32474, 0),
    syncIntervalSeconds: intVar(env, 'DSS_SYNC_INTERVAL_SECONDS', 300, 0, 31_536_000),
    remote: strVar(env, 'DSS_REMOTE', 'remote:dead-sea-scrolls'),
    rclone: strVar(env, 'DSS_RCLONE', 'rclone'),
    rcloneConfPath: path.join(configDir, 'rclone.conf'),
    bisyncDir: path.join(configDir, 'bisync'),
    syncStatePath: path.join(configDir, 'sync-state.json'),
  };
}
