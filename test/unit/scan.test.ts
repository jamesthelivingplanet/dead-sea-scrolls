import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanBundle } from '../../src/bundle/scan.js';
import { makeTempBundle } from '../helpers/bundle.js';

describe('scanBundle on the migrated bundle', () => {
  let b: Awaited<ReturnType<typeof makeTempBundle>>;
  beforeAll(async () => { b = await makeTempBundle(); });
  afterAll(async () => { await b.cleanup(); });

  it('finds 96 concepts with no problems', async () => {
    const snap = await scanBundle(b.root);
    expect(snap.concepts.size).toBe(96);
    const counts: Record<string, number> = {};
    for (const c of snap.concepts.values()) {
      counts[c.list!] = (counts[c.list!] ?? 0) + 1;
      expect(c.problems, c.id).toEqual([]);
      expect(c.frontmatterState).toBe('ok');
    }
    expect(counts).toEqual({ anime: 39, 'western-animation': 9, movies: 8, series: 3, books: 35, games: 2 });
    expect(snap.dirs).toEqual(['anime', 'books', 'games', 'movies', 'series', 'western-animation']);
    const ids = [...snap.concepts.keys()];
    expect(ids).toEqual([...ids].sort());
    const c = snap.concepts.get('anime/86-eighty-six')!;
    expect(c).toMatchObject({ file: 'anime/86-eighty-six.md', dir: 'anime', name: '86-eighty-six', list: 'anime' });
  });
});

describe('scanBundle skipping rules', () => {
  it('skips dot dirs, symlinks, index/log, non-md; flags odd files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-scan-'));
    try {
      const w = async (p: string, s = '# x\n') => {
        await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
        await fs.writeFile(path.join(root, p), s);
      };
      await w('index.md'); await w('log.md'); await w('root.md');
      await w('anime/index.md'); await w('anime/log.md'); await w('anime/a.md'); await w('anime/n.txt');
      await w('anime/gundam/index.md'); await w('anime/gundam/g.md');
      await w('.obsidian/x.md'); await w('.git/y.md'); await w('anime/.hidden/z.md');
      await w('misc/m.md');
      await fs.symlink(path.join(root, 'anime/a.md'), path.join(root, 'anime/link.md'));
      await fs.symlink(path.join(root, 'anime/gundam'), path.join(root, 'anime/linkdir'));
      const snap = await scanBundle(root);
      expect([...snap.concepts.keys()]).toEqual(['anime/a', 'anime/gundam/g', 'misc/m', 'root']);
      expect(snap.dirs).toEqual(['anime', 'anime/gundam', 'misc']);
      expect(snap.concepts.get('root')!.list).toBeNull();
      expect(snap.concepts.get('root')!.dir).toBe('');
      expect(snap.concepts.get('misc/m')!.list).toBeNull();
      expect(snap.concepts.get('anime/gundam/g')).toMatchObject({ dir: 'anime/gundam', list: 'anime', name: 'g' });
      expect(snap.concepts.get('anime/a')!.problems).toContain('no frontmatter');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('scanBundle robustness', () => {
  it('flags an unreadable file instead of rejecting, and skips vanished ones', async () => {
    const b = await makeTempBundle();
    try {
      // a directory named like a concept: readdir sees isDirectory, so use a dangling race substitute:
      // a file with no read permission (skipped when running as root).
      const f = path.join(b.root, 'anime', 'zz-locked.md');
      await fs.writeFile(f, '---\ntitle: T\n---\n');
      await fs.chmod(f, 0o000);
      const snap = await scanBundle(b.root);
      expect(snap.concepts.size).toBeGreaterThanOrEqual(96);
      if (process.getuid?.() !== 0) {
        expect(snap.concepts.get('anime/zz-locked')!.problems[0]).toMatch(/could not be read/);
      }
      await fs.chmod(f, 0o644);
      // concurrent churn never rejects
      const churn = (async () => {
        for (let i = 0; i < 200; i++) {
          const p = path.join(b.root, 'anime', `zz-churn-${i % 5}.md`);
          await fs.writeFile(p, '---\ntitle: C\n---\n');
          await fs.rm(p, { force: true });
        }
      })();
      const scans = Promise.all(Array.from({ length: 50 }, () => scanBundle(b.root)));
      await Promise.all([churn, scans]);
    } finally {
      await b.cleanup();
    }
  });
});
