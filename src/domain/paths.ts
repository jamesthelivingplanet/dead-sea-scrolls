import { ToolError } from '../errors.js';
import { isList, type ListName } from './lists.js';

function assertPath(p: string, what: string): void {
  if (typeof p !== 'string') throw new ToolError(`Invalid ${what}: must be a string.`);
  if (p.includes('\0')) throw new ToolError(`Invalid ${what}: contains a NUL character.`);
  if (p.includes('\\')) throw new ToolError(`Invalid ${what} '${p}': backslashes are not allowed.`);
  if (p.startsWith('/') || p.endsWith('/')) {
    throw new ToolError(`Invalid ${what} '${p}': must not start or end with '/'.`);
  }
  for (const seg of p.split('/')) {
    if (seg === '') throw new ToolError(`Invalid ${what} '${p}': empty path segment.`);
    if (seg === '..') throw new ToolError(`Invalid ${what} '${p}': '..' is not allowed.`);
    if (seg.startsWith('.')) {
      throw new ToolError(`Invalid ${what} '${p}': segments must not start with '.'.`);
    }
  }
}

/** Directory segments must not look like markdown files (a dir named index.md breaks indexes). */
function assertDirSegments(segs: string[], p: string, what: string): void {
  for (const seg of segs) {
    if (/\.md$/i.test(seg)) throw new ToolError(`Invalid ${what} '${p}': directory names must not end in '.md'.`);
  }
}

export function assertConceptId(id: string): void {
  if (typeof id !== 'string' || id === '') throw new ToolError('Invalid concept ID: must not be empty.');
  assertPath(id, 'concept ID');
  assertDirSegments(id.split('/').slice(0, -1), id, 'concept ID');
  if (id.endsWith('.md')) {
    throw new ToolError(`Invalid concept ID '${id}': IDs do not include the '.md' suffix.`);
  }
}

/** Same rules as a concept ID; '' (the bundle root) is allowed. */
export function assertDirPath(path: string): void {
  if (path === '') return;
  assertPath(path, 'directory path');
  assertDirSegments(path.split('/'), path, 'directory path');
}

export function listOf(idOrPath: string): ListName | null {
  const first = idOrPath.split('/')[0]!;
  return isList(first) ? first : null;
}

/** Validates an optional dir filter. Omitted or '' means everywhere (undefined). */
export function dirFilter(p: unknown): string | undefined {
  if (p === undefined || p === null || p === '') return undefined;
  if (typeof p !== 'string') throw new ToolError('Invalid path: must be a string.');
  assertDirPath(p);
  return p;
}

/** True when dir is `filter` or below it. */
export function inDir(dir: string, filter: string | undefined): boolean {
  return filter === undefined || dir === filter || dir.startsWith(`${filter}/`);
}
