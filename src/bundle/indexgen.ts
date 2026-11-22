import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isList,
  isValidStatus,
  LIST_STATUSES,
  LIST_TYPES,
  statusTitle,
  type ListName,
} from '../domain/lists.js';
import { scanBundle, type Concept } from './scan.js';

const UNSORTED = 'Unsorted';
const FOLDERS = 'Folders';
const ENTRY_RE = /^\* \[.*\]\(([^()\s]+)\.md\)(?: - .*)?$/;
const collator = new Intl.Collator('en');

function oneLine(s: string): string {
  return /[\r\n]/.test(s) ? s.replace(/\s+/g, ' ').trim() : s;
}

function titleOf(c: Concept): string {
  const t = c.frontmatter?.title;
  return typeof t === 'string' && t.trim() !== '' ? oneLine(t) : c.name;
}

function entryLine(c: Concept): string {
  const d = c.frontmatter?.description;
  const desc = typeof d === 'string' ? oneLine(d) : '';
  return `* [${titleOf(c)}](${c.name}.md)` + (desc !== '' ? ` - ${desc}` : '');
}

function byTitle(a: Concept, b: Concept): number {
  return collator.compare(titleOf(a), titleOf(b)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

interface ParsedIndex {
  h1: string | null;
  sections: { title: string; names: string[] }[];
}

function parseExisting(text: string | null): ParsedIndex {
  const out: ParsedIndex = { h1: null, sections: [] };
  if (text === null) return out;
  let cur: { title: string; names: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      cur = { title: line.slice(3).trim(), names: [] };
      out.sections.push(cur);
    } else if (line.startsWith('# ') && out.h1 === null && cur === null) {
      out.h1 = line.trimEnd();
    } else if (cur) {
      const m = ENTRY_RE.exec(line);
      if (m) cur.names.push(m[1]!);
    }
  }
  return out;
}

function folderBlock(subdirs: { name: string; total: number }[]): string[] {
  if (subdirs.length === 0) return [];
  const sorted = [...subdirs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    `## ${FOLDERS}`,
    sorted.map((s) => `* [${s.name}](${s.name}/) - ${s.total} ${s.total === 1 ? 'title' : 'titles'}`).join('\n'),
  ];
}

function renderAreaIndex(dir: string, concepts: Concept[], subdirs: { name: string; total: number }[], existing: string | null): string {
  const h1 = parseExisting(existing).h1 ?? `# ${dir.split('/').pop()!}`;
  const blocks = [h1];
  if (concepts.length > 0) blocks.push([...concepts].sort(byTitle).map(entryLine).join('\n'));
  blocks.push(...folderBlock(subdirs));
  return blocks.join('\n\n') + '\n';
}

export function renderDirIndex(args: {
  dir: string;
  /** null for an area (any directory outside the six lists): a flat, title-sorted list. */
  list: ListName | null;
  concepts: Concept[];
  subdirs: { name: string; total: number }[];
  existing: string | null;
}): string {
  const { dir, list, concepts, subdirs, existing } = args;
  if (list === null) return renderAreaIndex(dir, concepts, subdirs, existing);
  const statuses = LIST_STATUSES[list];
  const parsed = parseExisting(existing);

  // Group concepts by section key (a status, or UNSORTED).
  const byKey = new Map<string, Concept[]>();
  for (const c of concepts) {
    const s = c.frontmatter?.list_status;
    const key = isValidStatus(list, s) ? (s as string) : UNSORTED;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(c);
  }
  const titleToKey = new Map<string, string>(statuses.map((s) => [statusTitle(s), s]));
  titleToKey.set(UNSORTED, UNSORTED);

  // Existing section order (known sections only, de-duplicated).
  const order: string[] = [];
  const kept = new Map<string, Concept[]>();
  const placed = new Set<string>();
  const byName = new Map(concepts.map((c) => [c.name, c]));
  for (const sec of parsed.sections) {
    const key = titleToKey.get(sec.title);
    if (key === undefined) continue;
    if (!order.includes(key)) order.push(key);
    const list_ = kept.get(key) ?? kept.set(key, []).get(key)!;
    for (const n of sec.names) {
      const c = byName.get(n);
      if (!c || placed.has(n)) continue;
      const s = c.frontmatter?.list_status;
      const ck = isValidStatus(list, s) ? (s as string) : UNSORTED;
      if (ck !== key) continue;
      placed.add(n);
      list_.push(c);
    }
  }
  // Append new / re-statused concepts, sorted by title.
  for (const [key, cs] of byKey) {
    const fresh = cs.filter((c) => !placed.has(c.name)).sort(byTitle);
    if (fresh.length === 0) continue;
    (kept.get(key) ?? kept.set(key, []).get(key)!).push(...fresh);
  }
  // Insert needed-but-missing status sections at list-order position.
  const idx = (k: string) => statuses.indexOf(k);
  for (const s of statuses) {
    if (!kept.get(s)?.length || order.includes(s)) continue;
    const at = order.findIndex((k) => k !== UNSORTED && idx(k) > idx(s));
    if (at === -1) order.push(s);
    else order.splice(at, 0, s);
  }
  const finalOrder = [
    ...order.filter((k) => k !== UNSORTED),
    ...(kept.get(UNSORTED)?.length ? [UNSORTED] : []),
  ].filter((k) => (kept.get(k)?.length ?? 0) > 0);

  const base = dir.split('/').pop()!;
  const h1 = parsed.h1 ?? (dir === list ? `# ${LIST_TYPES[list]}` : `# ${base}`);
  const blocks: string[] = [h1];
  for (const k of finalOrder) {
    const title = k === UNSORTED ? UNSORTED : statusTitle(k);
    blocks.push(`## ${title}`, kept.get(k)!.map(entryLine).join('\n'));
  }
  blocks.push(...folderBlock(subdirs));
  return blocks.join('\n\n') + '\n';
}

export async function regenerateIndexes(
  root: string,
  dirs: string[],
  write: (rel: string, text: string) => Promise<void> = (rel, text) => fs.writeFile(path.join(root, rel), text),
): Promise<string[]> {
  const targets = new Set<string>();
  for (const d of dirs) {
    if (d === '') continue;
    const segs = d.split('/');
    for (let i = segs.length; i >= 1; i--) targets.add(segs.slice(0, i).join('/'));
  }
  if (targets.size === 0) return [];
  const snap = await scanBundle(root);
  const written: string[] = [];
  for (const dir of [...targets].sort()) {
    if (!snap.dirs.includes(dir)) continue;
    const top = dir.split('/')[0]!;
    const list = isList(top) ? top : null;
    const concepts = [...snap.concepts.values()].filter((c) => c.dir === dir);
    const subdirs = snap.dirs
      .filter((d) => d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/'))
      .map((d) => ({
        name: d.slice(dir.length + 1),
        total: [...snap.concepts.keys()].filter((id) => id.startsWith(`${d}/`)).length,
      }));
    const file = path.join(root, dir, 'index.md');
    let existing: string | null = null;
    try {
      // Only ever read or write a regular file: never follow a symlink, never trip over a
      // directory that happens to be called index.md (e.g. made on the phone).
      const st = await fs.lstat(file);
      if (!st.isFile()) continue;
      existing = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (existing !== null && /^\uFEFF?---[ \t]*\r?(\n|$)/.test(existing)) continue; // a concept, not an index
    const text = renderDirIndex({ dir, list, concepts, subdirs, existing });
    if (text !== existing) {
      await write(`${dir}/index.md`, text);
      written.push(`${dir}/index.md`);
    }
  }
  return written.sort();
}
