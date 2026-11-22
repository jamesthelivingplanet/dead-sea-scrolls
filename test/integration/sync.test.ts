import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { git } from '../../src/git.js';
import { Mutex } from '../../src/lock.js';
import { classifyBisyncFailure, readSyncState, runSync } from '../../src/sync.js';
import { makeTempBundle } from '../helpers/bundle.js';

let tmp: string;
let remoteDir: string;
let config: Config;
let cleanupBundle: () => Promise<void>;
const lock = new Mutex();
const lines: string[] = [];
const log = (l: string) => lines.push(l);
let clock = 0;

/** Write a file on the "phone" (remote) side with a distinct, future mtime so bisync sees it. */
async function phoneWrite(rel: string, text: string): Promise<void> {
  const p = path.join(remoteDir, 'dead-sea-scrolls', rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
  clock += 5;
  const t = new Date(Date.now() + clock * 1000);
  await fs.utimes(p, t, t);
}

beforeAll(async () => {
  const b = await makeTempBundle({ git: true });
  cleanupBundle = b.cleanup;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-sync-'));
  remoteDir = path.join(tmp, 'remote');
  await fs.mkdir(remoteDir);
  const configDir = path.join(tmp, 'config');
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, 'rclone.conf'), `[remote]\ntype = alias\nremote = ${remoteDir}\n`);
  config = {
    bundleDir: b.root,
    configDir,
    port: 0,
    host: '127.0.0.1',
    controlPort: 0,
    syncIntervalSeconds: 0,
    remote: 'remote:dead-sea-scrolls',
    rclone: 'rclone',
    rcloneConfPath: path.join(configDir, 'rclone.conf'),
    bisyncDir: path.join(configDir, 'bisync'),
    syncStatePath: path.join(configDir, 'sync-state.json'),
  };
});

afterAll(async () => {
  await cleanupBundle?.();
  await fs.rm(tmp, { recursive: true, force: true });
});

const bundleRead = (rel: string) => fs.readFile(path.join(config.bundleDir, rel), 'utf8');
const remoteRead = (rel: string) => fs.readFile(path.join(remoteDir, 'dead-sea-scrolls', rel), 'utf8');
const subjects = async () => (await git(config.bundleDir, ['log', '--format=%s'])).trim().split('\n');

describe('runSync against a local rclone remote', () => {
  it('skips quickly without an rclone config', async () => {
    const noConf = {
      ...config,
      rcloneConfPath: path.join(tmp, 'missing.conf'),
      syncStatePath: path.join(tmp, 'skip-state.json'),
    };
    const t0 = Date.now();
    const r = await runSync({ config: noConf, lock, log });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toBe(`no rclone config at ${noConf.rcloneConfPath}`);
    expect((await readSyncState(noConf)).lastResult?.outcome).toBe('skipped');
  });

  it('first run resyncs and pushes the bundle to the remote', async () => {
    const r = await runSync({ config, lock, log });
    expect(r.errors).toEqual([]);
    expect(r.outcome).toBe('ok');
    expect(r.pulled).toBe(true);
    expect(r.committed).toBeNull();
    const state = await readSyncState(config);
    expect(state.resyncDone).toBe(true);
    expect(state.resyncNeeded).toBe(false);
    expect((await fs.stat(config.syncStatePath)).mode & 0o777).toBe(0o600);
    expect(await remoteRead('anime/86-eighty-six.md')).toBe(await bundleRead('anime/86-eighty-six.md'));
    await expect(fs.access(path.join(remoteDir, 'dead-sea-scrolls', '.git'))).rejects.toThrow();
  });

  it('commits a phone edit', async () => {
    const text = (await remoteRead('anime/86-eighty-six.md')) + '\nEdited on the phone.\n';
    await phoneWrite('anime/86-eighty-six.md', text);
    const r = await runSync({ config, lock, log });
    expect(r.errors).toEqual([]);
    expect(r.committed).toMatch(/^[0-9a-f]{40}$/);
    expect(await bundleRead('anime/86-eighty-six.md')).toBe(text);
    expect((await subjects())[0]).toBe('Sync edits from phone');
    expect(await git(config.bundleDir, ['status', '--porcelain'])).toBe('');
  });

  it('commits a note written on the phone and regenerates notes/index.md', async () => {
    await phoneWrite('notes/idea.md', '---\ntype: Note\ntitle: Phone Idea\nstatus: draft\n---\n\nHi\n');
    const r = await runSync({ config, lock, log });
    expect(r.errors).toEqual([]);
    expect(r.committed).toMatch(/^[0-9a-f]{40}$/);
    expect(r.flagged).toEqual([]);
    expect(await bundleRead('notes/index.md')).toContain('[Phone Idea](idea.md)');
    expect(await git(config.bundleDir, ['status', '--porcelain'])).toBe('');
  });

  it('fixes a casual status and pushes the fix back on the next run', async () => {
    const orig = await remoteRead('anime/86-eighty-six.md');
    const edited = orig.replace(/^list_status: .*$/m, 'list_status: Watching');
    expect(edited).not.toBe(orig);
    await phoneWrite('anime/86-eighty-six.md', edited);
    const r = await runSync({ config, lock, log });
    expect(r.errors).toEqual([]);
    expect(r.fixed).toHaveLength(1);
    expect(r.fixed[0]!.id).toBe('anime/86-eighty-six');
    expect(await bundleRead('anime/86-eighty-six.md')).toMatch(/^list_status: in-progress$/m);
    const subs = await subjects();
    expect(subs[0]).toBe("Fix 86 (Eighty-Six): list_status 'Watching' -> 'in-progress'");
    expect(subs[1]).toBe('Sync edits from phone');
    expect(await remoteRead('anime/86-eighty-six.md')).toMatch(/^list_status: Watching$/m);

    const r2 = await runSync({ config, lock, log });
    expect(r2.errors).toEqual([]);
    expect(await remoteRead('anime/86-eighty-six.md')).toMatch(/^list_status: in-progress$/m);
    expect(r2.committed).toBeNull();
  });

  it('commits but flags and never touches an unparseable file', async () => {
    const broken = '---\ntitle: [unclosed\n---\n';
    await phoneWrite('anime/broken.md', broken);
    const r = await runSync({ config, lock, log });
    expect(r.errors).toEqual([]);
    expect(r.committed).toMatch(/^[0-9a-f]{40}$/);
    const flag = r.flagged.find((f) => f.id === 'anime/broken');
    expect(flag).toBeDefined();
    expect(flag!.problems.join(' ')).toContain('does not parse');
    expect(r.fixed.find((f) => f.id === 'anime/broken')).toBeUndefined();
    expect(await bundleRead('anime/broken.md')).toBe(broken);
    await runSync({ config, lock, log });
    expect(await remoteRead('anime/broken.md')).toBe(broken);
    expect(await bundleRead('anime/broken.md')).toBe(broken);
  });

  it('a phone folder named index.md does not block sync, and a casual status beside it is fixed', async () => {
    const fm = '---\ntype: Anime\ntitle: Phone Other\nlist_status: watching\n---\n';
    await phoneWrite('anime/odd/index.md/a.md', '---\ntype: Anime\ntitle: A\nlist_status: to-watch\n---\n');
    await phoneWrite('anime/phone-other.md', fm);
    const r = await runSync({ config, lock, log });
    expect(r.errors).toEqual([]);
    expect(r.committed).toMatch(/^[0-9a-f]{40}$/);
    expect(r.fixed.map((f) => f.id)).toContain('anime/phone-other');
    expect(await bundleRead('anime/phone-other.md')).toMatch(/^list_status: in-progress$/m);
    expect(await git(config.bundleDir, ['status', '--porcelain'])).toBe('');
  });

  it('redraws the parent index when the phone deletes a whole nested folder', async () => {
    await phoneWrite('anime/gundam/zeta.md', '---\ntype: Anime\ntitle: Zeta\nlist_status: to-watch\n---\n');
    await runSync({ config, lock, log });
    expect(await bundleRead('anime/index.md')).toContain('* [gundam](gundam/) - 1 title');
    await fs.rm(path.join(remoteDir, 'dead-sea-scrolls', 'anime', 'gundam'), { recursive: true });
    const r = await runSync({ config, lock, log });
    expect(r.errors).toEqual([]);
    expect(await bundleRead('anime/index.md')).not.toContain('gundam');
    expect(await fs.readdir(path.join(config.bundleDir, 'anime'))).not.toContain('gundam');
    expect(await git(config.bundleDir, ['status', '--porcelain'])).toBe('');
  });

  it('treats a transient remote failure as an error, then recovers on the next run', async () => {
    const text = (await remoteRead('anime/86-eighty-six.md')) + '\nTransient test.\n';
    await phoneWrite('anime/86-eighty-six.md', text);
    const remoteRoot = path.join(remoteDir, 'dead-sea-scrolls');
    await fs.chmod(remoteRoot, 0o000);
    try {
      const r = await runSync({ config, lock, log });
      expect(r.outcome).toBe('error');
      expect(r.reason).toContain('rclone bisync failed');
      const state = await readSyncState(config);
      expect(state.resyncNeeded).toBe(false);
      expect(state.resyncDone).toBe(true);
    } finally {
      await fs.chmod(remoteRoot, 0o755);
    }
    const r2 = await runSync({ config, lock, log });
    expect(r2.errors).toEqual([]);
    expect(r2.outcome).toBe('ok');
    expect(await bundleRead('anime/86-eighty-six.md')).toBe(text);
  });

  it('demands a resync when bisync listings are lost, then skips without running bisync', async () => {
    const lst = (await fs.readdir(config.bisyncDir)).filter((f) => f.includes('.lst'));
    expect(lst.length).toBeGreaterThan(0);
    for (const f of lst) await fs.rm(path.join(config.bisyncDir, f));
    const r = await runSync({ config, lock, log });
    expect(r.outcome).toBe('resync-needed');
    expect((await readSyncState(config)).resyncNeeded).toBe(true);

    // A following run must skip: a nonexistent rclone binary would make bisync fail with 'error' if it were called.
    const r2 = await runSync({ config: { ...config, rclone: '/nonexistent/rclone' }, lock, log });
    expect(r2.outcome).toBe('resync-needed');
    expect(r2.reason).toContain('manual --resync');
  });
});

describe('sync state handling', () => {
  it('does not resync or overwrite a corrupt state file', async () => {
    const c = { ...config, rclone: '/nonexistent/rclone', syncStatePath: path.join(tmp, 'corrupt-state.json') };
    await fs.writeFile(c.syncStatePath, '{not json');
    const r = await runSync({ config: c, lock, log });
    expect(r.outcome).toBe('error');
    expect(r.reason).toContain('sync state file unreadable');
    expect(r.errors).toHaveLength(1);
    expect(await fs.readFile(c.syncStatePath, 'utf8')).toBe('{not json');
  });

  it('treats a missing state file as a fresh install', async () => {
    const s = await readSyncState({ ...config, syncStatePath: path.join(tmp, 'nope.json') });
    expect(s).toEqual({ resyncDone: false, resyncNeeded: false, lastResult: null });
  });

  it('never adds --resync when bisync listings already exist', async () => {
    const bisyncDir = path.join(tmp, 'bisync-with-lst');
    await fs.mkdir(bisyncDir);
    await fs.writeFile(path.join(bisyncDir, 'a..b.path1.lst'), '');
    const argsFile = path.join(tmp, 'args.txt');
    const fake = path.join(tmp, 'fake-rclone.sh');
    await fs.writeFile(fake, `#!/bin/sh\necho "$@" >> ${argsFile}\nexit 0\n`, { mode: 0o755 });
    const c = { ...config, rclone: fake, bisyncDir, syncStatePath: path.join(tmp, 'lst-state.json') };
    const r = await runSync({ config: c, lock, log });
    expect(r.outcome).toBe('ok');
    const args = await fs.readFile(argsFile, 'utf8');
    expect(args).toContain('bisync');
    expect(args).not.toContain('--resync');
    expect((await readSyncState(c)).resyncDone).toBe(true);
  });
});

describe('classifyBisyncFailure', () => {
  it('flags genuine resync demands', () => {
    expect(classifyBisyncFailure('ERROR : Bisync aborted. Must run --resync to recover.')).toBe('resync-needed');
    expect(classifyBisyncFailure('Bisync interrupted. Must run --resync to recover.')).toBe('resync-needed');
    expect(classifyBisyncFailure('filters file has changed (must run --resync): x')).toBe('resync-needed');
    expect(classifyBisyncFailure('path1 and path2 are out of sync, run --resync to recover')).toBe('resync-needed');
    expect(
      classifyBisyncFailure(
        'Bisync critical error: cannot find prior Path1 or Path2 listings, likely due to critical error on prior run \nBisync aborted. Error is retryable without --resync due to --resilient mode.',
      ),
    ).toBe('resync-needed');
  });
  it('treats retryable errors as plain errors', () => {
    expect(
      classifyBisyncFailure(
        'ERROR : There were errors while building listings. Aborting as it is too dangerous to continue.\nERROR : Bisync aborted. Error is retryable without --resync due to --resilient mode.',
      ),
    ).toBe('error');
    expect(classifyBisyncFailure("Failed to bisync: couldn't connect")).toBe('error');
  });
});
