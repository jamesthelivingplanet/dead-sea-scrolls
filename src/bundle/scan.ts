import fs from 'node:fs/promises';
import path from 'node:path';
import { isList, type ListName } from '../domain/lists.js';
import { parseConceptText } from './frontmatter.js';
import { computeProblems } from './problems.js';

export interface Concept {
  id: string;
  file: string;
  dir: string;
  name: string;
  list: ListName | null;
  raw: string;
  frontmatter: Record<string, unknown> | null;
  frontmatterState: 'ok' | 'missing' | 'unparseable';
  body: string;
  problems: string[];
}

export interface BundleSnapshot {
  root: string;
  concepts: Map<string, Concept>;
  dirs: string[];
}

function isGone(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function scanBundle(root: string): Promise<BundleSnapshot> {
  const files: string[] = [];
  const dirs: string[] = [];

  async function walk(rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch (e) {
      if (rel !== '' && isGone(e)) return;
      throw e;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        dirs.push(relPath);
        await walk(relPath);
      } else if (e.isFile()) {
        if (!e.name.endsWith('.md') || e.name === 'index.md' || e.name === 'log.md') continue;
        files.push(relPath);
      }
    }
  }
  await walk('');

  const builtAll = await Promise.all(
    files.map(async (file): Promise<Concept | null> => {
      let raw: string;
      let readError: string | null = null;
      try {
        raw = await fs.readFile(path.join(root, file), 'utf8');
      } catch (e) {
        if (isGone(e)) return null;
        raw = '';
        readError = e instanceof Error ? e.message : String(e);
      }
      const id = file.slice(0, -3);
      const slash = id.lastIndexOf('/');
      const dir = slash === -1 ? '' : id.slice(0, slash);
      const name = slash === -1 ? id : id.slice(slash + 1);
      const top = id.split('/')[0]!;
      const list = dir !== '' && isList(top) ? top : null;
      if (readError !== null) {
        const failed: Omit<Concept, 'problems'> = {
          id, file, dir, name, list, raw: '', frontmatter: null, frontmatterState: 'missing', body: '',
        };
        const problems = computeProblems(failed).filter((p) => p !== 'no frontmatter');
        return { ...failed, problems: [`file could not be read: ${readError}`, ...problems] };
      }
      const parsed = parseConceptText(raw);
      const base: Omit<Concept, 'problems'> = {
        id,
        file,
        dir,
        name,
        list,
        raw,
        frontmatter: parsed.kind === 'ok' ? parsed.data : null,
        frontmatterState: parsed.kind,
        body: parsed.body,
      };
      return { ...base, problems: computeProblems(base) };
    }),
  );
  const built = builtAll.filter((c): c is Concept => c !== null);
  built.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  dirs.sort();
  return { root, concepts: new Map(built.map((c) => [c.id, c])), dirs };
}
