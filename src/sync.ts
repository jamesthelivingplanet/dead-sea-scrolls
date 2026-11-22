import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { regenerateIndexes } from './bundle/indexgen.js';
import type { Config } from './config.js';
import { changedSince, commitAll, git, SYSTEM_AUTHOR } from './git.js';
import type { Mutex } from './lock.js';
import { repairConcept } from './repair.js';
import { pruneEmptyDirs } from './ops/write.js';
import { Tx } from './tx.js';

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  outcome: 'ok' | 'skipped' | 'error' | 'resync-needed';
  reason?: string;
  pulled: boolean;
  committed: string | null;
  fixed: { id: string; commit: string; what: string }[];
  flagged: { id: string; problems: string[] }[];
  errors: string[];
}

export interface SyncState {
  resyncDone: boolean;
  resyncNeeded: boolean;
  lastResult: SyncResult | null;
}

export interface SyncDeps {
  config: Config;
  lock: Mutex;
  log: (line: string) => void;
  now?: () => Date;
}

const BISYNC_TIMEOUT_MS = 10 * 60 * 1000;
const FILTERS = ['- .git/**', '- .obsidian/**'];

export async function readSyncState(config: Config): Promise<SyncState> {
  try {
    const j = JSON.parse(await fs.readFile(config.syncStatePath, 'utf8')) as Partial<SyncState>;
    return {
      resyncDone: j.resyncDone === true,
      resyncNeeded: j.resyncNeeded === true,
      lastResult: j.lastResult ?? null,
    };
  } catch (e) {
    // Only a missing file means a fresh install; anything else must not trigger --resync.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { resyncDone: false, resyncNeeded: false, lastResult: null };
    throw new Error(`sync state file unreadable: ${(e as Error).message}`);
  }
}

async function hasBisyncListings(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((f) => f.endsWith('.lst'));
  } catch {
    return false;
  }
}

async function writeSyncState(config: Config, state: SyncState): Promise<void> {
  await fs.mkdir(path.dirname(config.syncStatePath), { recursive: true, mode: 0o700 });
  const tmp = `${config.syncStatePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, config.syncStatePath);
}

interface Exec {
  ok: boolean;
  code: number | string | null;
  output: string;
}

function exec(file: string, args: string[]): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: BISYNC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const output = `${stderr}\n${stdout}`.trim();
        if (!err) resolve({ ok: true, code: 0, output });
        else resolve({ ok: false, code: (err as NodeJS.ErrnoException).code ?? null, output: output || err.message });
      },
    );
  });
}

function tail(s: string, n = 600): string {
  const t = s.trim();
  return t.length > n ? '...' + t.slice(-n) : t;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Decides whether a failed `rclone bisync` genuinely needs a human-run --resync.
 * Never matches bare "resync": under --resilient rclone prints the harmless
 * "Error is retryable without --resync due to --resilient mode".
 * Genuine phrasings (rclone v1.75): "Bisync aborted. Must run --resync to recover.",
 * "Bisync interrupted. Must run --resync to recover.", "filters file has changed (must run --resync)",
 * "path1 and path2 are out of sync, run --resync to recover", and, because --resilient rewrites the
 * trailing line to "retryable", the lost-listings error "cannot find prior Path1 or Path2 listings"
 * (it never heals by retrying).
 */
export function classifyBisyncFailure(output: string): 'resync-needed' | 'error' {
  const t = output.replace(ANSI, '');
  return /must run --resync|run --resync to recover|cannot find prior Path1 or Path2 listings/i.test(t) ? 'resync-needed' : 'error';
}

/** Dirs (any, outside the bundle root) of the concept files the working tree changed, ignoring index.md/log.md and dot paths. */
async function dirtyConceptDirs(root: string): Promise<{ dirty: boolean; dirs: string[] }> {
  const out = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter((p) => p !== '');
  const dirs = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const xy = entry.slice(0, 2);
    const paths = [entry.slice(3)];
    if (xy.includes('R') || xy.includes('C')) paths.push(parts[++i]!);
    for (const p of paths) {
      const segs = p.split('/');
      const base = segs[segs.length - 1]!;
      if (segs.some((s) => s.startsWith('.')) || !base.endsWith('.md') || base === 'index.md' || base === 'log.md') continue;
      if (segs.length < 2) continue;
      dirs.add(segs.slice(0, -1).join('/'));
    }
  }
  return { dirty: parts.length > 0, dirs: [...dirs] };
}


function ids(list: string[], max = 20): string {
  if (list.length === 0) return '-';
  return list.slice(0, max).join(',') + (list.length > max ? `,...(+${list.length - max})` : '');
}

function logResult(r: SyncResult, log: (line: string) => void): void {
  log(
    `sync: outcome=${r.outcome} pulled=${r.pulled} committed=${r.committed ?? 'none'} fixed=${r.fixed.length} [${ids(r.fixed.map((f) => f.id))}] flagged=${r.flagged.length} [${ids(r.flagged.map((f) => f.id))}] errors=${r.errors.length}` +
      (r.errors.length > 0 ? ` (${r.errors.map((e) => tail(e, 200)).join(' | ')})` : ''),
  );
}

/** Runs one full sync cycle. Holds the write lock for the whole run. */
export function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { config, lock, log } = deps;
  const now = deps.now ?? (() => new Date());
  return lock.runExclusive(async () => {
    const result: SyncResult = {
      startedAt: now().toISOString(),
      finishedAt: '',
      outcome: 'ok',
      pulled: false,
      committed: null,
      fixed: [],
      flagged: [],
      errors: [],
    };
    const root = config.bundleDir;
    let state: SyncState;
    try {
      state = await readSyncState(config);
    } catch (e) {
      // Do not run bisync and do not overwrite the unreadable file.
      result.outcome = 'error';
      result.reason = (e as Error).message;
      result.errors.push(result.reason);
      result.finishedAt = now().toISOString();
      logResult(result, log);
      return result;
    }

    const finish = async (): Promise<SyncResult> => {
      result.finishedAt = now().toISOString();
      state.lastResult = result;
      try {
        await writeSyncState(config, state);
      } catch (e) {
        result.errors.push(`could not save sync state: ${(e as Error).message}`);
      }
      return result;
    };

    try {
      if (!(await fs.access(config.rcloneConfPath).then(() => true, () => false))) {
        result.outcome = 'skipped';
        result.reason = `no rclone config at ${config.rcloneConfPath}`;
        log(`sync: ${result.reason}`);
        return await finish();
      }
      if (state.resyncNeeded) {
        result.outcome = 'resync-needed';
        result.reason = 'rclone bisync needs a manual --resync (set resyncNeeded false and resyncDone false in the state file to run one)';
        log(`sync: RESYNC NEEDED, not syncing: ${result.reason}`);
        return await finish();
      }

      // 1. bisync
      await fs.mkdir(config.bisyncDir, { recursive: true, mode: 0o700 });
      const filtersFile = path.join(config.bisyncDir, 'filters.txt');
      await fs.writeFile(filtersFile, FILTERS.join('\n') + '\n');
      const args = [
        'bisync', root, config.remote,
        '--config', config.rcloneConfPath,
        '--workdir', config.bisyncDir,
        '--filters-file', filtersFile,
        // Transient failures (network blip, remote down, stale lock after a restart) must retry, not demand --resync.
        '--resilient', '--recover', '--max-lock', '2m',
      ];
      if (!state.resyncDone && (await hasBisyncListings(config.bisyncDir))) state.resyncDone = true;
      const first = !state.resyncDone;
      if (first) {
        args.push('--resync');
        // bisync refuses a missing remote folder; creating an existing one is a no-op.
        await exec(config.rclone, ['mkdir', config.remote, '--config', config.rcloneConfPath]);
      }
      const r = await exec(config.rclone, args);
      if (r.ok) {
        result.pulled = true;
        if (first) state.resyncDone = true;
      } else if (!first && classifyBisyncFailure(r.output) === 'resync-needed') {
        state.resyncNeeded = true;
        result.outcome = 'resync-needed';
        result.reason = `rclone bisync asked for --resync: ${tail(r.output, 300)}`;
        result.errors.push(result.reason);
        log(`sync: RESYNC NEEDED (bisync asked for --resync; not resyncing automatically): ${tail(r.output, 300)}`);
        return await finish();
      } else {
        result.outcome = 'error';
        result.reason = `rclone bisync failed (${String(r.code)}): ${tail(r.output)}`;
        result.errors.push(result.reason);
        return await finish();
      }

      // 2. commit what arrived
      const { dirty, dirs } = await dirtyConceptDirs(root);
      if (dirty) {
        // bisync removes files but leaves emptied directories behind: prune nested dirs that now
        // hold nothing but their generated index.md (never list roots, never concept files).
        for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
          if (d.includes('/')) await pruneEmptyDirs(root, d, new Tx(root)).catch(() => undefined);
        }
        // Pass removed dirs too: regenerateIndexes skips them but still redraws their parents.
        if (dirs.length > 0) await regenerateIndexes(root, dirs);
        result.committed = await commitAll(root, 'Sync edits from phone', SYSTEM_AUTHOR);
      }

      // 3. repair
      if (result.committed) {
        const changes = await changedSince(root, `${result.committed}~1`);
        const ids: string[] = [];
        for (const ch of changes) {
          if (!['A', 'M', 'R', 'C', 'T'].includes(ch.status)) continue;
          const segs = ch.path.split('/');
          const base = segs[segs.length - 1]!;
          if (segs.some((s) => s.startsWith('.')) || !base.endsWith('.md') || base === 'index.md' || base === 'log.md') continue;
          ids.push(ch.path.slice(0, -3));
        }
        for (const id of ids) {
          try {
            const rep = await repairConcept(root, id);
            if (rep.commit) result.fixed.push({ id: rep.newId, commit: rep.commit, what: rep.fixed.join(', ') });
            if (rep.problems.length > 0) result.flagged.push({ id: rep.newId, problems: rep.problems });
          } catch (e) {
            result.errors.push(`repair ${id}: ${(e as Error).message}`);
          }
        }
      }
      if (result.errors.length > 0) result.outcome = 'error';
      return await finish();
    } catch (e) {
      result.outcome = 'error';
      result.errors.push((e as Error).message);
      return await finish();
    } finally {
      if (result.finishedAt !== '') logResult(result, log);
    }
  });
}

/** First run ~10 s after start, then every interval; never overlapping. Returns a stop function. */
export function startSyncLoop(deps: Omit<SyncDeps, 'now'>, firstDelayMs = 10_000): () => void {
  const { config, log } = deps;
  if (config.syncIntervalSeconds === 0) return () => {};
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await runSync(deps);
      } catch (e) {
        log(`sync: run crashed: ${(e as Error).message}`);
      }
      schedule(config.syncIntervalSeconds * 1000);
    }, ms);
  };
  schedule(firstDelayMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
