import { execFile } from 'node:child_process';
import { slugify } from './domain/slug.js';

export interface Author {
  name: string;
  email: string;
}

const DEFAULT_NAME = 'dead-sea-scrolls';

export function authorFor(clientName?: string | null): Author {
  let name = (clientName ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '')
    .trim();
  name = name.slice(0, 100).trim();
  // Git strips these from the ends of ident names; a name made only of them is rejected.
  name = name.replace(/^[\s.,:;<>"'\\]+|[\s.,:;<>"'\\]+$/g, '');
  if (!/[\p{L}\p{N}]/u.test(name)) name = DEFAULT_NAME;
  const local = slugify(name) || DEFAULT_NAME;
  return { name, email: `${local}@dead-sea-scrolls.local` };
}

export const SYSTEM_AUTHOR: Author = {
  name: DEFAULT_NAME,
  email: 'dead-sea-scrolls@dead-sea-scrolls.local',
};

export function git(root: string, args: string[], opts?: { author?: Author }): Promise<string> {
  const author = opts?.author ?? SYSTEM_AUTHOR;
  const full = [
    '-c', `user.name=${author.name}`,
    '-c', `user.email=${author.email}`,
    '-c', 'commit.gpgsign=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.quotepath=off',
    '-c', 'init.defaultBranch=main',
    ...args,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      full,
      {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_LITERAL_PATHSPECS: '1' },
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).toString().trim();
          reject(new Error(`git ${args[0] ?? ''} failed: ${detail}`));
        } else resolve(stdout);
      },
    );
  });
}

export async function commitAll(root: string, message: string, author: Author): Promise<string | null> {
  await git(root, ['add', '-A'], { author });
  const staged = await git(root, ['diff', '--cached', '--name-only', '-z'], { author });
  if (staged === '') return null;
  await git(root, ['commit', '-q', '-m', message], { author });
  return (await git(root, ['rev-parse', 'HEAD'], { author })).trim();
}

/**
 * Commits only the given bundle-relative paths (others stay uncommitted, e.g. phone edits that
 * have not been synced in yet). Unstages everything first, so stray staged changes never ride
 * along. Returns null when none of the paths changed.
 */
export async function commitPaths(root: string, message: string, author: Author, paths: string[]): Promise<string | null> {
  if (paths.length === 0) return null;
  await git(root, ['reset', '-q'], { author });
  const out = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths], { author });
  const parts = out.split('\0').filter((p) => p !== '');
  const changed: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    changed.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') changed.push(parts[++i]!);
  }
  if (changed.length === 0) return null;
  await git(root, ['add', '-A', '--', ...changed], { author });
  await git(root, ['commit', '-q', '-m', message], { author });
  return (await git(root, ['rev-parse', 'HEAD'], { author })).trim();
}

export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain', '-z'])).length > 0;
}

/** Changes between `rev` and HEAD (name-status, renames detected). status is the letter only: A, M, D, R, C, T. */
export async function changedSince(
  root: string,
  rev: string,
): Promise<{ status: string; path: string; from?: string }[]> {
  const out = await git(root, ['diff', '--name-status', '-M', '-z', rev, 'HEAD', '--']);
  const parts = out.split('\0');
  const result: { status: string; path: string; from?: string }[] = [];
  let i = 0;
  while (i < parts.length && parts[i] !== '') {
    const status = parts[i]![0]!;
    if (status === 'R' || status === 'C') {
      result.push({ status, from: parts[i + 1]!, path: parts[i + 2]! });
      i += 3;
    } else {
      result.push({ status, path: parts[i + 1]! });
      i += 2;
    }
  }
  return result;
}
