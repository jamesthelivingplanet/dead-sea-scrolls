import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/server.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer({ clientName: 'test-agent' });
});
afterAll(async () => {
  await t.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await t.client.callTool({ name, arguments: args })) as any;
  return { isError: res.isError === true, data: res.structuredContent, text: (res.content?.[0]?.text ?? '') as string };
}
async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(name, args);
  expect(r.isError, r.text).toBe(false);
  return r.data;
}
const exists = (rel: string) => fs.existsSync(path.join(t.root, rel));
const rootDirs = async () => (await ok('list_directory')).directories.map((d: any) => d.name).sort();

describe('notes and areas', () => {
  let before: string[];
  let beforeCounts: Record<string, number>;
  const counts = async () =>
    Object.fromEntries((await ok('list_directory')).directories.map((d: any) => [d.name, d.counts.total]));
  beforeAll(async () => {
    before = await rootDirs();
    beforeCounts = await counts();
  });

  let noteId = '';
  it('creates a note with a title only: type Note, status draft, commit', async () => {
    const r = await ok('create_concept', { path: 'notes', title: 'Remember the milk', tags: ['memory'] });
    noteId = r.id;
    expect(r.id).toBe('notes/remember-the-milk');
    expect(r.frontmatter.type).toBe('Note');
    expect(r.frontmatter.status).toBe('draft');
    expect(r.frontmatter.list_status).toBeUndefined();
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(exists('notes/index.md')).toBe(true);
    expect(fs.readFileSync(path.join(t.root, 'notes/index.md'), 'utf8')).toContain('[Remember the milk](remember-the-milk.md)');
  });

  it('uses an explicit type in a new directory; errors without one', async () => {
    const r = await ok('create_concept', { path: 'learning/rust', title: 'Ownership', type: 'Lesson' });
    expect(r.id).toBe('learning/rust/ownership');
    expect(r.frontmatter.type).toBe('Lesson');
    expect(r.frontmatter.status).toBe('draft');
    const bad = await call('create_concept', { path: 'misc', title: 'No Type' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/type/i);
    expect(exists('misc')).toBe(false);
  });

  it('keeps deriving the type in the six lists, and rejects a disagreeing type', async () => {
    const r = await ok('create_concept', { path: 'movies', title: 'Notes Probe Movie' });
    expect(r.frontmatter.type).toBe('Movie');
    expect(r.frontmatter.list_status).toBe('to-watch');
    expect(r.frontmatter.status).toBeUndefined();
    const bad = await call('create_concept', { path: 'movies', title: 'Wrong', type: 'Book' });
    expect(bad.isError).toBe(true);
    expect(exists('movies/wrong.md')).toBe(false);
  });

  it('rejects list_status on a non-list create, and bad paths', async () => {
    const r = await call('create_concept', { path: 'notes', title: 'Nope', list_status: 'to-watch' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/status/);
    expect(exists('notes/nope.md')).toBe(false);
    for (const p of ['../x', '/abs', '.git/x', 'notes/', '']) {
      expect((await call('create_concept', { path: p, title: 'Bad', type: 'Note' })).isError, p).toBe(true);
    }
  });

  it('filters list_concepts, list_status, search and list_stale by path', async () => {
    expect((await ok('list_concepts', { path: 'notes' })).concepts.map((c: any) => c.id)).toEqual([noteId]);
    expect((await ok('list_concepts', { path: 'movies' })).total).toBe(9);
    expect((await ok('list_concepts', { path: 'nonexistent' })).total).toBe(0);
    const byStatus = await ok('list_concepts', { list_status: 'to-watch', limit: 100 });
    expect(byStatus.concepts.some((c: any) => c.id.startsWith('notes/'))).toBe(false);
    const s = await ok('search_concepts', { query: 'milk', path: 'notes' });
    expect(s.results.map((x: any) => x.id)).toEqual([noteId]);
    expect((await ok('search_concepts', { query: 'milk', path: 'movies' })).total).toBe(0);
    const stale = await ok('list_stale', { path: 'movies', limit: 100 });
    expect(stale.concepts.length).toBe(9);
    expect(stale.concepts.every((c: any) => c.id.startsWith('movies/'))).toBe(true);
    expect((await ok('list_stale', { path: 'notes' })).concepts).toEqual([]);
    expect((await ok('list_stale', { limit: 100 })).concepts.some((c: any) => c.id.startsWith('notes/'))).toBe(false);
  });

  it('lists areas in list_directory with totals, no by_status, and no problems', async () => {
    const d = await ok('list_directory');
    const notes = d.directories.find((x: any) => x.name === 'notes');
    expect(notes.counts).toEqual({ total: 1, by_status: {} });
    expect(d.problems ?? []).toEqual([]);
  });

  it('updates a note status and rejects list_status / invalid status', async () => {
    const r = await ok('update_concept', { id: noteId, frontmatter: { status: 'stable' } });
    expect(r.frontmatter.status).toBe('stable');
    expect(r.frontmatter.type).toBe('Note');
    expect((await ok('read_concept', { id: noteId })).frontmatter.status).toBe('stable');
    expect((await call('update_concept', { id: noteId, frontmatter: { list_status: 'to-watch' } })).isError).toBe(true);
    expect((await call('update_concept', { id: noteId, frontmatter: { status: 'wip' } })).isError).toBe(true);
  });

  it('moves a note to a nested directory, rewriting links', async () => {
    const other = await ok('create_concept', { path: 'notes', title: 'Linker', body: `See [milk](${noteId.split('/')[1]}.md)\n` });
    const m = await ok('move_concept', { id: noteId, to: 'notes/projects' });
    expect(m.id).toBe('notes/projects/remember-the-milk');
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.frontmatter.type).toBe('Note');
    expect(m.frontmatter.status).toBe('stable');
    const back = await ok('read_concept', { id: other.id });
    expect(back.links).toEqual([m.id]);
    expect(back.body).toContain('projects/remember-the-milk.md');
    noteId = m.id;
    await ok('delete_concept', { id: other.id, confirm: true });
  });

  it('moves media to notes (type Note, no list_status, draft) and back', async () => {
    const m = await ok('move_concept', { id: 'movies/clockwork-girl', to: 'notes' });
    expect(m.frontmatter.type).toBe('Note');
    expect(m.frontmatter.list_status).toBeUndefined();
    expect(m.frontmatter.status).toBe('draft');
    const bad = await call('move_concept', { id: m.id, to: 'movies' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/list_status/);
    const back = await ok('move_concept', { id: m.id, to: 'movies', list_status: 'to-watch' });
    expect(back.id).toBe('movies/clockwork-girl');
    expect(back.frontmatter).toMatchObject({ type: 'Movie', list_status: 'to-watch' });
    expect(back.frontmatter.status).toBeUndefined();
    // out to a non-notes area keeps the old type
    const out = await ok('move_concept', { id: back.id, to: 'archive', status: 'stable' });
    expect(out.frontmatter).toMatchObject({ type: 'Movie', status: 'stable' });
    expect(out.frontmatter.list_status).toBeUndefined();
    const home = await ok('move_concept', { id: out.id, to: 'movies', list_status: 'to-watch' });
    expect(home.id).toBe('movies/clockwork-girl');
  });

  it('previews a note delete, then deletes it on confirm', async () => {
    const p = await ok('delete_concept', { id: noteId });
    expect(p.confirm_required).toBe(true);
    expect(exists(`${noteId}.md`)).toBe(true);
    await ok('delete_concept', { id: noteId, confirm: true });
    expect(exists(`${noteId}.md`)).toBe(false);
    expect((await call('read_concept', { id: noteId })).isError).toBe(true);
    expect((await ok('list_concepts', { path: 'notes' })).total).toBe(0);
  });

  it('cleans up: media untouched, counts restored, no empty directories', async () => {
    for (const id of ['learning/rust/ownership', 'movies/notes-probe-movie']) {
      await ok('delete_concept', { id, confirm: true });
    }
    expect(await rootDirs()).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
    expect(exists('notes')).toBe(false);
    expect(exists('learning')).toBe(false);
    expect(exists('archive')).toBe(false);
    expect((await ok('list_concepts', { limit: 1 })).total).toBe(96);
  });
});
