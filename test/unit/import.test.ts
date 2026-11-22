import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importBundle } from '../../src/import.js';

const REAL_ZIP = join(homedir(), '.local/share/dead-sea-scrolls/import/bundle.zip');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dss-import-test-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Crafted zips are written with python3's zipfile (-I: isolated mode).
function craftZip(name: string, script: string): string {
  const out = join(tmp, name);
  execFileSync('python3', ['-I', '-c', script, out]);
  return out;
}

describe('importBundle', () => {
  it('imports the real zip into a fresh git repo', async () => {
    const target = join(tmp, 'bundle-ok');
    const res = await importBundle(REAL_ZIP, target);
    expect(res.count).toBe(96);
    expect(git(target, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(target, 'log', '-1', '--format=%s')).toBe('Import migrated bundle (96 titles)');
    expect(git(target, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
      'dead-sea-scrolls <dead-sea-scrolls@dead-sea-scrolls.local>|dead-sea-scrolls <dead-sea-scrolls@dead-sea-scrolls.local>',
    );
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toBe('.obsidian/\n');
    expect(git(target, 'remote')).toBe('');
    expect(git(target, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(target, 'index.md'))).toBe(true);
    expect(existsSync(join(target, 'dead-sea-scrolls'))).toBe(false);
  });

  it('refuses a count mismatch unless --expect matches', async () => {
    await expect(importBundle(REAL_ZIP, join(tmp, 'bundle-expect'), { expect: 95 })).rejects.toThrow(/96 concepts, expected 95/);
    expect(existsSync(join(tmp, 'bundle-expect'))).toBe(false);
  });

  it('refuses a non-empty target', async () => {
    const target = join(tmp, 'bundle-full');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'x');
    await expect(importBundle(REAL_ZIP, target)).rejects.toThrow(/not empty/);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('accepts an existing empty target', async () => {
    const target = join(tmp, 'bundle-empty');
    mkdirSync(target);
    await expect(importBundle(REAL_ZIP, target)).resolves.toMatchObject({ count: 96 });
  });

  it('rejects a ../ entry', async () => {
    const zip = craftZip(
      'dotdot.zip',
      `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('dead-sea-scrolls/index.md', 'x')
z.writestr('dead-sea-scrolls/../evil', 'x')
z.close()`,
    );
    const target = join(tmp, 'bundle-dotdot');
    await expect(importBundle(zip, target, { expect: 0 })).rejects.toThrow(/'\.\.' segment/);
    expect(existsSync(target)).toBe(false);
  });

  it('rejects an entry outside the top folder', async () => {
    const zip = craftZip(
      'outside.zip',
      `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('other/index.md', 'x')
z.close()`,
    );
    await expect(importBundle(zip, join(tmp, 'bundle-outside'), { expect: 0 })).rejects.toThrow(/not under/);
  });

  it('rejects a symlink entry', async () => {
    const zip = craftZip(
      'symlink.zip',
      `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('dead-sea-scrolls/index.md', 'x')
i = zipfile.ZipInfo('dead-sea-scrolls/link')
i.create_system = 3
i.external_attr = (0o120777 << 16)
z.writestr(i, '/etc/passwd')
z.close()`,
    );
    const target = join(tmp, 'bundle-symlink');
    await expect(importBundle(zip, target, { expect: 0 })).rejects.toThrow(/symlink/);
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a .git/config fsmonitor payload and never runs it', async () => {
    const marker = join(tmp, 'PWNED');
    const zip = craftZip(
      'gitcfg.zip',
      `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('dead-sea-scrolls/index.md', 'x')
z.writestr('dead-sea-scrolls/.git/config', '[core]\\n\\tfsmonitor = "touch ${marker}; echo"\\n')
z.close()`,
    );
    const target = join(tmp, 'bundle-gitcfg');
    await expect(importBundle(zip, target, { expect: 0 })).rejects.toThrow(/dot-prefixed/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a dot directory entry', async () => {
    const zip = craftZip(
      'dotdir.zip',
      `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('dead-sea-scrolls/index.md', 'x')
z.writestr('dead-sea-scrolls/.obsidian/x', 'x')
z.close()`,
    );
    await expect(importBundle(zip, join(tmp, 'bundle-dotdir'), { expect: 0 })).rejects.toThrow(/dot-prefixed/);
  });

  it('rejects an entry name containing a newline', async () => {
    const zip = craftZip(
      'newline.zip',
      `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('dead-sea-scrolls/index.md', 'x')
z.writestr('dead-sea-scrolls/a\\nb', 'x')
z.close()`,
    );
    await expect(importBundle(zip, join(tmp, 'bundle-nl'), { expect: 0 })).rejects.toThrow(/Refusing zip/);
  });
});
