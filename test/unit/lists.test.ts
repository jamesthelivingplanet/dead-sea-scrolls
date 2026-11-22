import { describe, expect, it } from 'vitest';
import {
  ALL_STATUSES, LISTS, LIST_STATUSES, aliasStatus, defaultStatus, isList, isValidStatus, statusTitle,
} from '../../src/domain/lists.js';

describe('lists', () => {
  it('knows the six lists', () => {
    expect(LISTS).toHaveLength(6);
    expect(isList('anime')).toBe(true);
    expect(isList('music')).toBe(false);
  });
  it('defaults and validity', () => {
    expect(defaultStatus('books')).toBe('to-read');
    expect(defaultStatus('games')).toBe('to-play');
    expect(isValidStatus('movies', 'in-progress')).toBe(false);
    expect(isValidStatus('movies', 'complete')).toBe(true);
    expect(isValidStatus('anime', 5)).toBe(false);
    expect(LIST_STATUSES.series).toEqual(LIST_STATUSES.anime);
  });
  it('status titles', () => {
    expect(statusTitle('caught-up')).toBe('Caught Up');
    expect(statusTitle('currently-reading')).toBe('Currently Reading');
    expect(statusTitle('to-watch')).toBe('To Watch');
  });
  it('ALL_STATUSES is the union', () => {
    expect(ALL_STATUSES).toContain('skipped');
    expect(ALL_STATUSES).toContain('to-play');
    expect(new Set(ALL_STATUSES).size).toBe(ALL_STATUSES.length);
  });
  it('aliases', () => {
    expect(aliasStatus('anime', 'Watching')).toBe('in-progress');
    expect(aliasStatus('anime', '  WANT TO WATCH ')).toBe('to-watch');
    expect(aliasStatus('anime', 'done')).toBe('complete');
    expect(aliasStatus('books', 'reading')).toBe('currently-reading');
    expect(aliasStatus('books', 'read')).toBe('finished');
    expect(aliasStatus('games', 'playing')).toBe('in-progress');
    expect(aliasStatus('books', 'done')).toBeNull(); // complete not allowed in books
    expect(aliasStatus('movies', 'watching')).toBeNull(); // in-progress not allowed
    expect(aliasStatus('anime', 'whatever')).toBeNull();
    expect(aliasStatus('anime', 'constructor')).toBeNull();
  });
});
