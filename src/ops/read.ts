import { linksOf } from '../bundle/links.js';
import { scanBundle, type BundleSnapshot, type Concept } from '../bundle/scan.js';
import { ToolError } from '../errors.js';
import { ALL_STATUSES, LIST_STATUSES, type ListName } from '../domain/lists.js';
import { assertConceptId, assertDirPath, dirFilter, inDir, listOf } from '../domain/paths.js';

export type ConceptSummary = { id: string } & Record<string, unknown>;

export function summarize(c: Concept): ConceptSummary {
  const out: ConceptSummary = { id: c.id };
  if (c.frontmatter) {
    for (const [k, v] of Object.entries(c.frontmatter)) {
      // defineProperty so a key such as __proto__ is kept as data instead of setting the prototype.
      if (k !== 'id') Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
  }
  if (c.problems.length > 0) out.problems = c.problems;
  return out;
}

export function unknownConceptError(id: string): ToolError {
  return new ToolError(
    `No concept with ID '${id}'. The file may have moved or been renamed; find it again with search_concepts.`,
  );
}

export function requireConcept(snap: BundleSnapshot, id: unknown): Concept {
  if (typeof id !== 'string') throw new ToolError('Invalid concept ID: must be a string.');
  assertConceptId(id);
  const c = snap.concepts.get(id);
  if (!c) throw unknownConceptError(id);
  return c;
}

// ---------------------------------------------------------------------------
// validation helpers
// ---------------------------------------------------------------------------

function checkListStatus(list: ListName | undefined, status: unknown): string {
  if (typeof status !== 'string') throw new ToolError('Invalid list_status: must be a string.');
  if (list) {
    if (!LIST_STATUSES[list].includes(status)) {
      throw new ToolError(`invalid list_status '${status}' for ${list} (allowed: ${LIST_STATUSES[list].join(', ')})`);
    }
  } else if (!ALL_STATUSES.includes(status)) {
    throw new ToolError(`invalid list_status '${status}' (allowed: ${ALL_STATUSES.join(', ')})`);
  }
  return status;
}

function checkLimit(limit: unknown, def: number): number {
  if (limit === undefined || limit === null) return def;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ToolError(`Invalid limit '${String(limit)}': must be an integer from 1 to 100.`);
  }
  return limit;
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  if (typeof cursor !== 'string') throw new ToolError('Invalid cursor.');
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch {
    // fall through
  }
  throw new ToolError('Invalid cursor: use the next_cursor value from a previous response.');
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function page<T>(items: T[], limit: number, cursor: unknown): { items: T[]; next_cursor: string | null } {
  const offset = decodeCursor(cursor);
  const end = offset + limit;
  return { items: items.slice(offset, end), next_cursor: end < items.length ? encodeCursor(end) : null };
}

function hasText(v: unknown): boolean {
  return !(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''));
}

function tagsOf(c: Concept): string[] {
  const t = c.frontmatter?.tags;
  if (typeof t === 'string') return t.trim() === '' ? [] : [t];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return '';
    }
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

export interface DirectoryListing {
  path: string;
  directories: { name: string; path: string; counts: { total: number; by_status: Record<string, number> } }[];
  concepts: ConceptSummary[];
  problems?: { id: string; problems: string[] }[];
}

export async function listDirectory(root: string, input: { path?: string } = {}): Promise<DirectoryListing> {
  const dirPath = input.path ?? '';
  assertDirPath(dirPath);
  const snap = await scanBundle(root);
  if (dirPath !== '' && !snap.dirs.includes(dirPath)) {
    throw new ToolError(`No directory '${dirPath}' in the bundle. Start from list_directory with path '' to see the lists.`);
  }
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const directories: DirectoryListing['directories'] = [];
  for (const d of snap.dirs) {
    if (!d.startsWith(prefix)) continue;
    const name = d.slice(prefix.length);
    if (name === '' || name.includes('/')) continue;
    const by_status: Record<string, number> = {};
    let total = 0;
    for (const c of snap.concepts.values()) {
      if (!c.id.startsWith(`${d}/`)) continue;
      total++;
      const s = c.frontmatter?.list_status;
      if (typeof s === 'string') by_status[s] = (by_status[s] ?? 0) + 1;
    }
    directories.push({ name, path: d, counts: { total, by_status } });
  }
  const concepts = [...snap.concepts.values()].filter((c) => c.dir === dirPath).map(summarize);
  const result: DirectoryListing = { path: dirPath, directories, concepts };
  if (dirPath === '') {
    result.problems = [...snap.concepts.values()]
      .filter((c) => c.problems.length > 0)
      .map((c) => ({ id: c.id, problems: c.problems }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// list_concepts
// ---------------------------------------------------------------------------

export interface ListConceptsInput {
  path?: string;
  list_status?: string;
  tags?: string[];
  bare_only?: boolean;
  limit?: number;
  cursor?: string;
}

function checkTagsFilter(tags: unknown): string[] | undefined {
  if (tags === undefined || tags === null) return undefined;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t.trim() === '')) {
    throw new ToolError('Invalid tags: must be an array of non-empty strings.');
  }
  return (tags as string[]).map((t) => t.trim());
}

export async function listConcepts(
  root: string,
  input: ListConceptsInput = {},
): Promise<{ concepts: ConceptSummary[]; total: number; next_cursor: string | null }> {
  const dir = dirFilter(input.path);
  const list = dir === undefined ? undefined : (listOf(dir) ?? undefined);
  const status = input.list_status === undefined ? undefined : checkListStatus(list, input.list_status);
  const tags = checkTagsFilter(input.tags);
  const limit = checkLimit(input.limit, 50);
  const snap = await scanBundle(root);
  const matches = [...snap.concepts.values()].filter((c) => {
    if (!inDir(c.dir, dir)) return false;
    if (status !== undefined && c.frontmatter?.list_status !== status) return false;
    if (tags) {
      const have = tagsOf(c);
      if (!tags.every((t) => have.includes(t))) return false;
    }
    if (input.bare_only && (hasText(c.frontmatter?.runtime) || hasText(c.frontmatter?.resource))) return false;
    return true;
  });
  const { items, next_cursor } = page(matches, limit, input.cursor);
  return { concepts: items.map(summarize), total: matches.length, next_cursor };
}

// ---------------------------------------------------------------------------
// read_concept
// ---------------------------------------------------------------------------

export interface ReadConceptResult {
  id: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  links: string[];
  backlinks: string[];
  problems: string[];
  raw?: string;
}

export async function readConcept(root: string, input: { id: string }): Promise<ReadConceptResult> {
  const snap = await scanBundle(root);
  const c = requireConcept(snap, input.id);
  const ids = new Set(snap.concepts.keys());
  const links = linksOf(c.file, c.raw, ids);
  const backlinks: string[] = [];
  for (const other of snap.concepts.values()) {
    if (other.id === c.id) continue;
    if (linksOf(other.file, other.raw, ids).includes(c.id)) backlinks.push(other.id);
  }
  const result: ReadConceptResult = {
    id: c.id,
    frontmatter: c.frontmatter,
    body: c.body,
    links,
    backlinks,
    problems: c.problems,
  };
  if (c.problems.length > 0) result.raw = c.raw;
  return result;
}

// ---------------------------------------------------------------------------
// search_concepts
// ---------------------------------------------------------------------------

const SNIPPET = 120;

function snippetAround(text: string, idx: number, len: number): string {
  const flat = text.replace(/\s+/g, ' ');
  const pad = Math.max(0, Math.floor((SNIPPET - len) / 2));
  const start = Math.max(0, idx - pad);
  const end = Math.min(flat.length, idx + len + pad);
  let out = flat.slice(start, end).trim();
  if (start > 0) out = `…${out}`;
  if (end < flat.length) out = `${out}…`;
  return out;
}

function findIn(text: string, needle: RegExp, len: number): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const m = needle.exec(flat);
  return m === null ? null : snippetAround(flat, m.index, m[0].length || len);
}

export async function searchConcepts(
  root: string,
  input: { query: string; path?: string; list_status?: string; limit?: number },
): Promise<{
  results: { id: string; frontmatter: Record<string, unknown> | null; snippet: string }[];
  total: number;
}> {
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    throw new ToolError('Invalid query: must not be empty.');
  }
  const queryText = input.query.trim().replace(/\s+/g, ' ');
  const needle = new RegExp(queryText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  const dir = dirFilter(input.path);
  const list = dir === undefined ? undefined : (listOf(dir) ?? undefined);
  const status = input.list_status === undefined ? undefined : checkListStatus(list, input.list_status);
  const limit = checkLimit(input.limit, 20);
  const snap = await scanBundle(root);
  const titleHits: { c: Concept; snippet: string }[] = [];
  const otherHits: { c: Concept; snippet: string }[] = [];
  for (const c of snap.concepts.values()) {
    if (!inDir(c.dir, dir)) continue;
    if (status !== undefined && c.frontmatter?.list_status !== status) continue;
    const title = findIn(str(c.frontmatter?.title), needle, queryText.length);
    if (title !== null) {
      titleHits.push({ c, snippet: title });
      continue;
    }
    let snippet = findIn(str(c.frontmatter?.description), needle, queryText.length) ?? findIn(c.body, needle, queryText.length);
    if (snippet === null) {
      for (const t of tagsOf(c)) {
        snippet = findIn(t, needle, queryText.length);
        if (snippet !== null) break;
      }
    }
    if (snippet !== null) otherHits.push({ c, snippet });
  }
  const all = [...titleHits, ...otherHits];
  return {
    results: all.slice(0, limit).map(({ c, snippet }) => ({ id: c.id, frontmatter: c.frontmatter, snippet })),
    total: all.length,
  };
}

// ---------------------------------------------------------------------------
// list_stale
// ---------------------------------------------------------------------------

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

export async function listStale(
  root: string,
  input: { path?: string; limit?: number; cursor?: string } = {},
  now: Date = new Date(),
): Promise<{
  concepts: { id: string; frontmatter: Record<string, unknown> | null; reason: 'past_stale_after' | 'unverified' }[];
  next_cursor: string | null;
}> {
  const dir = dirFilter(input.path);
  const limit = checkLimit(input.limit, 20);
  const snap = await scanBundle(root);
  const stale: { c: Concept; reason: 'past_stale_after' | 'unverified'; key: number }[] = [];
  for (const c of snap.concepts.values()) {
    // Staleness is a media-list concern: notes and other areas are exempt.
    if (c.list === null || !inDir(c.dir, dir)) continue;
    const fm = c.frontmatter;
    const sa = fm?.stale_after;
    const saMs = toMs(sa);
    let reason: 'past_stale_after' | 'unverified' | null = null;
    if (sa !== undefined && sa !== null && (Number.isNaN(saMs) || saMs < now.getTime())) reason = 'past_stale_after';
    else if (!Array.isArray(fm?.verified) || fm.verified.length === 0) reason = 'unverified';
    if (reason === null) continue;
    let key = saMs;
    if (Number.isNaN(key)) {
      const gen = fm?.generated;
      key = toMs(gen && typeof gen === 'object' ? (gen as Record<string, unknown>).at : undefined);
    }
    if (Number.isNaN(key)) key = -Infinity;
    stale.push({ c, reason, key });
  }
  stale.sort((a, b) => (a.key === b.key ? (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0) : a.key < b.key ? -1 : 1));
  const { items, next_cursor } = page(stale, limit, input.cursor);
  return {
    concepts: items.map(({ c, reason }) => ({ id: c.id, frontmatter: c.frontmatter, reason })),
    next_cursor,
  };
}

// ---------------------------------------------------------------------------
// list_tags
// ---------------------------------------------------------------------------

export async function listTags(root: string): Promise<{ tags: { tag: string; count: number }[] }> {
  const snap = await scanBundle(root);
  const counts = new Map<string, number>();
  for (const c of snap.concepts.values()) {
    for (const t of new Set(tagsOf(c))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const tags = [...counts].map(([tag, count]) => ({ tag, count }));
  tags.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return { tags };
}
