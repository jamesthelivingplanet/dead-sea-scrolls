import { describe, it, expect } from 'vitest';
import {
  findLinks,
  resolveLink,
  resolveWikilink,
  linksOf,
  rewriteIncoming,
  rewriteOutgoing,
} from '../../src/bundle/links.js';

const ids = new Set([
  'anime/evangelion-3-0-46h',
  'anime/evangelion-3-0-120-min',
  'anime/gundam/zeta',
  'anime/gundam/seed',
  'movies/akira',
  'movies/zeta',
  'books/dune',
  'anime/dune',
  'books/some dir/with space',
]);

describe('findLinks (markdown)', () => {
  it('finds the real bundle-rooted example', () => {
    const t = '* [Evangelion: 3.0 (-46h)](/anime/evangelion-3-0-46h.md)';
    const [l] = findLinks(t);
    expect(l).toMatchObject({ kind: 'md', start: 2, end: t.length, target: '/anime/evangelion-3-0-46h.md' });
    expect(l!.text).toBe(t.slice(2));
    expect(resolveLink('anime/index.md', l!, ids)).toBe('anime/evangelion-3-0-46h');
  });

  it('handles titles, angle brackets, fragments, queries and encoding', () => {
    const t = '[a](x.md "T") [b](<with space.md>) [c](y.md#h) [d](z.md?q=1) [e](with%20space.md)';
    const ls = findLinks(t);
    expect(ls.map((l) => l.target)).toEqual(['x.md', 'with space.md', 'y.md#h', 'z.md?q=1', 'with%20space.md']);
  });

  it('ignores non-md targets, URLs, images', () => {
    const t = '[a](https://x.com/a.md) [b](mailto:a@b.md) [c](pic.png) ![d](e.md) [f](page.html#x.md)';
    expect(findLinks(t)).toEqual([]);
  });

  it('is case-insensitive on the extension', () => {
    expect(findLinks('[a](X.MD)')).toHaveLength(1);
  });

  it('ignores links in fenced code and inline code', () => {
    const t = [
      '[in](a.md)',
      '```',
      '[no](b.md)',
      '[[nope]]',
      '```',
      '`[no](c.md)` and ``[[d]] ` x`` then [yes](e.md)',
      '~~~md',
      '[no](f.md)',
      '~~~',
      '[[g]]',
    ].join('\n');
    expect(findLinks(t).map((l) => l.target)).toEqual(['a.md', 'e.md', 'g']);
  });

  it('an unclosed fence hides the rest, unclosed backtick does not', () => {
    expect(findLinks('[a](a.md)\n```\n[b](b.md)')).toHaveLength(1);
    expect(findLinks('a ` [b](b.md)')).toHaveLength(1);
  });

  it('supports balanced parens and nested brackets in the label', () => {
    expect(findLinks('[a [b] c](x.md)')).toHaveLength(1);
    expect(findLinks('[a](x(1).md)')[0]!.target).toBe('x(1).md');
  });
});

describe('findLinks (wikilinks)', () => {
  it('parses all forms', () => {
    const t = '[[a]] [[p/b]] [[c|al]] [[d#h]] [[e#h|al]] [[f.md]] ![[g]]';
    expect(findLinks(t).map((l) => [l.kind, l.target])).toEqual([
      ['wiki', 'a'],
      ['wiki', 'p/b'],
      ['wiki', 'c'],
      ['wiki', 'd'],
      ['wiki', 'e'],
      ['wiki', 'f'],
      ['wiki', 'g'],
    ]);
  });
  it('embed start is at the brackets', () => {
    const [l] = findLinks('x ![[g]]');
    expect(l!.start).toBe(3);
    expect(l!.text).toBe('[[g]]');
  });
  it('skips same-note heading links', () => {
    expect(findLinks('[[#heading]]')).toEqual([]);
  });
});

describe('resolveLink', () => {
  const link = (t: string) => findLinks(t)[0]!;
  it('resolves relative paths', () => {
    expect(resolveLink('anime/a.md', link('[x](gundam/zeta.md)'), ids)).toBe('anime/gundam/zeta');
    expect(resolveLink('anime/gundam/a.md', link('[x](../evangelion-3-0-46h.md)'), ids)).toBe('anime/evangelion-3-0-46h');
    expect(resolveLink('anime/a.md', link('[x](./gundam/../gundam/seed.md#h)'), ids)).toBe('anime/gundam/seed');
    expect(resolveLink('books/a.md', link('[x](some%20dir/with%20space.md)'), ids)).toBe('books/some dir/with space');
    expect(resolveLink('books/a.md', link('[x](<some dir/with space.md>)'), ids)).toBe('books/some dir/with space');
  });
  it('rooted ignores the linking dir', () => {
    expect(resolveLink('books/deep/a.md', link('[x](/movies/akira.md)'), ids)).toBe('movies/akira');
  });
  it('escaping the bundle root is null', () => {
    expect(resolveLink('anime/a.md', link('[x](../../../movies/akira.md)'), ids)).toBeNull();
    expect(resolveLink('a.md', link('[x](../movies/akira.md)'), ids)).toBeNull();
  });
  it('unknown target is null', () => {
    expect(resolveLink('anime/a.md', link('[x](nothing.md)'), ids)).toBeNull();
  });
});

describe('resolveWikilink', () => {
  it('path form: exact, else suffix', () => {
    expect(resolveWikilink('anime/gundam/zeta', ids)).toBe('anime/gundam/zeta');
    expect(resolveWikilink('gundam/zeta', ids)).toBe('anime/gundam/zeta');
    expect(resolveWikilink('gundam/zeta.md', ids)).toBe('anime/gundam/zeta');
    expect(resolveWikilink('nope/zeta', ids)).toBeNull();
  });
  it('suffix must match on a segment boundary', () => {
    expect(resolveWikilink('undam/zeta', ids)).toBeNull();
  });
  it('bare name: unique', () => {
    expect(resolveWikilink('akira', ids)).toBe('movies/akira');
    expect(resolveWikilink('seed', ids)).toBe('anime/gundam/seed');
  });
  it('bare name: ambiguous picks shortest, then alphabetical', () => {
    expect(resolveWikilink('zeta', ids)).toBe('movies/zeta'); // 2 segments beats 3
    expect(resolveWikilink('dune', ids)).toBe('anime/dune'); // tie -> alphabetical
  });
  it('is case-insensitive but prefers exact case', () => {
    expect(resolveWikilink('AKIRA', ids)).toBe('movies/akira');
    const s = new Set(['a/Foo', 'b/foo']);
    expect(resolveWikilink('foo', s)).toBe('b/foo');
    expect(resolveWikilink('Foo', s)).toBe('a/Foo');
  });
  it('null for unknown', () => {
    expect(resolveWikilink('ghost', ids)).toBeNull();
  });
});

describe('linksOf', () => {
  it('dedupes, keeps order, drops unresolved, mixes both kinds', () => {
    const t = '[[akira]] [a](/books/dune.md) [[ghost]] [b](missing.md) ![[akira]] [[books/dune|d]] [[seed#h]]';
    expect(linksOf('anime/a.md', t, ids)).toEqual(['movies/akira', 'books/dune', 'anime/gundam/seed']);
  });
  it('skips code', () => {
    expect(linksOf('a.md', '`[[akira]]`\n```\n[[dune]]\n```', ids)).toEqual([]);
  });
});

describe('rewriteIncoming', () => {
  // movie anime/gundam/zeta -> movies/zeta2 etc.
  it('keeps rooted style', () => {
    const after = new Set([...ids].filter((i) => i !== 'anime/evangelion-3-0-46h').concat('western-animation/eva'));
    const t = '* [Evangelion: 3.0 (-46h)](/anime/evangelion-3-0-46h.md) - desc';
    expect(rewriteIncoming('anime/index.md', t, 'anime/evangelion-3-0-46h', 'western-animation/eva', after)).toBe(
      '* [Evangelion: 3.0 (-46h)](/western-animation/eva.md) - desc',
    );
  });

  it('recomputes relative links from a file in another directory', () => {
    const after = new Set(['movies/akira2', 'books/dune', 'books/a']);
    const t = 'see [A](../movies/akira.md#top "title") and [B](../books/dune.md)';
    expect(rewriteIncoming('books/a.md', t, 'movies/akira', 'movies/akira2', after)).toBe(
      'see [A](../movies/akira2.md#top "title") and [B](../books/dune.md)',
    );
    const after2 = new Set(['anime/gundam/akira', 'books/a']);
    expect(rewriteIncoming('books/a.md', '[A](../movies/akira.md)', 'movies/akira', 'anime/gundam/akira', after2)).toBe(
      '[A](../anime/gundam/akira.md)',
    );
    // same dir as the new location
    const after3 = new Set(['anime/akira', 'anime/a']);
    expect(rewriteIncoming('anime/a.md', '[A](../movies/akira.md)', 'movies/akira', 'anime/akira', after3)).toBe('[A](akira.md)');
  });

  it('keeps angle brackets and encoding style', () => {
    const after = new Set(['movies/new name', 'books/a']);
    expect(rewriteIncoming('books/a.md', '[x](<../movies/old name.md>)', 'movies/old name', 'movies/new name', after)).toBe(
      '[x](<../movies/new name.md>)',
    );
    expect(rewriteIncoming('books/a.md', '[x](../movies/old%20name.md)', 'movies/old name', 'movies/new name', after)).toBe(
      '[x](../movies/new%20name.md)',
    );
    // unencoded + unbracketed + new path with a space -> angle brackets
    expect(rewriteIncoming('books/a.md', '[x](../movies/old.md)', 'movies/old', 'movies/new name', after)).toBe(
      '[x](<../movies/new name.md>)',
    );
  });

  it('wikilinks: bare stays bare when unique, else full id', () => {
    const after = new Set(['western-animation/akira', 'books/dune', 'anime/dune', 'x/a']);
    const t = '[[akira]] [[akira#h|al]] ![[akira]] [[movies/akira]] [[dune]]';
    expect(rewriteIncoming('x/a.md', t, 'movies/akira', 'western-animation/akira', after)).toBe(
      '[[akira]] [[akira#h|al]] ![[akira]] [[western-animation/akira]] [[dune]]',
    );
  });

  it('wikilinks: rename keeps heading and alias, new name used', () => {
    const after = new Set(['movies/akira-1988', 'x/a']);
    expect(rewriteIncoming('x/a.md', '[[akira#h|al]] [[akira.md]]', 'movies/akira', 'movies/akira-1988', after)).toBe(
      '[[akira-1988#h|al]] [[akira-1988.md]]',
    );
  });

  it('wikilinks: bare new name ambiguous -> full id', () => {
    // moving books/dune to anime/zeta-ish where "zeta" would resolve elsewhere
    const after = new Set(['c/zeta', 'b/q/zeta', 'x/a']);
    // before the move [[zeta]] meant a/zeta; afterwards bare "zeta" would resolve to c/zeta, so write the full id
    expect(rewriteIncoming('x/a.md', '[[zeta]]', 'a/zeta', 'b/q/zeta', after)).toBe('[[b/q/zeta]]');
  });

  it('leaves links to other concepts untouched', () => {
    const after = new Set(['movies/akira2', 'books/dune', 'books/a']);
    const t = 'x [[dune]] [d](dune.md) [i](https://e.com/a.md) `[[akira]]`\n';
    expect(rewriteIncoming('books/a.md', t, 'movies/akira', 'movies/akira2', after)).toBe(t);
  });

  it('does not touch code blocks', () => {
    const after = new Set(['movies/akira2', 'books/a']);
    const t = '```\n[x](/movies/akira.md)\n```\n[y](/movies/akira.md)';
    expect(rewriteIncoming('books/a.md', t, 'movies/akira', 'movies/akira2', after)).toBe(
      '```\n[x](/movies/akira.md)\n```\n[y](/movies/akira2.md)',
    );
  });

  it('self-links in the moved file (fromFile = old location)', () => {
    const after = new Set(['anime/gundam/x']);
    const t = 'me [s](x.md) and [[x]] and [r](/anime/x.md)';
    const step1 = rewriteIncoming('anime/x.md', t, 'anime/x', 'anime/gundam/x', after);
    expect(step1).toBe('me [s](gundam/x.md) and [[x]] and [r](/anime/gundam/x.md)');
    // followed by rewriteOutgoing the relative link ends up pointing at itself again
    expect(rewriteOutgoing('anime/x.md', 'anime/gundam/x.md', step1)).toBe(
      'me [s](x.md) and [[x]] and [r](/anime/gundam/x.md)',
    );
  });

  it('self-links in the moved file (fromFile = new location, outgoing first)', () => {
    const after = new Set(['anime/gundam/x']);
    const out = rewriteOutgoing('anime/x.md', 'anime/gundam/x.md', 'me [s](x.md)');
    expect(out).toBe('me [s](../x.md)');
    expect(rewriteIncoming('anime/gundam/x.md', out, 'anime/x', 'anime/gundam/x', after)).toBe('me [s](x.md)');
  });

  it('unchanged text is byte-identical', () => {
    const t = 'café \r\n[[foo]]  [a](b.md)\t\n\n';
    expect(rewriteIncoming('a/z.md', t, 'q/old', 'q/new', new Set(['q/new', 'b', 'foo']))).toBe(t);
  });
});

describe('rewriteOutgoing', () => {
  it('moving anime/x.md -> anime/gundam/x.md re-bases relative links', () => {
    const t = [
      '[a](y.md)',
      '[b](../movies/akira.md#h "t")',
      '[c](/anime/z.md)',
      '[[y]] [[anime/y]]',
      '[d](<my file.md>)',
      '[e](my%20file.md)',
      '[u](https://e.com/y.md)',
      '[img](pic.png)',
      '```\n[no](y.md)\n```',
    ].join('\n');
    expect(rewriteOutgoing('anime/x.md', 'anime/gundam/x.md', t)).toBe(
      [
        '[a](../y.md)',
        '[b](../../movies/akira.md#h "t")',
        '[c](/anime/z.md)',
        '[[y]] [[anime/y]]',
        '[d](<../my file.md>)',
        '[e](../my%20file.md)',
        '[u](https://e.com/y.md)',
        '[img](pic.png)',
        '```\n[no](y.md)\n```',
      ].join('\n'),
    );
  });

  it('moving up and across lists', () => {
    expect(rewriteOutgoing('anime/gundam/x.md', 'movies/x.md', '[a](../y.md) [b](seed.md)')).toBe(
      '[a](../anime/y.md) [b](../anime/gundam/seed.md)',
    );
  });

  it('same directory (rename) is a no-op', () => {
    const t = '[a](y.md) [[z]]';
    expect(rewriteOutgoing('anime/x.md', 'anime/x2.md', t)).toBe(t);
  });

  it('links escaping the root are left alone', () => {
    const t = '[a](../../x.md)';
    expect(rewriteOutgoing('anime/x.md', 'anime/g/x.md', t)).toBe(t);
  });
});
