import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildConceptText, parseConceptText, replaceBody, replaceFrontmatter, setFrontmatterKeys,
} from '../../src/bundle/frontmatter.js';
import { scanBundle } from '../../src/bundle/scan.js';
import { makeTempBundle } from '../helpers/bundle.js';

const SAMPLE = `---
type: Anime
title: 86 (Eighty-Six)
list_status: to-watch
runtime: '1979'
extra: keep # trailing comment
generated:
  by: agent/migration
  at: '2026-11-15T16:52:11Z'
---

Body here.
`;

describe('parseConceptText', () => {
  it('ok', () => {
    const p = parseConceptText(SAMPLE);
    expect(p.kind).toBe('ok');
    if (p.kind !== 'ok') return;
    expect(p.data.title).toBe('86 (Eighty-Six)');
    expect(p.data.runtime).toBe('1979');
    expect(p.data.generated).toEqual({ by: 'agent/migration', at: '2026-11-15T16:52:11Z' });
    expect(p.body).toBe('Body here.\n');
  });
  it('missing', () => {
    expect(parseConceptText('# Hi\n')).toEqual({ kind: 'missing', body: '# Hi\n' });
  });
  it('unparseable: no closing, bad yaml, non-mapping', () => {
    expect(parseConceptText('---\ntitle: x\n').kind).toBe('unparseable');
    const bad = parseConceptText('---\ntitle: [unclosed\n---\n\nbody\n');
    expect(bad.kind).toBe('unparseable');
    if (bad.kind === 'unparseable') {
      expect(bad.error.length).toBeGreaterThan(0);
      expect(bad.body).toBe('body\n');
    }
    expect(parseConceptText('---\n- a\n- b\n---\nx').kind).toBe('unparseable');
    expect(parseConceptText('---\n---\nx').kind).toBe('unparseable');
  });
  it('BOM and CRLF', () => {
    const t = '﻿---\r\ntitle: A\r\nlist_status: to-watch\r\n---\r\n\r\nbody\r\n';
    const p = parseConceptText(t);
    expect(p.kind).toBe('ok');
    if (p.kind === 'ok') {
      expect(p.data.title).toBe('A');
      expect(p.body).toBe('body\r\n');
    }
    const out = setFrontmatterKeys(t, { list_status: 'complete' });
    expect(out).toBe(t.replace('to-watch', 'complete'));
    const added = setFrontmatterKeys(t, { tags: ['a'] });
    expect(added.startsWith('﻿---\r\n')).toBe(true);
    expect(added).not.toMatch(/[^\r]\n/);
  });
});

describe('setFrontmatterKeys', () => {
  it('empty patch is byte-identical', () => {
    expect(setFrontmatterKeys(SAMPLE, {})).toBe(SAMPLE);
  });
  it('changes only the touched line', () => {
    expect(setFrontmatterKeys(SAMPLE, { list_status: 'complete' })).toBe(SAMPLE.replace('to-watch', 'complete'));
  });
  it('appends new keys, deletes undefined', () => {
    const out = setFrontmatterKeys(SAMPLE, { tags: ['x', 'y'], runtime: undefined });
    const p = parseConceptText(out);
    expect(p.kind).toBe('ok');
    if (p.kind !== 'ok') return;
    expect(p.data.tags).toEqual(['x', 'y']);
    expect('runtime' in p.data).toBe(false);
    expect(Object.keys(p.data).at(-1)).toBe('tags');
    expect(out).toContain("at: '2026-11-15T16:52:11Z'");
    expect(out).toContain('extra: keep # trailing comment');
    expect(out.endsWith('\n\nBody here.\n')).toBe(true);
  });
  it('does not fold long values', () => {
    const long = 'word '.repeat(60).trim();
    expect(setFrontmatterKeys(SAMPLE, { description: long })).toContain(`description: ${long}\n`);
  });
  it('throws on unparseable input', () => {
    expect(() => setFrontmatterKeys('no fm', { a: 1 })).toThrow();
  });
});

describe('replace/build', () => {
  it('buildConceptText shape', () => {
    expect(buildConceptText({ title: 'A' }, '')).toBe('---\ntitle: A\n---\n');
    expect(buildConceptText({ title: 'A' }, 'hi')).toBe('---\ntitle: A\n---\n\nhi\n');
  });
  it('round trip', () => {
    const p = parseConceptText(SAMPLE);
    if (p.kind !== 'ok') throw new Error('x');
    const again = parseConceptText(buildConceptText(p.data, p.body));
    expect(again).toEqual(p);
  });
  it('replaceBody keeps frontmatter bytes', () => {
    const out = replaceBody(SAMPLE, 'New');
    expect(out.startsWith(SAMPLE.slice(0, SAMPLE.indexOf('Body here.')))).toBe(true);
    expect(out.endsWith('---\n\nNew\n')).toBe(true);
    expect(replaceBody(SAMPLE, '')).toBe(SAMPLE.slice(0, SAMPLE.indexOf('---\n\nBody') + 4));
  });
  it('replaceFrontmatter keeps body', () => {
    const out = replaceFrontmatter(SAMPLE, { type: 'Anime', title: 'T', list_status: 'to-watch' });
    expect(out).toBe('---\ntype: Anime\ntitle: T\nlist_status: to-watch\n---\n\nBody here.\n');
    const broken = '---\ntitle: [oops\n---\n\nkeep me\n';
    expect(replaceFrontmatter(broken, { title: 'T' })).toBe('---\ntitle: T\n---\n\nkeep me\n');
    expect(replaceFrontmatter('plain\n', { title: 'T' })).toBe('---\ntitle: T\n---\n\nplain\n');
  });
});

describe('migrated bundle', () => {
  let b: Awaited<ReturnType<typeof makeTempBundle>>;
  beforeAll(async () => { b = await makeTempBundle(); });
  afterAll(async () => { await b.cleanup(); });
  it('empty patch is byte-identical and parse/build is stable for every concept', async () => {
    const snap = await scanBundle(b.root);
    for (const c of snap.concepts.values()) {
      const raw = await fs.readFile(path.join(b.root, c.file), 'utf8');
      expect(setFrontmatterKeys(raw, {}), c.id).toBe(raw);
      const p = parseConceptText(raw);
      expect(p.kind, c.id).toBe('ok');
      if (p.kind !== 'ok') continue;
      const rebuilt = parseConceptText(buildConceptText(p.data, p.body));
      expect(rebuilt, c.id).toEqual(p);
      // re-setting the same value keeps the bytes
      const same = setFrontmatterKeys(raw, { list_status: p.data.list_status });
      expect(same, c.id).toBe(raw);
    }
  });
});

describe('parseConceptText never throws', () => {
  const bomb = '---\ntitle: x\nbase: &a [1]\n' + Array.from({ length: 150 }, (_, i) => `k${i}: *a\n`).join('') + '---\n';
  it.each([
    ['unresolved alias', '---\ntitle: T\ndescription: *great\n---\n'],
    ['alias bomb', bomb],
  ])('%s is unparseable', (_n, text) => {
    const p = parseConceptText(text);
    expect(p.kind).toBe('unparseable');
    expect(() => setFrontmatterKeys(text, { a: 1 })).toThrow(/parseable frontmatter/);
  });

  it('scan flags such concepts and still lists the others', async () => {
    const b = await makeTempBundle();
    try {
      await fs.writeFile(path.join(b.root, 'anime', 'zz-alias.md'), '---\ntitle: T\ndescription: *great\n---\n');
      await fs.writeFile(path.join(b.root, 'anime', 'zz-bomb.md'), bomb);
      const snap = await scanBundle(b.root);
      expect(snap.concepts.size).toBe(98);
      for (const id of ['anime/zz-alias', 'anime/zz-bomb']) {
        expect(snap.concepts.get(id)!.problems.some((p) => p.startsWith('frontmatter does not parse: '))).toBe(true);
      }
    } finally {
      await b.cleanup();
    }
  });
});
