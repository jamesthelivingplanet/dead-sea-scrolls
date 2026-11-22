// One-time import of the migrated bundle zip. Runs on the host (via `mise run import`),
// uses only node built-ins plus the unzip and git CLIs. The zip is untrusted data.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const TOP = 'dead-sea-scrolls';
const DEFAULT_EXPECT = 96;
const AUTHOR = { name: 'dead-sea-scrolls', email: 'dead-sea-scrolls@dead-sea-scrolls.local' };

export interface ImportResult {
  count: number;
  message: string;
}

export function validateEntryName(name: string): string | null {
  if (name === '') return 'empty entry name';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control character';
  if (name.includes('\\')) return 'backslash';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute path';
  const segments = name.split('/');
  if (segments.some((s) => s === '..')) return "'..' segment";
  if (segments.some((s) => s === '.')) return "'.' segment";
  if (name !== TOP && name !== `${TOP}/` && !name.startsWith(`${TOP}/`)) return `not under ${TOP}/`;
  // Dot-prefixed segments below the top folder (.git, .obsidian, ...) are never legitimate content.
  if (segments.slice(1).some((s) => s.startsWith('.'))) return 'dot-prefixed path segment';
  return null;
}

const MAX_UNCOMPRESSED = 50 * 1024 * 1024;

async function listEntries(zip: string): Promise<string[]> {
  const { stdout } = await run('unzip', ['-Z1', zip], { maxBuffer: 64 * 1024 * 1024 });
  const names = stdout.split('\n').filter((l) => l.length > 0);
  const { stdout: totals } = await run('zipinfo', ['-t', zip], { maxBuffer: 1024 * 1024 });
  const m = /(\d+) files?, (\d+) bytes uncompressed/.exec(totals);
  if (!m) throw new Error('Refusing zip: cannot read entry totals');
  // A name containing a newline would split into several lines, so the counts would disagree.
  if (Number(m[1]) !== names.length) throw new Error('Refusing zip: ambiguous entry listing');
  if (Number(m[2]) > MAX_UNCOMPRESSED) throw new Error(`Refusing zip: ${m[2]} bytes uncompressed exceeds ${MAX_UNCOMPRESSED}`);
  return names;
}

async function assertNoSpecialEntries(zip: string): Promise<void> {
  const { stdout } = await run('zipinfo', [zip], { maxBuffer: 64 * 1024 * 1024 });
  for (const line of stdout.split('\n')) {
    const m = /^([-dlbcps])[rwxsStT-]+\s/.exec(line);
    if (m && m[1] !== '-' && m[1] !== 'd') {
      throw new Error(`Refusing zip: contains a ${m[1] === 'l' ? 'symlink' : 'special'} entry`);
    }
  }
}

function walk(dir: string, visit: (path: string, rel: string, isDir: boolean) => void, rel = ''): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    visit(join(dir, e.name), r, e.isDirectory());
    if (e.isDirectory()) walk(join(dir, e.name), visit, r);
  }
}

export function countConcepts(root: string): number {
  let n = 0;
  const go = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) go(join(dir, e.name));
      } else if (e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== 'log.md') n++;
    }
  };
  go(root);
  return n;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await run(
    'git',
    [
      '-c', `user.name=${AUTHOR.name}`,
      '-c', `user.email=${AUTHOR.email}`,
      '-c', 'commit.gpgsign=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
  );
}

export async function importBundle(zipArg: string, bundleArg: string, opts: { expect?: number } = {}): Promise<ImportResult> {
  const zip = resolve(zipArg);
  const bundleDir = resolve(bundleArg);
  const expect = opts.expect ?? DEFAULT_EXPECT;

  if (!existsSync(zip)) throw new Error(`Zip not found: ${zip}`);
  if (existsSync(bundleDir)) {
    if (!lstatSync(bundleDir).isDirectory()) throw new Error(`Refusing: ${bundleDir} exists and is not a directory`);
    if (readdirSync(bundleDir).length > 0) throw new Error(`Refusing: ${bundleDir} is not empty`);
  }

  const entries = await listEntries(zip);
  if (entries.length === 0) throw new Error('Refusing zip: no entries');
  for (const name of entries) {
    const problem = validateEntryName(name);
    if (problem) throw new Error(`Refusing zip: entry ${JSON.stringify(name)}: ${problem}`);
  }
  await assertNoSpecialEntries(zip);

  const tmp = mkdtempSync(join(tmpdir(), 'dss-import-'));
  const bundleExisted = existsSync(bundleDir);
  try {
    await run('unzip', ['-n', '-q', zip, '-d', tmp]);
    const top = join(tmp, TOP);
    if (!existsSync(top) || !lstatSync(top).isDirectory()) throw new Error(`Refusing zip: no ${TOP}/ folder`);
    // Defence in depth: nothing extracted may be a symlink or other special file.
    // Every extracted path must be one of the validated listed names (catches names that
    // `unzip -Z1` displays differently from what it writes, e.g. control characters).
    const listed = new Set(entries.map((e) => e.replace(/\/+$/, '')));
    walk(tmp, (p, rel, isDir) => {
      const st = lstatSync(p);
      if (!isDir && !st.isFile()) throw new Error(`Refusing zip: extracted non-regular file ${rel}`);
      if (/[\u0000-\u001f\u007f]/.test(rel)) throw new Error('Refusing zip: entry name with control characters');
      if (rel.split('/').slice(1).some((s) => s.startsWith('.'))) throw new Error(`Refusing zip: dot-prefixed path segment in ${rel}`);
      if (!isDir && !listed.has(rel)) throw new Error(`Refusing zip: extracted file ${JSON.stringify(rel)} was not in the validated listing`);
    });

    const count = countConcepts(top);
    if (count !== expect) {
      throw new Error(`Refusing: found ${count} concepts, expected ${expect} (pass --expect ${count} to accept)`);
    }

    if (existsSync(join(top, '.git'))) throw new Error('Refusing zip: contains .git');
    mkdirSync(bundleDir, { recursive: true });
    for (const name of readdirSync(top)) {
      cpSync(join(top, name), join(bundleDir, name), { recursive: true });
    }
    writeFileSync(join(bundleDir, '.gitignore'), '.obsidian/\n');

    const message = `Import migrated bundle (${count} titles)`;
    try {
      if (existsSync(join(bundleDir, '.git'))) throw new Error('Refusing: .git already exists in target');
      await git(bundleDir, ['init', '-q', '-b', 'main']);
      await git(bundleDir, ['add', '-A']);
      await git(bundleDir, ['commit', '-q', '-m', message]);
    } catch (err) {
      // Leave the target as we found it so the import can be retried.
      for (const name of readdirSync(bundleDir)) rmSync(join(bundleDir, name), { recursive: true, force: true });
      if (!bundleExisted) rmSync(bundleDir, { recursive: true, force: true });
      throw err;
    }
    return { count, message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<void> {
  const args: string[] = [];
  let expect: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expect') {
      expect = Number(argv[++i]);
      if (!Number.isInteger(expect) || expect < 0) throw new Error('--expect needs a non-negative integer');
    } else args.push(argv[i]!);
  }
  if (args.length !== 2) throw new Error('Usage: node dist/import.js <bundle.zip> <bundleDir> [--expect N]');
  const result = await importBundle(args[0]!, args[1]!, { expect });
  console.log(`${result.message}: imported into ${resolve(args[1]!)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
