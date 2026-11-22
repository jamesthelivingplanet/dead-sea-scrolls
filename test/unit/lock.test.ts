import { describe, expect, it } from 'vitest';
import { Mutex } from '../../src/lock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Mutex', () => {
  it('runs FIFO and never overlaps', async () => {
    const m = new Mutex();
    const log: string[] = [];
    let active = 0;
    const job = (name: string, ms: number) => m.runExclusive(async () => {
      active++;
      expect(active).toBe(1);
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      active--;
      return name;
    });
    const res = await Promise.all([job('a', 20), job('b', 1), job('c', 5)]);
    expect(res).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
  it('releases after a rejection', async () => {
    const m = new Mutex();
    const bad = m.runExclusive(async () => { throw new Error('boom'); });
    const good = m.runExclusive(async () => 42);
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe(42);
    await expect(m.runExclusive(async () => 'later')).resolves.toBe('later');
  });
  it('releases after a synchronous throw', async () => {
    const m = new Mutex();
    await expect(m.runExclusive((() => { throw new Error('sync'); }) as () => Promise<never>)).rejects.toThrow('sync');
    await expect(m.runExclusive(async () => 1)).resolves.toBe(1);
  });
});
