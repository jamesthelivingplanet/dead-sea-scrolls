import { describe, expect, it } from 'vitest';
import { computeProblems } from '../../src/bundle/problems.js';
import type { Concept } from '../../src/bundle/scan.js';
import { parseConceptText } from '../../src/bundle/frontmatter.js';

function mk(file: string, raw: string): Omit<Concept, 'problems'> {
  const id = file.slice(0, -3);
  const slash = id.lastIndexOf('/');
  const dir = slash === -1 ? '' : id.slice(0, slash);
  const top = id.split('/')[0]!;
  const list = (['anime', 'western-animation', 'movies', 'series', 'books', 'games'] as const).find((l) => l === top && dir !== '') ?? null;
  const p = parseConceptText(raw);
  return {
    id, file, dir, name: id.slice(slash + 1), list, raw,
    frontmatter: p.kind === 'ok' ? p.data : null, frontmatterState: p.kind, body: p.body,
  };
}

const fm = (o: string) => `---\n${o}---\n\nbody\n`;

describe('computeProblems', () => {
  it('clean concept', () => {
    expect(computeProblems(mk('anime/a.md', fm('type: Anime\ntitle: A\nlist_status: to-watch\n')))).toEqual([]);
  });
  it('no frontmatter', () => {
    expect(computeProblems(mk('anime/a.md', '# A\n'))).toEqual(['no frontmatter']);
  });
  it('unparseable', () => {
    const p = computeProblems(mk('anime/a.md', '---\ntitle: [x\n---\n'));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^frontmatter does not parse: .+/);
  });
  it('root and non-list', () => {
    expect(computeProblems(mk('a.md', fm('type: Anime\ntitle: A\nlist_status: to-watch\n')))).toEqual([
      'concept is at the bundle root, not in a list',
    ]);
    // an area needs only a title (and a valid status if present)
    expect(computeProblems(mk('misc/sub/a.md', fm('title: A\n')))).toEqual([]);
    expect(computeProblems(mk('notes/a.md', fm('type: Note\ntitle: A\nstatus: stable\n')))).toEqual([]);
    expect(computeProblems(mk('notes/a.md', fm('title: A\nstatus: wip\n')))).toEqual([
      "invalid status 'wip' (allowed: draft, stable, deprecated)",
    ]);
    expect(computeProblems(mk('notes/a.md', fm('type: Note\n')))).toEqual(['missing title']);
  });
  it('title, type, status', () => {
    expect(computeProblems(mk('movies/a.md', fm('list_status: watching\n')))).toEqual([
      'missing title',
      "missing type, should be 'Movie'",
      "invalid list_status 'watching' for movies",
    ]);
    expect(computeProblems(mk('books/a.md', fm('type: Anime\ntitle: A\n')))).toEqual([
      "type 'Anime' should be 'Book' for books",
      'missing list_status',
    ]);
  });
  it('file name vs title is not a problem', () => {
    expect(computeProblems(mk('anime/zzz.md', fm('type: Anime\ntitle: A\nlist_status: complete\n')))).toEqual([]);
  });
});

describe('tags and title types', () => {
  const base = 'type: Anime\nlist_status: to-watch\n';
  it('flags non-list tags and non-string title', () => {
    expect(computeProblems(mk('anime/a.md', fm(`${base}title: T\ntags: foo\n`)))).toContain('tags should be a list of strings');
    expect(computeProblems(mk('anime/a.md', fm(`${base}title: T\ntags: [a, 1]\n`)))).toContain('tags should be a list of strings');
    expect(computeProblems(mk('anime/a.md', fm(`${base}title: 42\n`)))).toEqual(['title should be text']);
    expect(computeProblems(mk('anime/a.md', fm(`${base}title: T\ntags: [a, b]\n`)))).toEqual([]);
  });
});
