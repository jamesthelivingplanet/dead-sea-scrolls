import fs from 'node:fs/promises';
import path from 'node:path';
import { computeProblems } from './bundle/problems.js';
import { replaceFrontmatter, setFrontmatterKeys } from './bundle/frontmatter.js';
import { regenerateIndexes } from './bundle/indexgen.js';
import { scanBundle, type Concept } from './bundle/scan.js';
import { SYSTEM_AUTHOR } from './git.js';
import { inTx } from './tx.js';
import { aliasStatus, defaultStatus, LIST_TYPES } from './domain/lists.js';
import { fileNameMatchesTitle, slugify, uniqueName } from './domain/slug.js';
import { relocateConcept } from './ops/write.js';

export interface RepairResult {
  id: string;
  newId: string;
  fixed: string[];
  commit: string | null;
  problems: string[];
}


function headingTitle(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m && m[1]!.trim() !== '') return m[1]!.trim();
  }
  return null;
}

async function readConcept(root: string, id: string): Promise<Concept | null> {
  // Scanning the whole bundle is wasteful for one file, but keeps parsing in one place.
  const snap = await scanBundle(root);
  return snap.concepts.get(id) ?? null;
}

/**
 * Applies the deterministic fixes to one concept and commits them (one commit, system author).
 * UNLOCKED: the caller holds the write lock. `generated` is deliberately left alone: repairs are
 * not MCP content changes. Never deletes; files it cannot fix safely are returned untouched.
 */
export async function repairConcept(root: string, id: string): Promise<RepairResult> {
  const c = await readConcept(root, id);
  if (!c) return { id, newId: id, fixed: [], commit: null, problems: ['concept not found'] };
  const untouched = (): RepairResult => ({ id, newId: id, fixed: [], commit: null, problems: c.problems });
  if (c.list === null || c.frontmatterState === 'unparseable') return untouched();

  const list = c.list;
  const fixed: string[] = [];
  let text = c.raw;
  let title: string;

  if (c.frontmatterState === 'missing') {
    title = headingTitle(c.body) ?? c.name;
    text = replaceFrontmatter(text, {
      type: LIST_TYPES[list],
      title,
      list_status: defaultStatus(list),
    });
    fixed.push('added frontmatter');
  } else {
    const fm = c.frontmatter!;
    const patch: Record<string, unknown> = {};
    const hasType = typeof fm.type === 'string' && fm.type.trim() !== '';
    if (!hasType || fm.type !== LIST_TYPES[list]) {
      patch.type = LIST_TYPES[list];
      fixed.push(hasType ? `type '${String(fm.type)}' -> '${LIST_TYPES[list]}'` : `added type '${LIST_TYPES[list]}'`);
    }
    const ls = fm.list_status;
    if (ls === undefined || ls === null || (typeof ls === 'string' && ls.trim() === '')) {
      patch.list_status = defaultStatus(list);
      fixed.push(`added list_status '${defaultStatus(list)}'`);
    } else if (typeof ls === 'string') {
      const alias = aliasStatus(list, ls);
      if (alias !== null && alias !== ls) {
        patch.list_status = alias;
        fixed.push(`list_status '${ls}' -> '${alias}'`);
      }
    }
    if (Object.keys(patch).length > 0) text = setFrontmatterKeys(text, patch);
    title = typeof fm.title === 'string' ? fm.title.trim() : '';
  }

  const needsRename = title !== '' && !fileNameMatchesTitle(c.name, title);
  if (text === c.raw && !needsRename) return untouched();

  const dirs = new Set<string>([c.dir]);
  let newId = id;
  const commit = await inTx(root, async (tx) => {
  if (text !== c.raw) await tx.write(c.file, text);
  if (needsRename) {
    const dirAbs = path.join(root, c.dir);
    // The concept's own file does not count as taken: 'Dune.md' titled Dune becomes 'dune.md', not 'dune-2.md'.
    const taken = new Set((await fs.readdir(dirAbs)).filter((e) => e !== c.name + '.md').map((e) => e.toLowerCase()));
    const newName = uniqueName(slugify(title) || 'untitled', (n) => taken.has(`${n}.md`) || taken.has(n) || n.toLowerCase() === 'index' || n.toLowerCase() === 'log');
    newId = `${c.dir}/${newName}`;
    const moved = await relocateConcept(root, id, newId, tx);
    for (const d of moved.touchedDirs) dirs.add(d);
    fixed.push(`renamed ${c.name} to ${newName}`);
  }

  await regenerateIndexes(root, [...dirs].filter((d) => d !== ''), (rel, t) => tx.write(rel, t));
  return tx.commit(`Fix ${title !== '' ? title : c.name}: ${fixed.join(', ')}`, SYSTEM_AUTHOR);
  });
  const after = await readConcept(root, newId);
  const problems = after ? after.problems : computeProblems({ ...c, id: newId } as Omit<Concept, 'problems'>);
  return { id, newId, fixed, commit, problems };
}
