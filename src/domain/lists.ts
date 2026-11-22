export const LISTS = ['anime', 'western-animation', 'movies', 'series', 'books', 'games'] as const;
export type ListName = (typeof LISTS)[number];

export const LIST_TYPES: Record<ListName, string> = {
  anime: 'Anime',
  'western-animation': 'Western Animation',
  movies: 'Movie',
  series: 'Series',
  books: 'Book',
  games: 'Game',
};

const WATCH = ['to-watch', 'in-progress', 'caught-up', 'complete', 'dropped', 'archived'] as const;

export const LIST_STATUSES: Record<ListName, readonly string[]> = {
  anime: WATCH,
  'western-animation': WATCH,
  series: WATCH,
  movies: ['to-watch', 'complete', 'dropped', 'archived'],
  books: ['to-read', 'currently-reading', 'finished', 'dropped', 'skipped', 'archived'],
  games: ['to-play', 'in-progress', 'complete', 'dropped', 'archived'],
};

export const ALL_STATUSES: string[] = [...new Set(LISTS.flatMap((l) => LIST_STATUSES[l]))];

export const OKF_STATUSES = ['draft', 'stable', 'deprecated'] as const;
export const NOTE_TYPE = 'Note';

/** `notes` or anything below it. */
export function isNotesPath(p: string): boolean {
  return p === 'notes' || p.startsWith('notes/');
}

export function isList(s: string): s is ListName {
  return (LISTS as readonly string[]).includes(s);
}

export function defaultStatus(list: ListName): string {
  return LIST_STATUSES[list][0]!;
}

export function isValidStatus(list: ListName, status: unknown): boolean {
  return typeof status === 'string' && LIST_STATUSES[list].includes(status);
}

export function statusTitle(status: string): string {
  return status
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

const ALIASES: Record<string, string> = {
  watching: 'in-progress',
  watched: 'complete',
  done: 'complete',
  reading: 'currently-reading',
  read: 'finished',
  playing: 'in-progress',
  'want to watch': 'to-watch',
};

/** Case-insensitive, trimmed alias lookup; null if no alias or not allowed in the list. */
export function aliasStatus(list: ListName, value: string): string | null {
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!Object.hasOwn(ALIASES, key)) return null;
  const target = ALIASES[key]!;
  return LIST_STATUSES[list].includes(target) ? target : null;
}
