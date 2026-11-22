import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { commitAll, git, SYSTEM_AUTHOR } from '../../src/git.js';

const run = promisify(execFile);
// Read only: never write to the zip or to ~/.local/share/dead-sea-scrolls.
const ZIP = path.join(os.homedir(), '.local/share/dead-sea-scrolls/import/bundle.zip');

/** Extracts the migrated bundle into a fresh temp dir (each call gets its own copy). */
export async function makeTempBundle(
  opts?: { git?: boolean },
): Promise<{ root: string; cleanup(): Promise<void> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-bundle-'));
  const cleanup = () => fs.rm(tmp, { recursive: true, force: true });
  try {
    await run('unzip', ['-q', ZIP, '-d', tmp]);
    const root = path.join(tmp, 'dead-sea-scrolls');
    if (opts?.git) {
      await git(root, ['init', '-q']);
      await fs.writeFile(path.join(root, '.gitignore'), '.obsidian/\n');
      await commitAll(root, 'Import migrated bundle (96 titles)', SYSTEM_AUTHOR);
    }
    return { root, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
