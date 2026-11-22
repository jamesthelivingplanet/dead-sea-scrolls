import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SYSTEM_AUTHOR, authorFor, changedSince, commitAll, git, isDirty,
} from '../../src/git.js';

describe('authorFor', () => {
  it('defaults', () => {
    expect(authorFor()).toEqual(SYSTEM_AUTHOR);
    expect(authorFor(null)).toEqual(SYSTEM_AUTHOR);
    expect(authorFor('  \n<>  ')).toEqual(SYSTEM_AUTHOR);
  });
  it('uses and slugs the client name', () => {
    expect(authorFor('Agent')).toEqual({ name: 'Agent', email: 'agent@dead-sea-scrolls.local' });
    expect(authorFor('agent/migration').email).toBe('agent-migration@dead-sea-scrolls.local');
  });
  it('strips crud and falls back when no letter or digit remains', () => {
    expect(authorFor(';')).toEqual(SYSTEM_AUTHOR);
    expect(authorFor('Agent.').name).toBe('Agent');
    expect(authorFor(' ."Agent,;').name).toBe('Agent');
  });
  it('sanitizes', () => {
    expect(authorFor('Ev<il>\nName\u0007').name).toBe('EvilName');
    expect(authorFor('x'.repeat(300)).name).toHaveLength(100);
    expect(authorFor('!!!').email).toBe('dead-sea-scrolls@dead-sea-scrolls.local');
  });
});

describe('git wrapper', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-git-'));
    await git(root, ['init', '-q']);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('commitAll returns null when nothing is staged, else the full hash', async () => {
    expect(await commitAll(root, 'empty', SYSTEM_AUTHOR)).toBeNull();
    await fs.writeFile(path.join(root, 'a.md'), 'a\n');
    expect(await isDirty(root)).toBe(true);
    const h = await commitAll(root, 'Add a', authorFor('Agent'));
    expect(h).toMatch(/^[0-9a-f]{40}$/);
    expect(await isDirty(root)).toBe(false);
    expect(await commitAll(root, 'again', SYSTEM_AUTHOR)).toBeNull();
    const log = await git(root, ['log', '-1', '--format=%an <%ae>|%s']);
    expect(log.trim()).toBe('Agent <agent@dead-sea-scrolls.local>|Add a');
  });

  it('commits with a crud-only client name', async () => {
    await fs.writeFile(path.join(root, 'a.md'), 'a\n');
    expect(await commitAll(root, 'semi', authorFor(';'))).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changedSince reports add, modify, delete, rename; unicode paths unquoted', async () => {
    await fs.writeFile(path.join(root, 'keep.md'), 'keep\nkeep\nkeep\n');
    await fs.writeFile(path.join(root, 'gone.md'), 'gone\n');
    await fs.writeFile(path.join(root, 'old.md'), 'a long enough text body\nline two\nline three\n');
    const base = (await commitAll(root, 'base', SYSTEM_AUTHOR))!;
    await fs.writeFile(path.join(root, 'keep.md'), 'keep\nkeep\nchanged\n');
    await fs.rm(path.join(root, 'gone.md'));
    await fs.rename(path.join(root, 'old.md'), path.join(root, 'né.md'));
    await fs.writeFile(path.join(root, 'new.md'), 'brand new\n');
    await commitAll(root, 'changes', SYSTEM_AUTHOR);
    const ch = await changedSince(root, base);
    const by = Object.fromEntries(ch.map((c) => [c.path, c]));
    expect(by['keep.md']!.status).toBe('M');
    expect(by['gone.md']!.status).toBe('D');
    expect(by['new.md']!.status).toBe('A');
    expect(by['né.md']).toMatchObject({ status: 'R', from: 'old.md' });
  });

  it('never touches global config and does not use a shell', async () => {
    await expect(git(root, ['log'])).rejects.toThrow();
    await expect(git(root, ['checkout', '; touch pwned'])).rejects.toThrow();
  });
});
