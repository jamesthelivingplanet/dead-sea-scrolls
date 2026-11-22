import fs from 'node:fs/promises';
import path from 'node:path';
import { commitPaths, type Author } from './git.js';

/**
 * Records every bundle path a write touches, so the write commits only those paths and,
 * if it fails before committing, puts their original bytes back. Restoring original bytes
 * (not HEAD) keeps any uncommitted phone edits intact. UNLOCKED: the caller holds the lock.
 */
export class Tx {
  private readonly orig = new Map<string, Buffer | null>();
  private readonly createdDirs: string[] = [];

  constructor(readonly root: string) {}

  private abs(rel: string): string {
    return path.join(this.root, rel);
  }

  private async remember(rel: string): Promise<void> {
    if (this.orig.has(rel)) return;
    try {
      this.orig.set(rel, await fs.readFile(this.abs(rel)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.orig.set(rel, null);
    }
  }

  /** mkdir -p for a bundle-relative dir, remembering what it created. */
  async mkdirp(relDir: string): Promise<void> {
    let cur = '';
    for (const seg of relDir.split('/').filter((s) => s !== '' && s !== '.')) {
      cur = cur ? `${cur}/${seg}` : seg;
      try {
        await fs.mkdir(this.abs(cur));
        this.createdDirs.push(cur);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }

  async write(rel: string, text: string, opts?: { exclusive?: boolean }): Promise<void> {
    await this.remember(rel);
    await this.mkdirp(path.posix.dirname(rel));
    await fs.writeFile(this.abs(rel), text, opts?.exclusive ? { flag: 'wx' } : undefined);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.remember(from);
    await this.remember(to);
    await this.mkdirp(path.posix.dirname(to));
    await fs.rename(this.abs(from), this.abs(to));
  }

  async unlink(rel: string): Promise<void> {
    await this.remember(rel);
    await fs.unlink(this.abs(rel));
  }

  async rmdir(relDir: string): Promise<void> {
    await fs.rmdir(this.abs(relDir));
  }

  paths(): string[] {
    return [...this.orig.keys()];
  }

  /** Puts every touched path back as it was before this transaction. Best effort. */
  async rollback(): Promise<void> {
    for (const [rel, buf] of this.orig) {
      try {
        if (buf === null) {
          await fs.rm(this.abs(rel), { force: true });
        } else {
          await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
          await fs.writeFile(this.abs(rel), buf);
        }
      } catch {
        /* keep restoring the rest */
      }
    }
    for (const d of [...this.createdDirs].reverse()) {
      await fs.rmdir(this.abs(d)).catch(() => undefined);
    }
  }

  /** Commits exactly the touched paths. Returns null when none of them changed. */
  commit(message: string, author: Author): Promise<string | null> {
    return commitPaths(this.root, message, author, this.paths());
  }
}

/** Runs fn in a transaction; on any error the touched paths are restored and the error rethrown. */
export async function inTx<T>(root: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = new Tx(root);
  try {
    return await fn(tx);
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}
