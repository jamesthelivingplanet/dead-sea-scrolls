const TRANSLIT: Record<string, string> = {
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};

export const MAX_SLUG = 100;

export function slugify(title: string): string {
  const lower = title.toLowerCase().replace(/[æœßøđłþı]/g, (c) => TRANSLIT[c]!);
  return lower
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
}

export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/** name === slug(title) or slug(title)-<n>, n >= 2. */
export function fileNameMatchesTitle(name: string, title: string): boolean {
  const slug = slugify(title) || 'untitled';
  if (name === slug) return true;
  if (!name.startsWith(`${slug}-`)) return false;
  const rest = name.slice(slug.length + 1);
  return /^\d+$/.test(rest) && Number(rest) >= 2;
}
