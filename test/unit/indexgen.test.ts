import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { regenerateIndexes } from '../../src/bundle/indexgen.js';
import { LISTS } from '../../src/domain/lists.js';
import { makeTempBundle } from '../helpers/bundle.js';

let b: Awaited<ReturnType<typeof makeTempBundle>>;
let orig: Record<string, string>;
beforeEach(async () => {
  b = await makeTempBundle();
  orig = {};
  for (const l of LISTS) orig[l] = await fs.readFile(path.join(b.root, l, 'index.md'), 'utf8');
});
afterEach(async () => { await b.cleanup(); });

const read = (rel: string) => fs.readFile(path.join(b.root, rel), 'utf8');
const write = (rel: string, t: string) => fs.writeFile(path.join(b.root, rel), t);
const concept = (title: string, status: string, desc?: string) =>
  `---\ntype: Anime\ntitle: ${JSON.stringify(title)}\n${desc ? `description: ${JSON.stringify(desc)}\n` : ''}list_status: ${status}\n---\n\nBody\n`;

async function firstOf(list: string, status: string): Promise<string> {
  const files = (await fs.readdir(path.join(b.root, list))).filter((f) => f !== 'index.md');
  for (const f of files) {
    if ((await read(`${list}/${f}`)).includes(`list_status: ${status}\n`)) return f;
  }
  throw new Error('none');
}

describe('regenerateIndexes', () => {
  it('is a byte-identical no-op on every migrated list', async () => {
    expect(await regenerateIndexes(b.root, [...LISTS])).toEqual([]);
    for (const l of LISTS) expect(await read(`${l}/index.md`)).toBe(orig[l]);
  });

  it('moves a re-statused entry to the end of the new section and drops an emptied one', async () => {
    const f = await firstOf('anime', 'caught-up');
    const text = await read(`anime/${f}`);
    const caughtUp = (orig.anime!.match(/## Caught Up\n\n((?:\* .*\n?)+)/)![1]!).trim().split('\n');
    const targetsAll = text.replace('list_status: caught-up', 'list_status: complete');
    await write(`anime/${f}`, targetsAll);
    const written = await regenerateIndexes(b.root, ['anime']);
    expect(written).toEqual(['anime/index.md']);
    const out = await read('anime/index.md');
    const completeBlock = out.split('## Complete\n\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(completeBlock.at(-1)).toContain(`(${f.replace(/\.md$/, '')}.md)`);
    if (caughtUp.length === 1) expect(out).not.toContain('## Caught Up');
  });

  it('drops a section when its last entry changes status', async () => {
    expect(orig.books!.match(/## Skipped\n\n(\* .*\n)\n?/)).not.toBeNull();
    const f = await firstOf('books', 'skipped');
    const t = await read(`books/${f}`);
    await write(`books/${f}`, t.replace('list_status: skipped', 'list_status: dropped'));
    await regenerateIndexes(b.root, ['books']);
    const out = await read('books/index.md');
    expect(out).not.toContain('## Skipped');
    const dropped = out.split('## Dropped\n\n')[1]!.split('\n\n')[0]!.trim().split('\n');
    expect(dropped.at(-1)).toContain(`(${f})`);
  });

  it('inserts a new status section in list order', async () => {
    await write('anime/new-show.md', concept('New Show', 'in-progress', 'Fresh.'));
    expect(orig.anime).not.toContain('## In Progress');
    await regenerateIndexes(b.root, ['anime']);
    const out = await read('anime/index.md');
    const heads = [...out.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    expect(heads.indexOf('In Progress')).toBe(heads.indexOf('To Watch') + 1);
    expect(heads.indexOf('In Progress')).toBeLessThan(heads.indexOf('Complete'));
    expect(out).toContain('* [New Show](new-show.md) - Fresh.');
  });

  it('removes a deleted concept', async () => {
    const f = (await fs.readdir(path.join(b.root, 'movies'))).find((x) => x !== 'index.md')!;
    await fs.rm(path.join(b.root, 'movies', f));
    expect(await regenerateIndexes(b.root, ['movies'])).toEqual(['movies/index.md']);
    expect(await read('movies/index.md')).not.toContain(`(${f})`);
  });

  it('gives a nested dir its own index and a Folders section in the parent', async () => {
    await fs.mkdir(path.join(b.root, 'anime/gundam'));
    await write('anime/gundam/zeta.md', concept('Zeta', 'complete'));
    const written = await regenerateIndexes(b.root, ['anime/gundam']);
    expect(written).toEqual(['anime/gundam/index.md', 'anime/index.md']);
    expect(await read('anime/gundam/index.md')).toBe('# gundam\n\n## Complete\n\n* [Zeta](zeta.md)\n');
    const out = await read('anime/index.md');
    expect(out.endsWith('\n\n## Folders\n\n* [gundam](gundam/) - 1 title\n')).toBe(true);
    expect(await regenerateIndexes(b.root, ['anime/gundam'])).toEqual([]);
  });

  it('puts invalid statuses under Unsorted, after status sections and before Folders', async () => {
    await write('books/odd.md', concept('Odd', 'watching'));
    await write('books/nofm.md', 'just text\n');
    await regenerateIndexes(b.root, ['books']);
    const out = await read('books/index.md');
    expect(out).toContain('## Unsorted\n\n* [nofm](nofm.md)\n* [Odd](odd.md)\n');
    expect(out.indexOf('## Unsorted')).toBeGreaterThan(out.lastIndexOf('## To Read'));
  });

  it('refreshes title and description in place', async () => {
    const f = await firstOf('series', 'to-watch');
    const name = f.replace(/\.md$/, '');
    const before = orig.series!.split('\n');
    const pos = before.findIndex((l) => l.includes(`(${f})`));
    const t = await read(`series/${f}`);
    await write(
      `series/${f}`,
      t.replace(/^title: .*$/m, 'title: "Renamed"').replace(/^description: .*$/m, 'description: "line one\\nline two"'),
    );
    await regenerateIndexes(b.root, ['series']);
    const after = (await read('series/index.md')).split('\n');
    expect(after[pos]).toBe(`* [Renamed](${name}.md) - line one line two`);
    expect(after.length).toBe(before.length);
  });

  it('does not overwrite an index.md that starts with frontmatter', async () => {
    await fs.mkdir(path.join(b.root, 'anime/sub'), { recursive: true });
    const text = '---\ntype: Anime\ntitle: Index\nlist_status: backlog\n---\n\nReal concept.\n';
    await write('anime/sub/index.md', text);
    await write('anime/sub/other.md', concept('Other', 'backlog'));
    const written = await regenerateIndexes(b.root, ['anime/sub']);
    expect(written).not.toContain('anime/sub/index.md');
    expect(await read('anime/sub/index.md')).toBe(text);
  });
});
