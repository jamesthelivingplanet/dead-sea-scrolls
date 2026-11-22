import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseConceptText } from '../../src/bundle/frontmatter.js';
import { authorFor, git } from '../../src/git.js';
import { ToolError } from '../../src/errors.js';
import { createConcept, deleteConcept, moveConcept, relocateConcept, updateConcept, type Actor } from '../../src/ops/write.js';
import { listDirectory, readConcept } from '../../src/ops/read.js';
import { Tx, inTx } from '../../src/tx.js';
import { assertDirPath, assertConceptId } from '../../src/domain/paths.js';
import { makeTempBundle } from '../helpers/bundle.js';

let root: string;
let cleanup: () => Promise<void>;
const actor: Actor = { author: authorFor('agent'), clientName: 'agent' };

beforeEach(async () => {
  ({ root, cleanup } = await makeTempBundle({ git: true }));
});
afterEach(async () => cleanup());

const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const exists = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);
const count = async () => Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim());
const head = async () => (await git(root, ['rev-parse', 'HEAD'])).trim();
const lastMsg = async () => (await git(root, ['log', '-1', '--format=%s'])).trim();
const lastAuthor = async () => (await git(root, ['log', '-1', '--format=%an <%ae>'])).trim();
const lastFiles = async () => (await git(root, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n').sort();

describe('createConcept', () => {
  it('creates a concept, regenerates the index and makes one commit', async () => {
    const before = await count();
    const r = await createConcept(root, { path: 'anime', title: ' Gundam: Witch ', tags: [' mecha '], body: 'Hello\n', resource: 'https://example.com/x' }, actor);
    expect(r.id).toBe('anime/gundam-witch');
    expect(Object.keys(r.frontmatter)).toEqual(['type', 'title', 'resource', 'tags', 'list_status', 'generated']);
    expect(r.frontmatter).toMatchObject({ type: 'Anime', title: 'Gundam: Witch', list_status: 'to-watch', tags: ['mecha'] });
    expect((r.frontmatter.generated as { by: string; at: string }).by).toBe('agent');
    expect((r.frontmatter.generated as { at: string }).at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const parsed = parseConceptText(await read('anime/gundam-witch.md'));
    expect(parsed).toMatchObject({ kind: 'ok', body: 'Hello\n' });
    expect(await count()).toBe(before + 1);
    expect(await head()).toBe(r.commit);
    expect(await lastMsg()).toBe("Add Gundam: Witch to anime");
    expect(await lastAuthor()).toBe('agent <agent@dead-sea-scrolls.local>');
    expect(await lastFiles()).toEqual(['anime/gundam-witch.md', 'anime/index.md']);
    expect(await read('anime/index.md')).toContain('* [Gundam: Witch](gundam-witch.md)');
    expect((await readConcept(root, { id: r.id })).problems).toEqual([]);
  });

  it('suffixes -2 on a taken slug, and avoids index/log names', async () => {
    const a = await createConcept(root, { path: 'anime', title: '86 (Eighty-Six)' }, actor);
    expect(a.id).toBe('anime/86-eighty-six-2');
    const b = await createConcept(root, { path: 'anime', title: 'Index' }, actor);
    expect(b.id).toBe('anime/index-2');
    const c = await createConcept(root, { path: 'books', title: '!!!' }, actor);
    expect(c.id).toBe('books/untitled');
    expect(c.frontmatter.title).toBe('!!!');
  });

  it('uses the list default status and validates inputs', async () => {
    expect((await createConcept(root, { path: 'books', title: 'B' }, actor)).frontmatter.list_status).toBe('to-read');
    const before = await head();
    await expect(createConcept(root, { path: 'anime', title: 'X', list_status: 'watching' }, actor)).rejects.toThrow(
      "invalid list_status 'watching' for anime (allowed: to-watch, in-progress, caught-up, complete, dropped, archived)",
    );
    await expect(createConcept(root, { path: 'nope', title: 'X' }, actor)).rejects.toThrow(ToolError);
    await expect(createConcept(root, { path: 'anime', title: '   ' }, actor)).rejects.toThrow(/title/);
    await expect(createConcept(root, { path: 'anime', title: 'X', resource: 'not a url' }, actor)).rejects.toThrow(/resource/);
    await expect(createConcept(root, { path: 'anime', title: 'X', resource: '/relative' }, actor)).rejects.toThrow(/resource/);
    await expect(createConcept(root, { path: 'anime', title: 'X', tags: ['ok', ' '] }, actor)).rejects.toThrow(/tags/);
    expect(await head()).toBe(before);
  });
});

describe('updateConcept', () => {
  it('patches keys, keeps unknown keys and untouched formatting byte-identical', async () => {
    const id = 'anime/weird';
    await fs.writeFile(
      path.join(root, `${id}.md`),
      '---\ntype: Anime\ntitle: Weird # keep me\n# a comment\nmystery:\n  - 1\n  - 2\nlist_status: to-watch\ndescription: "quoted"\n---\n\nBody  text\n',
    );
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', 'seed']);
    const before = await count();
    const r = await updateConcept(root, { id, frontmatter: { list_status: 'in-progress', tags: ['x'] } }, actor);
    expect(r.frontmatter.list_status).toBe('in-progress');
    const text = await read(`${id}.md`);
    expect(text).toContain('title: Weird # keep me\n# a comment\nmystery:\n  - 1\n  - 2\n');
    expect(text).toContain('description: "quoted"\n');
    expect(text.endsWith('---\n\nBody  text\n')).toBe(true);
    expect(parseConceptText(text)).toMatchObject({ kind: 'ok', data: { mystery: [1, 2], tags: ['x'], generated: { by: 'agent' } } });
    expect(await count()).toBe(before + 1);
    expect(await lastMsg()).toBe('Update Weird');
    expect(await lastAuthor()).toBe('agent <agent@dead-sea-scrolls.local>');
    expect(await lastFiles()).toEqual(['anime/index.md', 'anime/weird.md']);
  });

  it('replaces the body only and keeps frontmatter bytes', async () => {
    const id = 'movies/clockwork-girl';
    const old = await read(`${id}.md`);
    const fmBlock = old.slice(0, old.indexOf('generated:'));
    await updateConcept(root, { id, body: 'New body\n' }, actor);
    const text = await read(`${id}.md`);
    expect(text.startsWith(fmBlock)).toBe(true);
    expect(parseConceptText(text)).toMatchObject({ kind: 'ok', body: 'New body\n' });
  });

  it('changes the title without renaming and commits with the new title; null deletes keys', async () => {
    const r = await updateConcept(root, { id: 'movies/clockwork-girl', frontmatter: { title: 'Clockwork Girl II', runtime: '90 min', description: null } }, actor);
    expect(r.id).toBe('movies/clockwork-girl');
    expect(r.frontmatter.title).toBe('Clockwork Girl II');
    expect(r.frontmatter.description).toBeUndefined();
    expect(await exists('movies/clockwork-girl.md')).toBe(true);
    expect(await lastMsg()).toBe('Update Clockwork Girl II');
    expect(await read('movies/index.md')).toContain('[Clockwork Girl II](clockwork-girl.md)');
  });

  it('adds verified and stale_after', async () => {
    const r = await updateConcept(root, { id: 'movies/clockwork-girl', frontmatter: { verified: [{ by: 'agent', at: '2026-11-16T10:00:00Z' }], stale_after: '2027-01-01T00:00:00Z' } }, actor);
    expect(r.frontmatter.verified).toEqual([{ by: 'agent', at: '2026-11-16T10:00:00Z' }]);
    expect(r.frontmatter.stale_after).toBe('2027-01-01T00:00:00Z');
  });

  it('returns HEAD without committing when nothing changes', async () => {
    const before = await head();
    const r = await updateConcept(root, { id: 'movies/clockwork-girl', frontmatter: { title: 'Clockwork Girl' } }, actor);
    expect(r.commit).toBe(before);
    expect(await head()).toBe(before);
  });

  it('errors: nothing, unknown id/key, invalid values, null on required', async () => {
    const before = await head();
    const id = 'movies/clockwork-girl';
    await expect(updateConcept(root, { id }, actor)).rejects.toThrow('Nothing to update: pass frontmatter, body, or both.');
    await expect(updateConcept(root, { id: 'movies/nope', body: 'x' }, actor)).rejects.toThrow(/No concept with ID 'movies\/nope'/);
    await expect(updateConcept(root, { id, frontmatter: { type: 'Anime' } }, actor)).rejects.toThrow(/'type'/);
    await expect(updateConcept(root, { id, frontmatter: { list_status: 'in-progress' } }, actor)).rejects.toThrow(/invalid list_status 'in-progress' for movies/);
    await expect(updateConcept(root, { id, frontmatter: { title: null } }, actor)).rejects.toThrow(/title/);
    await expect(updateConcept(root, { id, frontmatter: { title: '  ' } }, actor)).rejects.toThrow(/title/);
    await expect(updateConcept(root, { id, frontmatter: { stale_after: 'tomorrow' } }, actor)).rejects.toThrow(/stale_after/);
    await expect(updateConcept(root, { id, frontmatter: { verified: [{ by: 'x' }] } }, actor)).rejects.toThrow(/verified/);
    await expect(updateConcept(root, { id, frontmatter: { resource: 'nope' } }, actor)).rejects.toThrow(/resource/);
    await expect(updateConcept(root, { id, frontmatter: { tags: 'a' as unknown as string[] } }, actor)).rejects.toThrow(/tags/);
    expect(await head()).toBe(before);
  });

  it('sets the type from the list when the file has a wrong type', async () => {
    await fs.writeFile(path.join(root, 'games/g.md'), '---\ntype: Movie\ntitle: G\nlist_status: to-play\n---\n');
    const r = await updateConcept(root, { id: 'games/g', frontmatter: { description: 'd' } }, actor);
    expect(r.frontmatter.type).toBe('Game');
  });

  it('refuses a write that would leave problems', async () => {
    await fs.writeFile(path.join(root, 'games/g.md'), '---\ntype: Game\ntitle: G\nlist_status: wat\n---\n');
    await expect(updateConcept(root, { id: 'games/g', frontmatter: { description: 'd' } }, actor)).rejects.toThrow(/problems.*invalid list_status 'wat'/);
    await expect(updateConcept(root, { id: 'games/g', frontmatter: { list_status: 'complete' } }, actor)).resolves.toBeTruthy();
  });

  it('fixes an unparseable file with a complete frontmatter and keeps the body', async () => {
    await fs.writeFile(path.join(root, 'books/bad.md'), '---\ntitle: [oops\n---\n\nKeep this body.\n');
    await expect(updateConcept(root, { id: 'books/bad', frontmatter: { description: 'd' } }, actor)).rejects.toThrow(/complete frontmatter/);
    await expect(updateConcept(root, { id: 'books/bad', body: 'x' }, actor)).rejects.toThrow(/complete frontmatter/);
    const r = await updateConcept(root, { id: 'books/bad', frontmatter: { title: 'Bad Book', list_status: 'finished', description: 'ok' } }, actor);
    expect(Object.keys(r.frontmatter)).toEqual(['type', 'title', 'list_status', 'description', 'generated']);
    expect(r.frontmatter).toMatchObject({ type: 'Book', title: 'Bad Book', list_status: 'finished' });
    const parsed = parseConceptText(await read('books/bad.md'));
    expect(parsed).toMatchObject({ kind: 'ok', body: 'Keep this body.\n' });
    expect(await lastMsg()).toBe('Update Bad Book');
    expect((await readConcept(root, { id: 'books/bad' })).problems).toEqual([]);
  });

  it('adds frontmatter to a file without any, keeping its text as body; bodies can be replaced too', async () => {
    await fs.writeFile(path.join(root, 'books/plain.md'), '# Plain\n\ntext\n');
    await updateConcept(root, { id: 'books/plain', frontmatter: { title: 'Plain', list_status: 'to-read' } }, actor);
    expect(parseConceptText(await read('books/plain.md'))).toMatchObject({ kind: 'ok', body: '# Plain\n\ntext\n' });
    await fs.writeFile(path.join(root, 'books/plain2.md'), 'old\n');
    await updateConcept(root, { id: 'books/plain2', frontmatter: { title: 'P2', list_status: 'to-read' }, body: 'new\n' }, actor);
    expect(parseConceptText(await read('books/plain2.md'))).toMatchObject({ kind: 'ok', body: 'new\n' });
  });

  it('refuses a concept outside a list and suggests move_concept', async () => {
    await fs.writeFile(path.join(root, 'stray.md'), '---\ntitle: S\n---\n');
    await expect(updateConcept(root, { id: 'stray', body: 'x' }, actor)).rejects.toThrow(/move_concept/);
  });
});

describe('moveConcept', () => {
  it('moves into a new nested dir, creating dir and index, in one commit with the index', async () => {
    const before = await count();
    const r = await moveConcept(root, { id: 'anime/86-eighty-six', to: 'anime/gundam' }, actor);
    expect(r).toMatchObject({ id: 'anime/gundam/86-eighty-six', previous_id: 'anime/86-eighty-six' });
    expect(await exists('anime/86-eighty-six.md')).toBe(false);
    expect(await exists('anime/gundam/86-eighty-six.md')).toBe(true);
    expect(await read('anime/gundam/index.md')).toContain('[86 (Eighty-Six)](86-eighty-six.md)');
    const top = await read('anime/index.md');
    expect(top).toContain('## Folders');
    expect(top).toContain('* [gundam](gundam/) - 1 title');
    expect(top).not.toContain('(86-eighty-six.md)');
    expect(await count()).toBe(before + 1);
    expect(await lastMsg()).toBe('Move 86 (Eighty-Six) from anime/86-eighty-six to anime/gundam/86-eighty-six');
    expect(await lastAuthor()).toBe('agent <agent@dead-sea-scrolls.local>');
    expect(await lastFiles()).toEqual(['anime/gundam/86-eighty-six.md', 'anime/gundam/index.md', 'anime/index.md']);
    expect(r.frontmatter.generated).toMatchObject({ by: 'agent' });
  });

  it('removes the nested dir when its last concept moves out', async () => {
    await moveConcept(root, { id: 'anime/86-eighty-six', to: 'anime/gundam' }, actor);
    const r = await moveConcept(root, { id: 'anime/gundam/86-eighty-six', to: 'anime' }, actor);
    expect(r.id).toBe('anime/86-eighty-six');
    expect(await exists('anime/gundam')).toBe(false);
    expect(await read('anime/index.md')).not.toContain('## Folders');
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });

  it('renames with name, suffixing when taken', async () => {
    const r = await moveConcept(root, { id: 'movies/clockwork-girl', to: 'movies', name: 'Clockwork Girl!' }, actor).catch((e: Error) => e);
    expect(r).toBeInstanceOf(ToolError);
    expect((r as Error).message).toBe('already at movies/clockwork-girl');
    const m = await moveConcept(root, { id: 'movies/clockwork-girl', to: 'movies', name: 'Renamed Film' }, actor);
    expect(m.id).toBe('movies/renamed-film');
    await createConcept(root, { path: 'movies', title: 'Other' }, actor);
    const m2 = await moveConcept(root, { id: 'movies/other', to: 'movies', name: 'renamed-film' }, actor);
    expect(m2.id).toBe('movies/renamed-film-2');
  });

  it('cross-list move: invalid status errors, valid status works and type changes', async () => {
    const before = await head();
    await fs.writeFile(path.join(root, 'anime/a.md'), '---\ntype: Anime\ntitle: A\nlist_status: caught-up\n---\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', 'seed']);
    const seed = await head();
    expect(seed).not.toBe(before);
    await expect(moveConcept(root, { id: 'anime/a', to: 'movies' }, actor)).rejects.toThrow(
      /list_status 'caught-up' is not allowed in movies \(allowed: to-watch, complete, dropped, archived\)/,
    );
    await expect(moveConcept(root, { id: 'anime/a', to: 'movies', list_status: 'in-progress' }, actor)).rejects.toThrow(/invalid list_status 'in-progress' for movies/);
    expect(await head()).toBe(seed);
    expect(await exists('anime/a.md')).toBe(true);
    const r = await moveConcept(root, { id: 'anime/a', to: 'movies', list_status: 'complete' }, actor);
    expect(r.id).toBe('movies/a');
    expect(r.frontmatter).toMatchObject({ type: 'Movie', list_status: 'complete' });
    expect(await read('movies/index.md')).toContain('## Complete');
  });

  it('keeps a valid status across lists and allows a status change within the list', async () => {
    const r = await moveConcept(root, { id: 'anime/86-eighty-six', to: 'western-animation' }, actor);
    expect(r.frontmatter).toMatchObject({ type: 'Western Animation', list_status: 'to-watch' });
    const s = await moveConcept(root, { id: r.id, to: 'western-animation/sub', list_status: 'complete' }, actor);
    expect(s.frontmatter.list_status).toBe('complete');
  });

  it('rewrites incoming links in other concepts and the moved concept relative links', async () => {
    await moveConcept(root, { id: 'anime/virgin-punk-clockwork-girl', to: 'anime/punk', name: 'vp-cg' }, actor);
    const movie = await read('movies/clockwork-girl.md');
    expect(movie).toContain('[Virgin Punk: Clockwork Girl](/anime/punk/vp-cg.md)');
    const rc = await readConcept(root, { id: 'movies/clockwork-girl' });
    expect(rc.links).toEqual(['anime/punk/vp-cg']);
    expect((await readConcept(root, { id: 'anime/punk/vp-cg' })).backlinks).toEqual(['movies/clockwork-girl']);
    expect(await lastFiles()).toContain('movies/clockwork-girl.md');
    // relative link in the moved file is re-based
    await fs.writeFile(path.join(root, 'anime/rel.md'), '---\ntype: Anime\ntitle: Rel\nlist_status: to-watch\n---\n\n[x](../movies/clockwork-girl.md)\n');
    await moveConcept(root, { id: 'anime/rel', to: 'anime/deep/er' }, actor);
    expect(await read('anime/deep/er/rel.md')).toContain('(../../../movies/clockwork-girl.md)');
  });

  it('errors: bad target, unknown id, unparseable frontmatter, same place', async () => {
    const before = await head();
    await expect(moveConcept(root, { id: 'anime/86-eighty-six', to: '' }, actor)).rejects.toThrow(ToolError);
    await expect(moveConcept(root, { id: 'anime/86-eighty-six', to: '../x' }, actor)).rejects.toThrow(ToolError);
    await expect(moveConcept(root, { id: 'anime/nope', to: 'anime/x' }, actor)).rejects.toThrow(/No concept/);
    await expect(moveConcept(root, { id: 'anime/86-eighty-six', to: 'anime' }, actor)).rejects.toThrow('already at anime/86-eighty-six');
    expect(await head()).toBe(before);
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });
});

describe('relocateConcept', () => {
  it('moves without committing and returns dirs to regenerate', async () => {
    const before = await head();
    const { touchedDirs } = await relocateConcept(root, 'anime/86-eighty-six', 'anime/a/b/86-eighty-six', new Tx(root));
    expect(touchedDirs.sort()).toEqual(['anime', 'anime/a', 'anime/a/b']);
    expect(await head()).toBe(before);
    expect(await exists('anime/a/b/86-eighty-six.md')).toBe(true);
    expect(await exists('anime/86-eighty-six.md')).toBe(false);
  });
});

describe('deleteConcept', () => {
  it('previews without changing anything', async () => {
    const before = await head();
    const r = await deleteConcept(root, { id: 'anime/86-eighty-six' }, actor);
    expect(r).toEqual({ id: 'anime/86-eighty-six', title: '86 (Eighty-Six)', would_delete: { file: 'anime/86-eighty-six.md' }, confirm_required: true });
    expect(await deleteConcept(root, { id: 'anime/86-eighty-six', confirm: false }, actor)).toEqual(r);
    expect(await head()).toBe(before);
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });

  it('falls back to the file name for the title', async () => {
    await fs.writeFile(path.join(root, 'books/untitled-thing.md'), 'no frontmatter\n');
    const r = await deleteConcept(root, { id: 'books/untitled-thing' }, actor);
    expect(r).toMatchObject({ title: 'untitled-thing' });
  });

  it('deletes with confirm: one commit including the index, any status', async () => {
    const before = await count();
    const r = await deleteConcept(root, { id: 'anime/86-eighty-six', confirm: true }, actor);
    expect(r).toMatchObject({ id: 'anime/86-eighty-six', deleted: true });
    expect('commit' in r && r.commit).toBe(await head());
    expect(await exists('anime/86-eighty-six.md')).toBe(false);
    expect(await read('anime/index.md')).not.toContain('86-eighty-six.md');
    expect(await count()).toBe(before + 1);
    expect(await lastMsg()).toBe('Delete 86 (Eighty-Six)');
    expect(await lastAuthor()).toBe('agent <agent@dead-sea-scrolls.local>');
    expect(await lastFiles()).toEqual(['anime/86-eighty-six.md', 'anime/index.md']);
  });

  it('removes an emptied nested dir', async () => {
    await moveConcept(root, { id: 'anime/86-eighty-six', to: 'anime/gundam' }, actor);
    await deleteConcept(root, { id: 'anime/gundam/86-eighty-six', confirm: true }, actor);
    expect(await exists('anime/gundam')).toBe(false);
    expect(await read('anime/index.md')).not.toContain('## Folders');
  });

  it('errors on unknown id', async () => {
    await expect(deleteConcept(root, { id: 'anime/nope', confirm: true }, actor)).rejects.toThrow(/No concept/);
  });
});

describe('review fixes', () => {
  it('moves a root concept without frontmatter into a list, adding frontmatter', async () => {
    await fs.writeFile(path.join(root, 'orphan.md'), 'just text');
    const r = await moveConcept(root, { id: 'orphan', to: 'anime' }, actor);
    expect(r.id).toBe('anime/orphan');
    const text = await read('anime/orphan.md');
    expect(text.endsWith('just text')).toBe(true);
    const p = parseConceptText(text);
    expect(p.kind).toBe('ok');
    expect((p as any).data).toMatchObject({ type: 'Anime', title: 'orphan', generated: { by: 'agent' } });
    const c = await readConcept(root, { id: 'anime/orphan' });
    expect(c.problems).toEqual([]);
  });

  it('uses the first heading and given status for an unparseable root concept', async () => {
    await fs.writeFile(path.join(root, 'broken.md'), '---\ntitle: [oops\n---\n\n# Nice Title\n\nbody\n');
    const r = await moveConcept(root, { id: 'broken', to: 'anime', list_status: 'complete' }, actor);
    expect(r.frontmatter).toMatchObject({ title: 'Nice Title', list_status: 'complete', type: 'Anime' });
    expect(await read('anime/broken.md')).toContain('\n# Nice Title\n\nbody\n');
  });

  it('rejects moving through a symlinked directory', async () => {
    const outside = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'dss-out-'));
    try {
      await fs.symlink(outside, path.join(root, 'anime/esc'));
      await expect(moveConcept(root, { id: 'anime/86-eighty-six', to: 'anime/esc' }, actor)).rejects.toThrow(/symbolic link/);
      expect(await fs.readdir(outside)).toEqual([]);
      expect(await exists('anime/86-eighty-six.md')).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rewrites rooted self-links in the relocated file', async () => {
    const f = path.join(root, 'anime/86-eighty-six.md');
    await fs.appendFile(f, '\n[me](/anime/86-eighty-six.md) [rel](86-eighty-six.md)\n');
    await relocateConcept(root, 'anime/86-eighty-six', 'anime/sub/86-eighty-six', new Tx(root));
    const t = await read('anime/sub/86-eighty-six.md');
    expect(t).toContain('[me](/anime/sub/86-eighty-six.md)');
    expect(t).toContain('[rel](86-eighty-six.md)');
  });

  it('treats frontmatter {} without body as nothing to update', async () => {
    await expect(updateConcept(root, { id: 'anime/86-eighty-six', frontmatter: {} }, actor)).rejects.toThrow(/Nothing to update/);
  });
});

describe('review round 2', () => {
  it('rejects directory segments ending in .md', () => {
    expect(() => assertDirPath('anime/zz/index.md')).toThrow(/must not end in '.md'/);
    expect(() => assertConceptId('anime/x.md/y')).toThrow(/must not end in '.md'/);
    expect(() => assertConceptId('anime/index')).not.toThrow();
  });

  it('move_concept to a .md-named directory fails cleanly with nothing left behind', async () => {
    const before = await head();
    await expect(moveConcept(root, { id: 'anime/bubblegum-crash', to: 'anime/zz/index.md' }, actor)).rejects.toThrow(/\.md/);
    expect(await head()).toBe(before);
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });

  it('a failed transaction restores original bytes and keeps uncommitted edits', async () => {
    const phone = 'anime/gintama.md';
    const phoneText = (await read(phone)) + '\nphone edit not yet committed\n';
    await fs.writeFile(path.join(root, phone), phoneText);
    const indexBefore = await read('anime/index.md');
    await expect(
      inTx(root, async (tx) => {
        await tx.write('anime/index.md', 'clobbered\n');
        await tx.write('anime/new/thing.md', 'new\n');
        await tx.rename('anime/golden-boy.md', 'anime/new/golden-boy.md');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await read('anime/index.md')).toBe(indexBefore);
    expect(await exists('anime/golden-boy.md')).toBe(true);
    expect(await exists('anime/new')).toBe(false);
    expect(await read(phone)).toBe(phoneText);
    expect((await git(root, ['status', '--porcelain'])).trim()).toBe(`M ${phone}`);
  });

  it('MCP commits contain only their own paths, not unrelated uncommitted changes', async () => {
    const phone = 'anime/gintama.md';
    await fs.writeFile(path.join(root, phone), (await read(phone)) + '\nphone edit\n');
    await fs.writeFile(path.join(root, 'anime/stray.md'), '---\ntype: Anime\ntitle: Stray\nlist_status: to-watch\n---\n');
    await updateConcept(root, { id: 'books/infinite', frontmatter: { runtime: '300 pages' } }, actor);
    expect(await lastFiles()).toEqual(['books/infinite.md']);
    const st = await git(root, ['status', '--porcelain']);
    expect(st).toContain(phone);
    expect(st).toContain('anime/stray.md');
  });

  it('never writes an index through a symlink', async () => {
    const outside = path.join(await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'dss-out-')), 'outside.txt');
    try {
      await fs.writeFile(outside, 'untouched\n');
      await fs.rm(path.join(root, 'games/index.md'));
      await fs.symlink(outside, path.join(root, 'games/index.md'));
      await createConcept(root, { path: 'games', title: 'Hades' }, actor);
      expect(await fs.readFile(outside, 'utf8')).toBe('untouched\n');
    } finally {
      await fs.rm(path.dirname(outside), { recursive: true, force: true });
    }
  });

  it('keeps a __proto__ frontmatter key in summaries', async () => {
    await fs.writeFile(path.join(root, 'anime/proto.md'), '---\ntype: Anime\ntitle: Proto\nlist_status: to-watch\n__proto__: kept\n---\n');
    const d = await listDirectory(root, { path: 'anime' });
    const s = d.concepts.find((c: { id: string }) => c.id === 'anime/proto')!;
    expect(Object.prototype.hasOwnProperty.call(s, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
  });
});

describe('review round 3', () => {
  it('removes an emptied source folder outside any list after a move', async () => {
    await fs.mkdir(path.join(root, 'notes'));
    await fs.writeFile(path.join(root, 'notes/thing.md'), '---\ntype: Movie\ntitle: Thing\nlist_status: to-watch\n---\n');
    const r = await moveConcept(root, { id: 'notes/thing', to: 'movies' }, actor);
    expect(r.id).toBe('movies/thing');
    expect(await exists('notes')).toBe(false);
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });

  it('regenerates a hand-written index.md in an area like any other directory', async () => {
    await fs.mkdir(path.join(root, 'notes'));
    await fs.writeFile(path.join(root, 'notes/index.md'), 'my own notes\n');
    await fs.writeFile(path.join(root, 'notes/thing.md'), '---\ntype: Movie\ntitle: Thing\nlist_status: to-watch\n---\n');
    await deleteConcept(root, { id: 'notes/thing', confirm: true }, actor);
    expect(await read('notes/index.md')).toBe('# notes\n');
  });
});

describe('review round 4', () => {
  it('a phone folder named index.md does not count as an empty dir marker', async () => {
    await fs.mkdir(path.join(root, 'anime/g/index.md'), { recursive: true });
    await fs.writeFile(path.join(root, 'anime/g/z.md'), '---\ntype: Anime\ntitle: Z\nlist_status: to-watch\n---\n');
    await fs.writeFile(path.join(root, 'anime/g/index.md/n.md'), '---\ntype: Anime\ntitle: N\nlist_status: to-watch\n---\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', 'phone']);
    await moveConcept(root, { id: 'anime/g/z', to: 'anime' }, actor);
    expect(await exists('anime/z.md')).toBe(true);
    expect(await exists('anime/g/index.md/n.md')).toBe(true);
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });

  it('move with a case-only rename suffixes against a different file, not itself', async () => {
    await fs.writeFile(path.join(root, 'anime/Dune.md'), '---\ntype: Anime\ntitle: Dune\nlist_status: to-watch\n---\n');
    const r1 = await moveConcept(root, { id: 'anime/Dune', to: 'anime', name: 'dune' }, actor);
    expect(r1.id).toBe('anime/dune');
    await fs.writeFile(path.join(root, 'anime/Akira.md'), '---\ntype: Anime\ntitle: Akira\nlist_status: to-watch\n---\n');
    await fs.writeFile(path.join(root, 'anime/akira.md'), '---\ntype: Anime\ntitle: Akira\nlist_status: to-watch\n---\n');
    const r2 = await moveConcept(root, { id: 'anime/Akira', to: 'anime', name: 'akira' }, actor);
    expect(r2.id).toBe('anime/akira-2');
  });
});
