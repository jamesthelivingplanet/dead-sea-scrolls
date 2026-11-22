import fs from 'node:fs/promises';
import path from 'node:path';
import { regenerateIndexes } from '../bundle/indexgen.js';
import { buildConceptText, parseConceptText, replaceBody, replaceFrontmatter, setFrontmatterKeys } from '../bundle/frontmatter.js';
import { linksOf, rewriteIncoming, rewriteOutgoing } from '../bundle/links.js';
import { computeProblems } from '../bundle/problems.js';
import { scanBundle, type Concept } from '../bundle/scan.js';
import { LIST_STATUSES, LIST_TYPES, NOTE_TYPE, OKF_STATUSES, defaultStatus, isNotesPath, type ListName } from '../domain/lists.js';
import { assertDirPath, listOf } from '../domain/paths.js';
import { slugify, uniqueName } from '../domain/slug.js';
import { ToolError } from '../errors.js';
import { git, type Author } from '../git.js';
import { inTx, Tx } from '../tx.js';
import { requireConcept } from './read.js';

export interface Actor {
  author: Author;
  clientName: string;
}

type Obj = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function generatedFor(actor: Actor): { by: string; at: string } {
  return { by: actor.clientName, at: nowIso() };
}

async function headHash(root: string): Promise<string> {
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

async function commit(tx: Tx, message: string, actor: Actor): Promise<string> {
  return (await tx.commit(message, actor.author)) ?? (await headHash(tx.root));
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function statusError(list: ListName, status: string): ToolError {
  return new ToolError(`invalid list_status '${status}' for ${list} (allowed: ${LIST_STATUSES[list].join(', ')})`);
}

function checkStatus(list: ListName, v: unknown): string {
  if (typeof v !== 'string') throw new ToolError('Invalid list_status: must be a string.');
  const s = v.trim();
  if (!LIST_STATUSES[list].includes(s)) throw statusError(list, s);
  return s;
}

function checkOkfStatus(v: unknown): string {
  if (typeof v !== 'string' || !(OKF_STATUSES as readonly string[]).includes(v.trim())) {
    throw new ToolError(`Invalid status '${String(v)}' (allowed: ${OKF_STATUSES.join(', ')}).`);
  }
  return v.trim();
}

const USE_STATUS = "list_status only applies inside the six lists; use status (draft, stable, deprecated) here.";

function checkText(key: string, v: unknown): string {
  if (typeof v !== 'string') throw new ToolError(`Invalid ${key}: must be a string.`);
  const s = v.trim();
  if (s === '') throw new ToolError(`Invalid ${key}: must not be empty (pass null to remove it).`);
  return s;
}

function checkResource(v: unknown): string {
  const s = checkText('resource', v);
  let ok = false;
  try {
    ok = new URL(s).protocol.length > 1;
  } catch {
    ok = false;
  }
  if (!ok) throw new ToolError(`Invalid resource '${s}': must be an absolute URI such as https://example.com/page.`);
  return s;
}

function checkTags(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || t.trim() === '')) {
    throw new ToolError('Invalid tags: must be an array of non-empty strings.');
  }
  return (v as string[]).map((t) => t.trim());
}

const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function checkDateTime(key: string, v: unknown): string {
  if (typeof v !== 'string' || !ISO_DT.test(v.trim()) || Number.isNaN(Date.parse(v.trim()))) {
    throw new ToolError(`Invalid ${key}: must be an ISO date-time such as 2026-11-16T22:01:02Z.`);
  }
  return v.trim();
}

function checkVerified(v: unknown): { by: string; at: string }[] {
  if (!Array.isArray(v)) throw new ToolError('Invalid verified: must be an array of { by, at } entries.');
  return v.map((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new ToolError(`Invalid verified[${i}]: must be an object { by, at }.`);
    }
    const o = e as Obj;
    if (typeof o.by !== 'string' || o.by.trim() === '') throw new ToolError(`Invalid verified[${i}].by: must be a non-empty string.`);
    return { by: o.by.trim(), at: checkDateTime(`verified[${i}].at`, o.at) };
  });
}

// ---------------------------------------------------------------------------
// path safety (no writes through symlinks)
// ---------------------------------------------------------------------------

/** Rejects a dir (relative to root) when any existing segment is a symlink or not a directory. */
async function assertSafeDir(root: string, relDir: string): Promise<void> {
  let cur = root;
  for (const seg of relDir.split('/').filter((x) => x !== '' && x !== '.')) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (st.isSymbolicLink()) throw new ToolError(`Refusing to write through '${path.relative(root, cur)}': it is a symbolic link.`);
    if (!st.isDirectory()) throw new ToolError(`Cannot use '${path.relative(root, cur)}' as a directory: it is not one.`);
  }
}

/** Rejects a file path (relative to root) that exists as a symlink. */
async function assertSafeFile(root: string, relFile: string): Promise<void> {
  try {
    const st = await fs.lstat(path.join(root, relFile));
    if (st.isSymbolicLink()) throw new ToolError(`Refusing to touch '${relFile}': it is a symbolic link.`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

async function assertSafeConceptPath(root: string, relFile: string): Promise<void> {
  const d = path.posix.dirname(relFile);
  await assertSafeDir(root, d === '.' ? '' : d);
  await assertSafeFile(root, relFile);
}

function headingOf(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m && m[1]!.trim() !== '') return m[1]!.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// create_concept
// ---------------------------------------------------------------------------

export interface CreateInput {
  path: string;
  title: string;
  type?: string;
  list_status?: string;
  status?: string;
  description?: string;
  resource?: string;
  runtime?: string;
  author?: string;
  tags?: string[];
  body?: string;
}

function optionalText(key: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return checkText(key, v);
}

/** Lowercased entry names in dir; `exceptExact` (a concept's own file) does not count as taken. */
async function takenNames(root: string, dir: string, exceptExact?: string): Promise<Set<string>> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(path.join(root, dir));
  } catch {
    entries = [];
  }
  return new Set(entries.filter((e) => e !== exceptExact).map((e) => e.toLowerCase()));
}

export async function createConcept(
  root: string,
  input: CreateInput,
  actor: Actor,
): Promise<{ id: string; frontmatter: Obj; commit: string }> {
  if (typeof input.path !== 'string' || input.path === '') throw new ToolError('Invalid path: must be a non-empty bundle-relative directory.');
  const dir = input.path;
  assertDirPath(dir);
  const list = listOf(dir);
  if (typeof input.title !== 'string' || input.title.trim() === '') throw new ToolError('Invalid title: must not be empty.');
  const title = input.title.trim();
  const explicitType = optionalText('type', input.type);
  let type: string;
  if (list !== null) {
    if (explicitType !== undefined && explicitType !== LIST_TYPES[list]) {
      throw new ToolError(`type '${explicitType}' does not match ${list} (its type is '${LIST_TYPES[list]}'). Omit type, or create it outside the six lists.`);
    }
    type = LIST_TYPES[list];
  } else if (explicitType !== undefined) type = explicitType;
  else if (isNotesPath(dir)) type = NOTE_TYPE;
  else throw new ToolError(`Missing type: '${dir}' is not one of the six lists or under notes, so pass type (e.g. "Note").`);
  if (list === null && input.list_status !== undefined && input.list_status !== null) throw new ToolError(USE_STATUS);
  const listStatus = list === null ? undefined : input.list_status === undefined || input.list_status === null ? defaultStatus(list) : checkStatus(list, input.list_status);
  const okfStatus = input.status !== undefined && input.status !== null ? checkOkfStatus(input.status) : list === null ? 'draft' : undefined;
  const description = optionalText('description', input.description);
  const resource = input.resource === undefined || input.resource === null ? undefined : checkResource(input.resource);
  const runtime = optionalText('runtime', input.runtime);
  const author = optionalText('author', input.author);
  const tags = input.tags === undefined || input.tags === null ? undefined : checkTags(input.tags);
  if (input.body !== undefined && input.body !== null && typeof input.body !== 'string') {
    throw new ToolError('Invalid body: must be a string.');
  }
  const body = input.body ?? '';

  await assertSafeDir(root, dir);
  const taken = await takenNames(root, dir);
  const base = slugify(title) || 'untitled';
  const name = uniqueName(base, (n) => taken.has(`${n}.md`) || n === 'index' || n === 'log');
  const id = `${dir}/${name}`;

  const frontmatter: Obj = { type, title };
  if (description !== undefined) frontmatter.description = description;
  if (resource !== undefined) frontmatter.resource = resource;
  if (tags !== undefined) frontmatter.tags = tags;
  if (listStatus !== undefined) frontmatter.list_status = listStatus;
  if (okfStatus !== undefined) frontmatter.status = okfStatus;
  if (runtime !== undefined) frontmatter.runtime = runtime;
  if (author !== undefined) frontmatter.author = author;
  frontmatter.generated = generatedFor(actor);

  const hash = await inTx(root, async (tx) => {
    await tx.write(`${id}.md`, buildConceptText(frontmatter, body), { exclusive: true });
    await regenerateIndexes(root, [dir], (rel, t) => tx.write(rel, t));
    return commit(tx, `Add ${title} to ${dir}`, actor);
  });
  return { id, frontmatter, commit: hash };
}

// ---------------------------------------------------------------------------
// update_concept
// ---------------------------------------------------------------------------

export interface UpdateInput {
  id: string;
  frontmatter?: Obj;
  body?: string;
}

const PATCH_KEYS = [
  'title', 'description', 'resource', 'runtime', 'author', 'tags', 'list_status', 'status', 'status_detail', 'verified', 'stale_after',
] as const;
const NOT_NULLABLE = new Set(['title', 'list_status']);

/** Validates and normalizes a patch. null becomes undefined (delete). */
function validatePatch(list: ListName | null, raw: unknown): Obj {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolError('Invalid frontmatter: must be an object of keys to set.');
  }
  const patch: Obj = {};
  for (const [key, v] of Object.entries(raw as Obj)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) {
      throw new ToolError(`Cannot update frontmatter key '${key}' (allowed: ${PATCH_KEYS.join(', ')}).`);
    }
    if (v === null) {
      if (NOT_NULLABLE.has(key)) throw new ToolError(`Cannot remove '${key}': it is required.`);
      patch[key] = undefined;
      continue;
    }
    switch (key) {
      case 'title':
      case 'description':
      case 'runtime':
      case 'author':
      case 'status_detail':
        patch[key] = checkText(key, v);
        break;
      case 'resource':
        patch[key] = checkResource(v);
        break;
      case 'tags':
        patch[key] = checkTags(v);
        break;
      case 'list_status':
        if (list === null) throw new ToolError(USE_STATUS);
        patch[key] = checkStatus(list, v);
        break;
      case 'status':
        patch[key] = checkOkfStatus(v);
        break;
      case 'verified':
        patch[key] = checkVerified(v);
        break;
      case 'stale_after':
        patch[key] = checkDateTime(key, v);
        break;
    }
  }
  return patch;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function problemsOfText(c: Concept, text: string): string[] {
  const parsed = parseConceptText(text);
  return computeProblems({
    id: c.id, file: c.file, dir: c.dir, name: c.name, list: c.list, raw: text,
    frontmatter: parsed.kind === 'ok' ? parsed.data : null,
    frontmatterState: parsed.kind,
    body: parsed.body,
  });
}

export async function updateConcept(
  root: string,
  input: UpdateInput,
  actor: Actor,
): Promise<{ id: string; frontmatter: Obj; commit: string }> {
  const hasFm = input.frontmatter !== undefined && input.frontmatter !== null;
  const hasBody = input.body !== undefined && input.body !== null;
  if (hasFm && !hasBody && typeof input.frontmatter === 'object' && !Array.isArray(input.frontmatter) && Object.keys(input.frontmatter).length === 0) {
    throw new ToolError('Nothing to update: pass frontmatter, body, or both.');
  }
  if (!hasFm && !hasBody) throw new ToolError('Nothing to update: pass frontmatter, body, or both.');
  if (hasBody && typeof input.body !== 'string') throw new ToolError('Invalid body: must be a string.');
  const snap = await scanBundle(root);
  const c = requireConcept(snap, input.id);
  if (c.dir === '') {
    throw new ToolError(`Concept '${c.id}' is at the bundle root. Use move_concept to put it in a list or directory first.`);
  }
  const list = c.list;
  await assertSafeConceptPath(root, c.file);
  const patch = hasFm ? validatePatch(list, input.frontmatter) : {};
  let text: string;

  if (c.frontmatterState === 'ok' && c.frontmatter) {
    const fm = c.frontmatter;
    const effective: Obj = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        if (k in fm) effective[k] = undefined;
      } else if (!same(fm[k], v)) effective[k] = v;
    }
    if (list !== null && fm.type !== LIST_TYPES[list]) effective.type = LIST_TYPES[list];
    text = c.raw;
    if (hasBody && input.body !== c.body) text = replaceBody(text, input.body as string);
    if (Object.keys(effective).length > 0) text = setFrontmatterKeys(text, effective);
    if (text === c.raw) {
      return { id: c.id, frontmatter: fm, commit: await headHash(root) };
    }
    text = setFrontmatterKeys(text, { generated: generatedFor(actor) });
    const problems = problemsOfText(c, text);
    if (problems.length > 0) {
      throw new ToolError(`This update would leave '${c.id}' with problems: ${problems.join('; ')}. Fix them in the same call.`);
    }
  } else {
    const why = c.frontmatterState === 'missing' ? 'has no frontmatter' : 'has frontmatter that does not parse';
    const need = list === null
      ? `'${c.id}' ${why}, so update_concept needs a complete frontmatter: at least title.`
      : `'${c.id}' ${why}, so update_concept needs a complete frontmatter: at least title and list_status (one of ${LIST_STATUSES[list].join(', ')}); type is set from the list.`;
    if (!hasFm) throw new ToolError(need);
    const clean: Obj = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
    if (typeof clean.title !== 'string' || (list !== null && typeof clean.list_status !== 'string')) throw new ToolError(need);
    const { title, ...rest } = clean;
    const type = list !== null ? LIST_TYPES[list] : isNotesPath(c.dir) ? NOTE_TYPE : undefined;
    const data: Obj = { ...(type ? { type } : {}), title, ...rest, generated: generatedFor(actor) };
    text = replaceFrontmatter(c.raw, data);
    if (hasBody) text = replaceBody(text, input.body as string);
    const problems = problemsOfText(c, text);
    if (problems.length > 0) throw new ToolError(`This update would leave '${c.id}' with problems: ${problems.join('; ')}.`);
  }

  const parsed = parseConceptText(text);
  const frontmatter = parsed.kind === 'ok' ? parsed.data : {};
  const hash = await inTx(root, async (tx) => {
    await tx.write(c.file, text);
    await regenerateIndexes(root, [c.dir], (rel, t) => tx.write(rel, t));
    return commit(tx, `Update ${String(frontmatter.title)}`, actor);
  });
  return { id: c.id, frontmatter, commit: hash };
}

// ---------------------------------------------------------------------------
// relocation helpers (shared with repair)
// ---------------------------------------------------------------------------

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  while (d !== '' && d !== '.') {
    out.push(d);
    const i = d.lastIndexOf('/');
    d = i === -1 ? '' : d.slice(0, i);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes `dir` and its parents while they are empty. A dir holding only its generated
 * index.md counts as empty; list roots and the bundle root are never removed.
 */
export async function pruneEmptyDirs(root: string, dir: string, tx: Tx): Promise<void> {
  let d = dir;
  while (d !== '' && d !== '.') {
    if (listOf(d) !== null && !d.includes('/')) break; // list root
    const abs = path.join(root, d);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      break;
    }
    // Only a regular file named index.md counts (a phone-made folder of that name does not).
    let empty = entries.every((e) => e.name === 'index.md' && e.isFile());
    // Outside the lists an index.md only counts as generated if it holds nothing but headings and entries.
    if (empty && entries.length > 0 && listOf(d) === null) {
      const text = await fs.readFile(path.join(abs, 'index.md'), 'utf8');
      empty = text.split(/\r?\n/).every((l) => /^(#{1,2} .*|\* \[.*\]\(.*\)( - .*)?)?$/.test(l));
    }
    if (!empty) break;
    if (entries.length > 0) await tx.unlink(`${d}/index.md`);
    await tx.rmdir(d);
    const i = d.lastIndexOf('/');
    d = i === -1 ? '' : d.slice(0, i);
  }
}

/**
 * Moves a concept file, rewrites its own relative links and incoming links in other concepts,
 * prunes emptied source dirs. Does not regenerate indexes or commit: the caller does that
 * for the returned dirs.
 */
export async function relocateConcept(root: string, oldId: string, newId: string, tx: Tx): Promise<{ touchedDirs: string[] }> {
  const snap = await scanBundle(root);
  const old = snap.concepts.get(oldId);
  if (!old) throw new ToolError(`No concept with ID '${oldId}'.`);
  if (oldId === newId) throw new ToolError(`already at ${newId}`);
  const newFile = `${newId}.md`;
  const newAbs = path.join(root, newFile);
  await assertSafeConceptPath(root, old.file);
  await assertSafeConceptPath(root, newFile);
  if (await exists(newAbs)) throw new ToolError(`Cannot move to '${newId}': a file already exists there.`);
  const idsAfter = new Set(snap.concepts.keys());
  idsAfter.delete(oldId);
  idsAfter.add(newId);

  await tx.rename(old.file, newFile);
  let moved = rewriteOutgoing(old.file, newFile, old.raw);
  moved = rewriteIncoming(newFile, moved, oldId, newId, idsAfter);
  if (moved !== old.raw) await tx.write(newFile, moved);

  const allIds = new Set(snap.concepts.keys());
  for (const other of snap.concepts.values()) {
    if (other.id === oldId) continue;
    if (!linksOf(other.file, other.raw, allIds).includes(oldId)) continue;
    const next = rewriteIncoming(other.file, other.raw, oldId, newId, idsAfter);
    if (next !== other.raw) await tx.write(other.file, next);
  }

  await pruneEmptyDirs(root, old.dir, tx);
  const newDir = path.posix.dirname(newId) === '.' ? '' : path.posix.dirname(newId);
  const touched = new Set<string>([...ancestors(old.dir), ...ancestors(newDir)]);
  return { touchedDirs: [...touched] };
}

// ---------------------------------------------------------------------------
// move_concept
// ---------------------------------------------------------------------------

export interface MoveInput {
  id: string;
  to: string;
  name?: string;
  type?: string;
  list_status?: string;
  status?: string;
}

export async function moveConcept(
  root: string,
  input: MoveInput,
  actor: Actor,
): Promise<{ id: string; previous_id: string; frontmatter: Obj; commit: string }> {
  if (typeof input.to !== 'string') throw new ToolError('Invalid to: must be a string.');
  const to = input.to.trim();
  assertDirPath(to);
  const snap = await scanBundle(root);
  const c = requireConcept(snap, input.id);
  const targetList = listOf(to);
  if (to === '') throw new ToolError('Invalid target: must be a directory, not the bundle root.');
  const fresh = c.frontmatterState !== 'ok' || !c.frontmatter;
  if (input.name !== undefined && input.name !== null && typeof input.name !== 'string') {
    throw new ToolError('Invalid name: must be a string.');
  }
  let base = c.name;
  if (typeof input.name === 'string') {
    const n = input.name.trim().replace(/\.md$/i, '');
    base = slugify(n);
    if (base === '') throw new ToolError(`Invalid name '${input.name}': it has no letters or digits to use as a file name.`);
  }

  const current = c.frontmatter?.list_status;
  const explicitType = optionalText('type', input.type);
  const explicitStatus = input.status === undefined || input.status === null ? undefined : checkOkfStatus(input.status);
  let newStatus: string | undefined;
  if (targetList === null) {
    if (input.list_status !== undefined && input.list_status !== null) throw new ToolError(USE_STATUS);
  } else if (explicitType !== undefined && explicitType !== LIST_TYPES[targetList]) {
    throw new ToolError(`type '${explicitType}' does not match ${targetList} (its type is '${LIST_TYPES[targetList]}').`);
  } else if (input.list_status !== undefined && input.list_status !== null) {
    newStatus = checkStatus(targetList, input.list_status);
  } else if (fresh) {
    newStatus = defaultStatus(targetList);
  } else if (typeof current !== 'string' || !LIST_STATUSES[targetList].includes(current)) {
    throw new ToolError(
      `list_status '${String(current)}' is not allowed in ${targetList} (allowed: ${LIST_STATUSES[targetList].join(', ')}). Pass list_status to choose one.`,
    );
  }

  await assertSafeDir(root, to);
  await assertSafeConceptPath(root, c.file);
  const taken = await takenNames(root, to, to === c.dir ? `${c.name}.md` : undefined);
  const name = uniqueName(base, (n) => taken.has(`${n}.md`) || n === 'index' || n === 'log');
  const newId = `${to}/${name}`;
  if (newId === c.id) throw new ToolError(`already at ${c.id}`);

  return inTx(root, async (tx) => {
  const { touchedDirs } = await relocateConcept(root, c.id, newId, tx);
  const file = path.join(root, `${newId}.md`);
  // Type: explicit > list's type > Note under notes/ > keep what it had.
  const oldType = typeof c.frontmatter?.type === 'string' ? c.frontmatter.type : undefined;
  const newType = targetList !== null ? LIST_TYPES[targetList] : explicitType ?? (isNotesPath(to) ? NOTE_TYPE : oldType);
  const patch: Obj = { generated: generatedFor(actor) };
  if (newType !== undefined) patch.type = newType;
  if (targetList !== null) {
    if (newStatus !== undefined) patch.list_status = newStatus;
    if (c.list === null) patch.status = undefined; // area -> list: the lifecycle status goes
  } else {
    if (c.list !== null) patch.list_status = undefined; // list -> area: the list status goes
    if (explicitStatus !== undefined) patch.status = explicitStatus;
    else if (c.list !== null || fresh) patch.status = 'draft';
  }
  const movedRaw = await fs.readFile(file, 'utf8');
  const text = fresh
    ? replaceFrontmatter(movedRaw, {
        ...(newType !== undefined ? { type: newType } : {}),
        title: headingOf(c.body) ?? c.name,
        ...(patch.list_status !== undefined ? { list_status: patch.list_status } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        generated: generatedFor(actor),
      })
    : setFrontmatterKeys(movedRaw, patch);
  await tx.write(`${newId}.md`, text);
  await regenerateIndexes(root, touchedDirs, (rel, t) => tx.write(rel, t));
  const parsed = parseConceptText(text);
  const frontmatter = parsed.kind === 'ok' ? parsed.data : {};
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : c.name;
  const hash = await commit(tx, `Move ${title} from ${c.id} to ${newId}`, actor);
  return { id: newId, previous_id: c.id, frontmatter, commit: hash };
  });
}

// ---------------------------------------------------------------------------
// delete_concept
// ---------------------------------------------------------------------------

export async function deleteConcept(
  root: string,
  input: { id: string; confirm?: boolean },
  actor: Actor,
): Promise<
  | { id: string; title: string; would_delete: { file: string }; confirm_required: true }
  | { id: string; deleted: true; commit: string }
> {
  const snap = await scanBundle(root);
  const c = requireConcept(snap, input.id);
  const t = c.frontmatter?.title;
  const title = typeof t === 'string' && t.trim() !== '' ? t : c.name;
  await assertSafeConceptPath(root, c.file);
  if (input.confirm !== true) {
    return { id: c.id, title, would_delete: { file: c.file }, confirm_required: true };
  }
  const hash = await inTx(root, async (tx) => {
    await tx.unlink(c.file);
    await pruneEmptyDirs(root, c.dir, tx);
    await regenerateIndexes(root, ancestors(c.dir), (rel, t) => tx.write(rel, t));
    return commit(tx, `Delete ${title}`, actor);
  });
  return { id: c.id, deleted: true, commit: hash };
}
