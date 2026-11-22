import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors.js';
import { assertConceptId, assertDirPath, listOf } from '../../src/domain/paths.js';

describe('paths', () => {
  it('accepts good ids', () => {
    for (const id of ['anime/86-eighty-six', 'anime/gundam/x', 'a']) expect(() => assertConceptId(id)).not.toThrow();
  });
  it.each(['', '/a', 'a/', 'a\\b', 'a\0b', '.git/x', 'a/.hidden', 'a//b', '../a', 'a/../b', 'a/b.md', 'a/..'])(
    'rejects id %j',
    (id) => expect(() => assertConceptId(id)).toThrow(ToolError),
  );
  it('dir paths allow root', () => {
    expect(() => assertDirPath('')).not.toThrow();
    expect(() => assertDirPath('anime/gundam')).not.toThrow();
    expect(() => assertDirPath('anime/..')).toThrow(ToolError);
    expect(() => assertDirPath('/anime')).toThrow(ToolError);
    expect(() => assertDirPath('.obsidian')).toThrow(ToolError);
  });
  it('listOf', () => {
    expect(listOf('anime/x')).toBe('anime');
    expect(listOf('books')).toBe('books');
    expect(listOf('misc/x')).toBeNull();
    expect(listOf('')).toBeNull();
  });
});
