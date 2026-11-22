import { LIST_TYPES, OKF_STATUSES, isValidStatus } from '../domain/lists.js';
import { parseConceptText } from './frontmatter.js';
import type { Concept } from './scan.js';

function present(v: unknown): boolean {
  return !(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''));
}

export function computeProblems(c: Omit<Concept, 'problems'>): string[] {
  const out: string[] = [];
  if (c.frontmatterState === 'missing') out.push('no frontmatter');
  else if (c.frontmatterState === 'unparseable') {
    const parsed = parseConceptText(c.raw);
    const error = parsed.kind === 'unparseable' ? parsed.error : 'invalid YAML';
    out.push(`frontmatter does not parse: ${error}`);
  }

  if (c.dir === '') out.push('concept is at the bundle root, not in a list');

  const fm = c.frontmatter;
  if (c.frontmatterState !== 'ok' || fm === null) return out;

  if (fm.title !== undefined && fm.title !== null && typeof fm.title !== 'string') out.push('title should be text');
  else if (typeof fm.title !== 'string' || fm.title.trim() === '') out.push('missing title');

  if (fm.tags !== undefined && fm.tags !== null) {
    if (!Array.isArray(fm.tags) || fm.tags.some((t) => typeof t !== 'string')) {
      out.push('tags should be a list of strings');
    }
  }

  if (c.list === null) {
    // Area (notes included): no list_status, no type check; only status is validated.
    const st = fm.status;
    if (present(st) && !(OKF_STATUSES as readonly string[]).includes(st as string)) {
      out.push(`invalid status '${String(st)}' (allowed: ${OKF_STATUSES.join(', ')})`);
    }
    return out;
  }

  const expected = LIST_TYPES[c.list];
  if (!present(fm.type)) out.push(`missing type, should be '${expected}'`);
  else if (fm.type !== expected) out.push(`type '${String(fm.type)}' should be '${expected}' for ${c.list}`);

  if (!present(fm.list_status)) out.push('missing list_status');
  else if (!isValidStatus(c.list, fm.list_status)) {
    out.push(`invalid list_status '${String(fm.list_status)}' for ${c.list}`);
  }
  return out;
}
