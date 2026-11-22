import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAll, git, SYSTEM_AUTHOR } from '../../src/git.js';
import { repairConcept } from '../../src/repair.js';
import { makeTempBundle } from '../helpers/bundle.js';

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await makeTempBundle({ git: true }));
});
afterEach(async () => {
  await cleanup();
});

async function put(rel: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
  await commitAll(root, `add ${rel}`, SYSTEM_AUTHOR);
}
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const lastMessage = async () => (await git(root, ['log', '-1', '--format=%s'])).trim();
const lastAuthor = async () => (await git(root, ['log', '-1', '--format=%an'])).trim();
const count = async () => Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim());

describe('repairConcept', () => {
  it('fixes a casual status in one commit with the exact message', async () => {
    await put('anime/frieren.md', '---\ntype: Anime\ntitle: Frieren\nlist_status: Watching\nextra: keep\n---\n\nBody here.\n');
    const before = await count();
    const r = await repairConcept(root, 'anime/frieren');
    expect(r.fixed).toEqual(["list_status 'Watching' -> 'in-progress'"]);
    expect(r.problems).toEqual([]);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await count()).toBe(before + 1);
    expect(await lastMessage()).toBe("Fix Frieren: list_status 'Watching' -> 'in-progress'");
    expect(await lastAuthor()).toBe('dead-sea-scrolls');
    expect(await read('anime/frieren.md')).toBe(
      '---\ntype: Anime\ntitle: Frieren\nlist_status: in-progress\nextra: keep\n---\n\nBody here.\n',
    );
  });

  it('leaves and flags an alias that is not allowed in the list', async () => {
    const text = '---\ntype: Anime\ntitle: Naruto\nlist_status: reading\n---\n';
    await put('anime/naruto.md', text);
    const before = await count();
    const r = await repairConcept(root, 'anime/naruto');
    expect(r.commit).toBeNull();
    expect(r.fixed).toEqual([]);
    expect(r.problems).toEqual(["invalid list_status 'reading' for anime"]);
    expect(await read('anime/naruto.md')).toBe(text);
    expect(await count()).toBe(before);
  });

  it('adds missing frontmatter with the title from the first heading, keeping the body', async () => {
    const body = 'Intro line\n\n# The Real Title\n\nText.\n';
    await put('movies/the-real-title.md', body);
    const r = await repairConcept(root, 'movies/the-real-title');
    expect(r.fixed).toEqual(['added frontmatter']);
    expect(r.problems).toEqual([]);
    expect(await lastMessage()).toBe('Fix The Real Title: added frontmatter');
    const out = await read('movies/the-real-title.md');
    expect(out).toContain('type: Movie');
    expect(out).toContain('title: The Real Title');
    expect(out).toContain('list_status: to-watch');
    expect(out.endsWith(body)).toBe(true);
  });

  it('uses the file name when there is no heading', async () => {
    await put('books/dune.md', 'just text\n');
    const r = await repairConcept(root, 'books/dune');
    expect(await lastMessage()).toBe('Fix dune: added frontmatter');
    expect(r.newId).toBe('books/dune');
    expect(await read('books/dune.md')).toContain('list_status: to-read');
  });

  it('fixes a wrong type', async () => {
    await put('games/hades.md', '---\ntype: Movie\ntitle: Hades\nlist_status: to-play\n---\n');
    const r = await repairConcept(root, 'games/hades');
    expect(r.fixed).toEqual(["type 'Movie' -> 'Game'"]);
    expect(await read('games/hades.md')).toContain('type: Game');
    expect(r.problems).toEqual([]);
  });

  it('adds a missing list_status', async () => {
    await put('series/andor.md', '---\ntype: Series\ntitle: Andor\n---\n');
    const r = await repairConcept(root, 'series/andor');
    expect(r.fixed).toEqual(["added list_status 'to-watch'"]);
    expect(await read('series/andor.md')).toContain('list_status: to-watch');
  });

  it('renames to the slug and rewrites incoming links, in one commit', async () => {
    await put('anime/frieren-x.md', '---\ntype: Anime\ntitle: Frieren\nlist_status: watching\n---\n');
    await put('anime/other.md', '---\ntype: Anime\ntitle: Other\nlist_status: to-watch\n---\n\nSee [Frieren](frieren-x.md).\n');
    const before = await count();
    const r = await repairConcept(root, 'anime/frieren-x');
    expect(r.newId).toBe('anime/frieren');
    expect(r.fixed).toEqual(["list_status 'watching' -> 'in-progress'", 'renamed frieren-x to frieren']);
    expect(await lastMessage()).toBe(
      "Fix Frieren: list_status 'watching' -> 'in-progress', renamed frieren-x to frieren",
    );
    expect(await count()).toBe(before + 1);
    await expect(fs.access(path.join(root, 'anime/frieren-x.md'))).rejects.toThrow();
    expect(await read('anime/frieren.md')).toContain('list_status: in-progress');
    expect(await read('anime/other.md')).toContain('(frieren.md)');
    expect(await git(root, ['status', '--porcelain'])).toBe('');
  });

  it('never touches unparseable YAML', async () => {
    const text = '---\ntitle: [unclosed\n---\nbody\n';
    await put('anime/broken.md', text);
    const before = await count();
    const r = await repairConcept(root, 'anime/broken');
    expect(r.commit).toBeNull();
    expect(r.problems.join(' ')).toContain('frontmatter does not parse');
    expect(await read('anime/broken.md')).toBe(text);
    expect(await count()).toBe(before);
  });

  it('never touches a file at the bundle root', async () => {
    const text = '# Stray\n\nnotes\n';
    await put('stray.md', text);
    const r = await repairConcept(root, 'stray');
    expect(r.commit).toBeNull();
    expect(r.fixed).toEqual([]);
    expect(r.problems).toContain('concept is at the bundle root, not in a list');
    expect(await read('stray.md')).toBe(text);
  });

  it('does not rename a concept titled Index onto index.md (nested dir)', async () => {
    await put('anime/sub/old-name.md', '---\ntype: Anime\ntitle: Index\nlist_status: backlog\n---\n\nBody.\n');
    const r = await repairConcept(root, 'anime/sub/old-name');
    expect(r.newId).not.toBe('anime/sub/index');
    expect(r.newId).toMatch(/^anime\/sub\/index-/);
    expect(await read(`${r.newId}.md`)).toContain('title: Index');
  });

  it('keeps a trailing # that is part of the heading title', async () => {
    await put('movies/x.md', '# Learn C#\n\nText.\n');
    await repairConcept(root, 'movies/x');
    expect(await read('movies/learn-c.md').catch(() => '')).toContain('title: Learn C#');
  });

  it('strips a closing # sequence preceded by whitespace', async () => {
    await put('movies/y.md', '# Closed Title ##\n\nText.\n');
    await repairConcept(root, 'movies/y');
    expect(await read('movies/closed-title.md')).toContain('title: Closed Title\n');
  });

  it('falls back to the file name in the commit message when the title is missing', async () => {
    await put('anime/untitled-thing.md', '---\ntype: Anime\nlist_status: Watching\n---\n\nBody.\n');
    const r = await repairConcept(root, 'anime/untitled-thing');
    expect(r.commit).not.toBeNull();
    expect(await lastMessage()).toMatch(/^Fix untitled-thing: /);
  });
});

describe('review round 3', () => {
  it('lowercases a capitalised phone file name without a -2 suffix', async () => {
    await fs.writeFile(path.join(root, 'anime/Dune.md'), '# Dune\n\nPhone note.\n');
    const r = await repairConcept(root, 'anime/Dune');
    expect(r.newId).toBe('anime/dune');
    expect(r.problems).toEqual([]);
  });

  it('still suffixes when another file really takes the name', async () => {
    await fs.writeFile(path.join(root, 'anime/Gintama Copy.md'), '---\ntype: Anime\ntitle: Gintama\nlist_status: to-watch\n---\n');
    const r = await repairConcept(root, 'anime/Gintama Copy');
    expect(r.newId).toBe('anime/gintama-2');
  });
});
