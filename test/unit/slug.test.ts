import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileNameMatchesTitle, slugify, uniqueName } from '../../src/domain/slug.js';
import { scanBundle } from '../../src/bundle/scan.js';
import { makeTempBundle } from '../helpers/bundle.js';

describe('slugify', () => {
  it.each([
    ['86 (Eighty-Six)', '86-eighty-six'],
    ['Evangelion: 3.0 (-120 min.)', 'evangelion-3-0-120-min'],
    ['Æon Flux', 'aeon-flux'],
    ['Pokémon', 'pokemon'],
    ['Straße Øl Łódź Þor Đa ınk Œuvre', 'strasse-ol-lodz-thor-da-ink-oeuvre'],
    ['  --  ', ''],
  ])('%s -> %s', (t, s) => expect(slugify(t)).toBe(s));

  it('uniqueName suffixes', () => {
    const taken = new Set(['a', 'a-2']);
    expect(uniqueName('b', (n) => taken.has(n))).toBe('b');
    expect(uniqueName('a', (n) => taken.has(n))).toBe('a-3');
  });

  it('fileNameMatchesTitle', () => {
    expect(fileNameMatchesTitle('aeon-flux', 'Æon Flux')).toBe(true);
    expect(fileNameMatchesTitle('aeon-flux-2', 'Æon Flux')).toBe(true);
    expect(fileNameMatchesTitle('aeon-flux-1', 'Æon Flux')).toBe(false);
    expect(fileNameMatchesTitle('other', 'Æon Flux')).toBe(false);
    expect(fileNameMatchesTitle('untitled', '!!!')).toBe(true);
  });
});

describe('migrated bundle', () => {
  let b: Awaited<ReturnType<typeof makeTempBundle>>;
  beforeAll(async () => { b = await makeTempBundle(); });
  afterAll(async () => { await b.cleanup(); });
  it('every file name equals slugify(title)', async () => {
    const snap = await scanBundle(b.root);
    expect(snap.concepts.size).toBe(96);
    for (const c of snap.concepts.values()) {
      expect(c.name, c.id).toBe(slugify(String(c.frontmatter!.title)));
    }
    await fs.access(path.join(b.root, 'index.md'));
  });
});

describe('slug length cap', () => {
  const title = 'Long title word '.repeat(20);
  it('caps at 100 chars without trailing dash', () => {
    const s = slugify(title);
    expect(title.length).toBeGreaterThan(300 - 1);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith('-')).toBe(false);
    expect(fileNameMatchesTitle(s, title)).toBe(true);
    expect(fileNameMatchesTitle(`${s}-2`, title)).toBe(true);
  });
  it('handles a 300-char single word', () => {
    expect(slugify('a'.repeat(300))).toBe('a'.repeat(100));
  });
});
