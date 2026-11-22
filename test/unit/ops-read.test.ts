import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/errors.js';
import { listConcepts, listDirectory, listStale, listTags, readConcept, searchConcepts } from '../../src/ops/read.js';
import { makeTempBundle } from '../helpers/bundle.js';

let root: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ root, cleanup } = await makeTempBundle());
});
afterAll(async () => cleanup());

async function put(rel: string, text: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
}

describe('listDirectory', () => {
  it('lists the root with six lists, counts and an always-present problems array', async () => {
    const r = await listDirectory(root);
    expect(r.path).toBe('');
    expect(r.directories.map((d) => d.name).sort()).toEqual(
      ['anime', 'books', 'games', 'movies', 'series', 'western-animation'],
    );
    expect(r.directories.reduce((n, d) => n + d.counts.total, 0)).toBe(96);
    expect(Array.isArray(r.problems)).toBe(true);
    const anime = r.directories.find((d) => d.name === 'anime')!;
    expect(Object.values(anime.counts.by_status).reduce((a, b) => a + b, 0)).toBe(anime.counts.total);
  });

  it('lists concepts of a list as summaries', async () => {
    const r = await listDirectory(root, { path: 'movies' });
    expect(r.problems).toBeUndefined();
    const cg = r.concepts.find((c) => c.id === 'movies/clockwork-girl')!;
    expect(cg.title).toBe('Clockwork Girl');
    expect(cg.problems).toBeUndefined();
  });

  it('errors on an unknown directory and a bad path', async () => {
    await expect(listDirectory(root, { path: 'nope' })).rejects.toThrow(ToolError);
    await expect(listDirectory(root, { path: '../x' })).rejects.toThrow(ToolError);
  });
});

describe('flagged concepts', () => {
  it('shows problems in summaries, root problems, and raw in read_concept', async () => {
    await put('books/broken.md', 'no frontmatter here\n');
    await put('books/odd.md', '---\ntype: Book\ntitle: Odd\nlist_status: reading\n---\n\nbody\n');
    const root_ = await listDirectory(root);
    const ids = root_.problems!.map((p) => p.id);
    expect(ids).toContain('books/broken');
    expect(ids).toContain('books/odd');
    const books = await listDirectory(root, { path: 'books' });
    const broken = books.concepts.find((c) => c.id === 'books/broken')!;
    expect(Object.keys(broken)).toEqual(['id', 'problems']);
    const r = await readConcept(root, { id: 'books/odd' });
    expect(r.problems[0]).toContain("invalid list_status 'reading'");
    expect(r.raw).toContain('list_status: reading');
    const ok = await readConcept(root, { id: 'movies/clockwork-girl' });
    expect(ok.raw).toBeUndefined();
    await fs.rm(path.join(root, 'books/broken.md'));
    await fs.rm(path.join(root, 'books/odd.md'));
  });
});

describe('listConcepts', () => {
  it('paginates sorted by id with a cursor', async () => {
    const a = await listConcepts(root, { limit: 40 });
    expect(a.total).toBe(96);
    expect(a.concepts).toHaveLength(40);
    expect(a.next_cursor).not.toBeNull();
    const b = await listConcepts(root, { limit: 40, cursor: a.next_cursor! });
    const c = await listConcepts(root, { limit: 40, cursor: b.next_cursor! });
    expect(c.concepts).toHaveLength(16);
    expect(c.next_cursor).toBeNull();
    const ids = [...a.concepts, ...b.concepts, ...c.concepts].map((x) => x.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(96);
  });

  it('filters by list and list_status and validates them', async () => {
    const r = await listConcepts(root, { path: 'movies', list_status: 'to-watch' });
    expect(r.concepts.every((c) => String(c.id).startsWith('movies/') && c.list_status === 'to-watch')).toBe(true);
    await expect(listConcepts(root, { path: 'movies', list_status: 'in-progress' })).rejects.toThrow(
      /invalid list_status 'in-progress' for movies \(allowed: to-watch, complete, dropped, archived\)/,
    );
    expect((await listConcepts(root, { path: 'nope' })).total).toBe(0);
    await expect(listConcepts(root, { path: '../x' })).rejects.toThrow(ToolError);
    await expect(listConcepts(root, { list_status: 'watching' })).rejects.toThrow(ToolError);
  });

  it('validates limit and cursor', async () => {
    await expect(listConcepts(root, { limit: 0 })).rejects.toThrow(ToolError);
    await expect(listConcepts(root, { limit: 101 })).rejects.toThrow(ToolError);
    await expect(listConcepts(root, { cursor: '!!!' })).rejects.toThrow(/cursor/);
  });

  it('filters by tags (all, case-sensitive) and bare_only', async () => {
    await put('games/t1.md', '---\ntype: Game\ntitle: T1\nlist_status: to-play\ntags: [a, B]\n---\n');
    await put('games/t2.md', '---\ntype: Game\ntitle: T2\nlist_status: to-play\ntags: [a]\nruntime: 5h\n---\n');
    expect((await listConcepts(root, { tags: ['a'] })).concepts.map((c) => c.id)).toEqual(['games/t1', 'games/t2']);
    expect((await listConcepts(root, { tags: ['a', 'B'] })).concepts.map((c) => c.id)).toEqual(['games/t1']);
    expect((await listConcepts(root, { tags: ['b'] })).total).toBe(0);
    const bare = await listConcepts(root, { path: 'games', bare_only: true });
    expect(bare.concepts.map((c) => c.id)).toContain('games/t1');
    expect(bare.concepts.map((c) => c.id)).not.toContain('games/t2');
    await expect(listConcepts(root, { tags: [''] })).rejects.toThrow(ToolError);
    await fs.rm(path.join(root, 'games/t1.md'));
    await fs.rm(path.join(root, 'games/t2.md'));
  });
});

describe('readConcept', () => {
  it('returns frontmatter, body, links and backlinks', async () => {
    const r = await readConcept(root, { id: 'movies/clockwork-girl' });
    expect(r.frontmatter?.title).toBe('Clockwork Girl');
    expect(r.body).toContain('# Where to watch');
    expect(r.links).toEqual(['anime/virgin-punk-clockwork-girl']);
    expect(r.backlinks).toEqual(['anime/virgin-punk-clockwork-girl']);
    expect(r.problems).toEqual([]);
  });

  it('gives the exact message for an unknown id', async () => {
    await expect(readConcept(root, { id: 'movies/nope' })).rejects.toThrow(
      "No concept with ID 'movies/nope'. The file may have moved or been renamed; find it again with search_concepts.",
    );
    await expect(readConcept(root, { id: 'movies/x.md' })).rejects.toThrow(ToolError);
  });
});

describe('searchConcepts', () => {
  it('puts title matches first and builds a snippet', async () => {
    const r = await searchConcepts(root, { query: 'CLOCKWORK' });
    expect(r.total).toBe(r.results.length);
    expect(r.results.length).toBeGreaterThanOrEqual(2);
    const titles = r.results.map((x) => String(x.frontmatter?.title).toLowerCase().includes('clockwork'));
    expect(titles.slice(0, 2)).toEqual([true, true]);
    expect(r.results[0]!.snippet.toLowerCase()).toContain('clockwork');
    expect(r.results[0]!.snippet.length).toBeLessThanOrEqual(130);
  });

  it('searches body and tags, applies limit, and validates', async () => {
    await put('games/tagged.md', '---\ntype: Game\ntitle: Zed\nlist_status: to-play\ntags: [Roguelike]\n---\n\nline one\n\nsecret   word here\n');
    expect((await searchConcepts(root, { query: 'roguelike' })).results[0]!.id).toBe('games/tagged');
    const body = await searchConcepts(root, { query: 'secret word' });
    expect(body.results[0]!.snippet).toContain('secret word here');
    const lim = await searchConcepts(root, { query: 'a', limit: 3 });
    expect(lim.results).toHaveLength(3);
    expect(lim.total).toBeGreaterThan(3);
    expect((await searchConcepts(root, { query: 'secret', path: 'movies' })).total).toBe(0);
    await expect(searchConcepts(root, { query: '   ' })).rejects.toThrow(ToolError);
    await expect(searchConcepts(root, { query: 'x', limit: 0 })).rejects.toThrow(ToolError);
    await fs.rm(path.join(root, 'games/tagged.md'));
  });

  it('uses ellipses for long text', async () => {
    await put('games/long.md', `---\ntype: Game\ntitle: Long\nlist_status: to-play\n---\n\n${'x '.repeat(200)}needle${' y'.repeat(200)}\n`);
    const r = await searchConcepts(root, { query: 'needle' });
    expect(r.results[0]!.snippet.startsWith('…')).toBe(true);
    expect(r.results[0]!.snippet.endsWith('…')).toBe(true);
    await fs.rm(path.join(root, 'games/long.md'));
  });
});

describe('listStale', () => {
  it('orders: past stale_after oldest first, unverified ordered by generated.at', async () => {
    await put('games/s-past-old.md', '---\ntype: Game\ntitle: A\nlist_status: to-play\nstale_after: 2020-01-01T00:00:00Z\nverified: [{by: x, at: 2019-01-01T00:00:00Z}]\n---\n');
    await put('games/s-past-new.md', '---\ntype: Game\ntitle: B\nlist_status: to-play\nstale_after: 2021-01-01T00:00:00Z\n---\n');
    await put('games/s-future.md', '---\ntype: Game\ntitle: C\nlist_status: to-play\nstale_after: 2099-01-01T00:00:00Z\nverified: [{by: x, at: 2019-01-01T00:00:00Z}]\n---\n');
    await put('games/s-bad.md', '---\ntype: Game\ntitle: D\nlist_status: to-play\nstale_after: garbage\nverified: [{by: x, at: 2019-01-01T00:00:00Z}]\n---\n');
    await put('games/s-nogen.md', '---\ntype: Game\ntitle: E\nlist_status: to-play\n---\n');
    const now = new Date('2026-11-16T00:00:00Z');
    const r = await listStale(root, { path: 'games', limit: 100 }, now);
    const ids = r.concepts.map((c) => c.id);
    expect(ids).not.toContain('games/s-future');
    expect(ids.slice(0, 3)).toEqual(['games/s-bad', 'games/s-nogen', 'games/s-past-old']);
    expect(ids.indexOf('games/s-past-old')).toBeLessThan(ids.indexOf('games/s-past-new'));
    const reasons = Object.fromEntries(r.concepts.map((c) => [c.id, c.reason]));
    expect(reasons['games/s-past-old']).toBe('past_stale_after');
    expect(reasons['games/s-bad']).toBe('past_stale_after');
    expect(reasons['games/s-nogen']).toBe('unverified');
    for (const f of ['s-past-old', 's-past-new', 's-future', 's-bad', 's-nogen']) await fs.rm(path.join(root, `games/${f}.md`));
  });

  it('flags every migrated concept as unverified and paginates', async () => {
    const a = await listStale(root, { limit: 50 });
    expect(a.concepts).toHaveLength(50);
    expect(a.concepts.every((c) => c.reason === 'unverified')).toBe(true);
    const b = await listStale(root, { limit: 50, cursor: a.next_cursor! });
    expect(b.concepts).toHaveLength(46);
    expect(b.next_cursor).toBeNull();
    await expect(listStale(root, { limit: 101 })).rejects.toThrow(ToolError);
  });
});

describe('listTags', () => {
  it('counts tags, count desc then tag asc', async () => {
    await put('games/g1.md', '---\ntype: Game\ntitle: G1\nlist_status: to-play\ntags: [b, a, b]\n---\n');
    await put('games/g2.md', '---\ntype: Game\ntitle: G2\nlist_status: to-play\ntags: [b, c, a]\n---\n');
    await put('games/g3.md', '---\ntype: Game\ntitle: G3\nlist_status: to-play\ntags: [c]\n---\n');
    const r = await listTags(root);
    expect(r.tags).toEqual([
      { tag: 'a', count: 2 },
      { tag: 'b', count: 2 },
      { tag: 'c', count: 2 },
    ]);
    for (const f of ['g1', 'g2', 'g3']) await fs.rm(path.join(root, `games/${f}.md`));
  });
});

describe('odd frontmatter values and snippets', () => {
  it('tolerates scalar tags and non-string titles', async () => {
    await put('anime/odd-tag.md', '---\ntype: Anime\ntitle: Odd\nlist_status: to-watch\ntags: solo\n---\n');
    await put('anime/odd-title.md', '---\ntype: Anime\ntitle: 12345\nlist_status: to-watch\n---\n');
    const l = await listConcepts(root, { tags: ['solo'] });
    expect(l.concepts.map((c) => c.id)).toEqual(['anime/odd-tag']);
    expect((await listTags(root)).tags).toContainEqual({ tag: 'solo', count: 1 });
    const s = await searchConcepts(root, { query: '12345' });
    expect(s.results.map((r) => r.id)).toContain('anime/odd-title');
    const s2 = await searchConcepts(root, { query: 'solo' });
    expect(s2.results.map((r) => r.id)).toContain('anime/odd-tag');
  });

  it('snippet does not drift when lowercasing changes length', async () => {
    await put('anime/dotted.md', `---\ntype: Anime\ntitle: Dotted\nlist_status: to-watch\n---\n\n${'İ'.repeat(60)} needle-here ${'x'.repeat(100)}\n`);
    const s = await searchConcepts(root, { query: 'needle-here' });
    const r = s.results.find((x) => x.id === 'anime/dotted')!;
    expect(r.snippet).toContain('needle-here');
  });
});
