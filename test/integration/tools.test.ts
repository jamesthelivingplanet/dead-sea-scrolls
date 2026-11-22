import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git } from '../../src/git.js';
import { startTestServer, type TestServer } from '../helpers/server.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer({ clientName: 'test-agent' });
});
afterAll(async () => {
  await t.close();
});

interface Called {
  isError: boolean;
  data: any;
  text: string;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const res = (await t.client.callTool({ name, arguments: args })) as any;
  const text: string = res.content?.[0]?.text ?? '';
  const isError = res.isError === true;
  if (!isError) {
    expect(res.structuredContent).toBeDefined();
    expect(JSON.parse(text)).toEqual(res.structuredContent);
  }
  return { isError, data: res.structuredContent, text };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(name, args);
  expect(r.isError, r.text).toBe(false);
  return r.data;
}

const lastAuthor = async () => (await git(t.root, ['log', '-1', '--format=%an <%ae>'])).trim();
const lastSubject = async () => (await git(t.root, ['log', '-1', '--format=%s'])).trim();
const exists = (rel: string) => fs.existsSync(path.join(t.root, rel));

describe('tools over HTTP', () => {
  it('lists exactly the ten tools', async () => {
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(
      [
        'create_concept', 'delete_concept', 'list_concepts', 'list_directory', 'list_stale',
        'list_tags', 'move_concept', 'read_concept', 'search_concepts', 'update_concept',
      ].sort(),
    );
    for (const x of tools) expect(x.description?.length).toBeGreaterThan(40);
  });

  it('list_directory at the root shows six lists, 96 concepts, no problems', async () => {
    const d = await ok('list_directory');
    expect(d.path).toBe('');
    expect(d.directories.map((x: any) => x.name).sort()).toEqual(
      ['anime', 'books', 'games', 'movies', 'series', 'western-animation'],
    );
    expect(d.directories.reduce((n: number, x: any) => n + x.counts.total, 0)).toBe(96);
    expect(d.problems ?? []).toEqual([]);
    const anime = await ok('list_directory', { path: 'anime' });
    expect(anime.concepts.length).toBe(39);
    expect(anime.concepts[0].id).toMatch(/^anime\//);
  });

  it('list_concepts filters and paginates', async () => {
    const movies = await ok('list_concepts', { path: 'movies' });
    expect(movies.total).toBe(8);
    const todo = await ok('list_concepts', { path: 'anime', list_status: 'to-watch' });
    expect(todo.concepts.every((c: any) => c.list_status === 'to-watch')).toBe(true);
    const p1 = await ok('list_concepts', { limit: 10 });
    expect(p1.concepts).toHaveLength(10);
    expect(p1.total).toBe(96);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await ok('list_concepts', { limit: 10, cursor: p1.next_cursor });
    expect(p2.concepts[0].id).not.toBe(p1.concepts[0].id);
    const ids = new Set([...p1.concepts, ...p2.concepts].map((c: any) => c.id));
    expect(ids.size).toBe(20);
    const bare = await ok('list_concepts', { bare_only: true, limit: 100 });
    expect(bare.total).toBeLessThan(96);
  });

  it('read_concept returns links and backlinks', async () => {
    const r = await ok('read_concept', { id: 'movies/clockwork-girl' });
    expect(r.frontmatter.title).toBe('Clockwork Girl');
    expect(r.body).toContain('Where to watch');
    expect(r.links).toContain('anime/virgin-punk-clockwork-girl');
    expect(r.backlinks).toContain('anime/virgin-punk-clockwork-girl');
    expect(r.problems).toEqual([]);
  });

  it('search_concepts puts title matches first', async () => {
    const s = await ok('search_concepts', { query: 'clockwork' });
    expect(s.total).toBeGreaterThanOrEqual(2);
    expect(s.results[0].frontmatter.title.toLowerCase()).toContain('clockwork');
    expect(s.results[0].snippet.toLowerCase()).toContain('clockwork');
    const filtered = await ok('search_concepts', { query: 'clockwork', path: 'movies' });
    expect(filtered.results.every((x: any) => x.id.startsWith('movies/'))).toBe(true);
  });

  it('list_stale reports everything unverified at first, oldest first', async () => {
    const s = await ok('list_stale', { limit: 100 });
    expect(s.concepts).toHaveLength(96);
    expect(s.concepts.every((c: any) => c.reason === 'unverified')).toBe(true);
    const ats = s.concepts.map((c: any) => c.frontmatter.generated?.at ?? '');
    expect([...ats].sort()).toEqual(ats);
    const one = await ok('list_stale', { path: 'games' });
    expect(one.concepts.every((c: any) => c.id.startsWith('games/'))).toBe(true);
  });

  let created = '';
  it('create_concept commits as the client and stamps generated.by', async () => {
    const r = await ok('create_concept', {
      path: 'anime',
      title: 'Mobile Suit Gundam',
      description: 'The original.',
      tags: ['mecha'],
    });
    created = r.id;
    expect(created).toBe('anime/mobile-suit-gundam');
    expect(r.frontmatter.type).toBe('Anime');
    expect(r.frontmatter.list_status).toBe('to-watch');
    expect(r.frontmatter.generated.by).toBe('test-agent');
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await lastAuthor()).toBe('test-agent <test-agent@dead-sea-scrolls.local>');
    expect(await lastSubject()).toBe('Add Mobile Suit Gundam to anime');
    expect(exists('anime/mobile-suit-gundam.md')).toBe(true);
    const again = await ok('create_concept', { path: 'anime', title: 'Mobile Suit Gundam' });
    expect(again.id).toBe('anime/mobile-suit-gundam-2');
  });

  it('list_tags counts tags after tagging', async () => {
    const tags = await ok('list_tags');
    expect(tags.tags).toContainEqual({ tag: 'mecha', count: 1 });
    await ok('update_concept', { id: 'anime/mobile-suit-gundam-2', frontmatter: { tags: ['mecha', 'classic'] } });
    const after = await ok('list_tags');
    expect(after.tags[0]).toEqual({ tag: 'mecha', count: 2 });
    const byTag = await ok('list_concepts', { tags: ['mecha', 'classic'] });
    expect(byTag.concepts.map((c: any) => c.id)).toEqual(['anime/mobile-suit-gundam-2']);
  });

  it('update_concept patches frontmatter and body', async () => {
    const r = await ok('update_concept', {
      id: created,
      frontmatter: { list_status: 'in-progress', runtime: '~1200 min' },
      body: 'Watching it now.',
    });
    expect(r.frontmatter.list_status).toBe('in-progress');
    expect(r.frontmatter.runtime).toBe('~1200 min');
    expect(r.frontmatter.title).toBe('Mobile Suit Gundam');
    expect(await lastSubject()).toBe('Update Mobile Suit Gundam');
    const back = await ok('read_concept', { id: created });
    expect(back.body).toContain('Watching it now.');
    const stale = await ok('list_stale', { limit: 100 });
    expect(stale.concepts.some((c: any) => c.id === created)).toBe(true);
    await ok('update_concept', {
      id: created,
      frontmatter: { verified: [{ by: 'test-agent', at: '2026-11-16T00:00:00Z' }] },
    });
    const stale2 = await ok('list_stale', { limit: 100 });
    expect(stale2.concepts.some((c: any) => c.id === created)).toBe(false);
  });

  it('move_concept moves into a subdirectory and across lists', async () => {
    const r = await ok('move_concept', { id: created, to: 'anime/gundam', name: 'gundam-0079' });
    expect(r.previous_id).toBe(created);
    expect(r.id).toBe('anime/gundam/gundam-0079');
    expect(exists('anime/gundam/gundam-0079.md')).toBe(true);
    expect(exists('anime/mobile-suit-gundam.md')).toBe(false);
    expect(await lastAuthor()).toBe('test-agent <test-agent@dead-sea-scrolls.local>');
    const dir = await ok('list_directory', { path: 'anime' });
    expect(dir.directories.map((d: any) => d.name)).toContain('gundam');

    const cross = await ok('move_concept', { id: 'anime/mobile-suit-gundam-2', to: 'movies' });
    expect(cross.id).toBe('movies/mobile-suit-gundam-2');
    expect(cross.frontmatter.type).toBe('Movie');
  });

  it('delete_concept previews, then deletes on confirm', async () => {
    const id = 'movies/mobile-suit-gundam-2';
    const preview = await ok('delete_concept', { id });
    expect(preview.confirm_required).toBe(true);
    expect(preview.would_delete.file).toBe('movies/mobile-suit-gundam-2.md');
    expect(exists(preview.would_delete.file)).toBe(true);
    const done = await ok('delete_concept', { id, confirm: true });
    expect(done.deleted).toBe(true);
    expect(done.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(exists('movies/mobile-suit-gundam-2.md')).toBe(false);
    expect(await lastSubject()).toBe('Delete Mobile Suit Gundam');
  });

  describe('errors', () => {
    it('unknown ID points at search_concepts', async () => {
      const r = await call('read_concept', { id: 'anime/no-such-thing' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('search_concepts');
      expect((await call('update_concept', { id: 'anime/no-such-thing', body: 'x' })).isError).toBe(true);
      expect((await call('delete_concept', { id: 'anime/no-such-thing' })).isError).toBe(true);
    });

    it('bad list_status for a list', async () => {
      const r = await call('create_concept', { path: 'anime', title: 'Bad Status', list_status: 'to-read' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/to-read/);
      expect(r.text).toMatch(/anime/);
      expect(exists('anime/bad-status.md')).toBe(false);
      const q = await call('list_concepts', { path: 'anime', list_status: 'to-read' });
      expect(q.isError).toBe(true);
    });

    it('update with nothing', async () => {
      const r = await call('update_concept', { id: 'movies/clockwork-girl' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/frontmatter|body/);
    });

    it('cross-list move with an invalid status', async () => {
      const r = await call('move_concept', { id: 'anime/jujutsu-kaisen', to: 'movies' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/caught-up/);
      expect(exists('anime/jujutsu-kaisen.md')).toBe(true);
      const fixed = await ok('move_concept', { id: 'anime/jujutsu-kaisen', to: 'movies', list_status: 'complete' });
      expect(fixed.id).toBe('movies/jujutsu-kaisen');
      expect(fixed.frontmatter.list_status).toBe('complete');
    });

    it('delete without confirm leaves the file', async () => {
      const r = await ok('delete_concept', { id: 'movies/clockwork-girl' });
      expect(r.confirm_required).toBe(true);
      expect(exists('movies/clockwork-girl.md')).toBe(true);
    });

    it('rejects unknown frontmatter keys as a protocol-level validation error', async () => {
      const r = await call('update_concept', { id: 'movies/clockwork-girl', frontmatter: { type: 'Anime' } }).catch((e) => e);
      expect(r instanceof Error || r.isError === true).toBe(true);
    });
  });

  it('update_concept accepts null to remove optional keys', async () => {
    const created = await ok('create_concept', {
      path: 'movies', title: 'Null Removal Probe', description: 'd', runtime: '90 min', author: 'someone', tags: ['a'],
    });
    const r = await ok('update_concept', {
      id: created.id,
      frontmatter: { description: null, runtime: null, author: null, tags: null, resource: null, status_detail: null },
    });
    expect(r.frontmatter.description).toBeUndefined();
    expect(r.frontmatter.runtime).toBeUndefined();
    expect(r.frontmatter.tags).toBeUndefined();
    expect(r.frontmatter.title).toBe('Null Removal Probe');
    const bad = await call('update_concept', { id: created.id, frontmatter: { title: null } });
    expect(bad.isError).toBe(true);
  });
});
