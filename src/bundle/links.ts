import { posix as path } from 'node:path';

export interface LinkRef {
  kind: 'md' | 'wiki';
  /** Offset of the first character of the link in the text (for wikilinks: the first `[`, not a leading `!`). */
  start: number;
  /** Offset just past the last character of the link. */
  end: number;
  /** The exact source text, `text.slice(start, end)`. */
  text: string;
  /**
   * md: the raw destination as written (no angle brackets, no title), still percent-encoded
   *     and including any `#fragment` / `?query`.
   * wiki: the note name part only (no `#heading`, no `|alias`, no trailing `.md`).
   */
  target: string;
}

interface Internal extends LinkRef {
  destStart: number; // md only: offsets of the destination (inside angle brackets if any)
  destEnd: number;
  angle: boolean;
}

// ---------------------------------------------------------------------------
// Code masking
// ---------------------------------------------------------------------------

function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lineRe = /[^\n]*(?:\n|$)/g;
  let fence: { ch: string; len: number; start: number } | null = null;
  let chunkStart = 0; // start of the current non-fenced chunk
  let pos = 0;
  const inlineIn = (from: number, to: number): void => {
    const seg = text.slice(from, to);
    const re = /`+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg))) {
      const n = m[0].length;
      const open = m.index;
      const closeRe = new RegExp('(?<!`)`{' + n + '}(?!`)', 'g');
      closeRe.lastIndex = open + n;
      const c = closeRe.exec(seg);
      if (c) {
        ranges.push([from + open, from + c.index + n]);
        re.lastIndex = c.index + n;
      }
    }
  };
  while (pos < text.length) {
    lineRe.lastIndex = pos;
    const m = lineRe.exec(text)!;
    const line = m[0];
    const lineStart = pos;
    pos += line.length;
    if (line.length === 0) break;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence) {
      if (f) {
        inlineIn(chunkStart, lineStart);
        fence = { ch: f[1]![0]!, len: f[1]!.length, start: lineStart };
      }
    } else if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len && /^\s*$/.test(line.slice(f[0].length))) {
      ranges.push([fence.start, pos]);
      fence = null;
      chunkStart = pos;
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  else inlineIn(chunkStart, text.length);
  return ranges;
}

function inRanges(ranges: Array<[number, number]>, i: number): boolean {
  for (const [s, e] of ranges) if (i >= s && i < e) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function scan(text: string): Internal[] {
  const code = codeRanges(text);
  const out: Internal[] = [];

  // Markdown links.
  const mdRe = /\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text))) {
    const start = m.index;
    if (inRanges(code, start)) continue;
    if (start > 0 && text[start - 1] === '!') continue; // image
    let i = m.index + m[0].length;
    while (text[i] === ' ' || text[i] === '\t') i++;
    let destStart: number;
    let destEnd: number;
    let angle = false;
    if (text[i] === '<') {
      angle = true;
      destStart = i + 1;
      let j = destStart;
      while (j < text.length && text[j] !== '>' && text[j] !== '\n') j++;
      if (text[j] !== '>') continue;
      destEnd = j;
      i = j + 1;
    } else {
      destStart = i;
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        const c = text[j]!;
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) break;
          depth--;
        }
      }
      destEnd = j;
      i = j;
    }
    // optional title
    const tm = /^[ \t\n]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))/.exec(text.slice(i, i + 400));
    if (tm) i += tm[0].length;
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') i++;
    if (text[i] !== ')') continue;
    const end = i + 1;
    const raw = text.slice(destStart, destEnd);
    if (!mdTargetPath(raw)) continue;
    out.push({ kind: 'md', start, end, text: text.slice(start, end), target: raw, destStart, destEnd, angle });
    mdRe.lastIndex = end;
  }

  // Wikilinks (embeds included).
  const wikiRe = /\[\[([^[\]\n|#]*)(#[^[\]\n|]*)?(\|[^[\]\n]*)?\]\]/g;
  while ((m = wikiRe.exec(text))) {
    if (inRanges(code, m.index)) continue;
    const name = m[1]!.trim().replace(/\.md$/i, '');
    if (!name) continue;
    out.push({
      kind: 'wiki',
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      target: name,
      destStart: 0,
      destEnd: 0,
      angle: false,
    });
  }

  out.sort((a, b) => a.start - b.start);
  const res: Internal[] = [];
  let lastEnd = -1;
  for (const r of out) {
    if (r.start < lastEnd) continue;
    res.push(r);
    lastEnd = r.end;
  }
  return res;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Split a raw md destination into path part and `#fragment`/`?query` suffix. */
function splitDest(raw: string): { pathRaw: string; suffix: string } {
  const i = raw.search(/[#?]/);
  return i < 0 ? { pathRaw: raw, suffix: '' } : { pathRaw: raw.slice(0, i), suffix: raw.slice(i) };
}

/** Decoded path part of an md destination, or null when it is not a link to a .md file. */
function mdTargetPath(raw: string): string | null {
  const { pathRaw } = splitDest(raw.trim());
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathRaw)) return null;
  const decoded = safeDecode(pathRaw);
  if (!/\.md$/i.test(decoded)) return null;
  return decoded;
}

/** Bundle-relative file path an md destination points to; null if not .md or escaping the bundle. */
function mdTargetFile(fromFile: string, raw: string): string | null {
  const decoded = mdTargetPath(raw);
  if (decoded === null) return null;
  let joined: string;
  if (decoded.startsWith('/')) joined = path.normalize(decoded.replace(/^\/+/, ''));
  else joined = path.normalize(path.join(path.dirname(fromFile), decoded));
  if (joined === '..' || joined.startsWith('../') || joined === '.' || joined === '' || joined.startsWith('/')) return null;
  return joined;
}

const idOfFile = (file: string): string => file.replace(/\.md$/i, '');

// ---------------------------------------------------------------------------
// Public API: finding and resolving
// ---------------------------------------------------------------------------

export function findLinks(text: string): LinkRef[] {
  return scan(text).map(({ kind, start, end, text: t, target }) => ({ kind, start, end, text: t, target }));
}

function pickShortest(cands: string[]): string | null {
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0]!;
  const depth = (s: string): number => s.split('/').length;
  return [...cands].sort((a, b) => depth(a) - depth(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0]!;
}

export function resolveWikilink(target: string, ids: Set<string>): string | null {
  let t = target.trim().replace(/\.md$/i, '').replace(/^\/+/, '');
  if (!t) return null;
  if (t.includes('/')) {
    if (ids.has(t)) return t;
    const lower = t.toLowerCase();
    const suffix = '/' + t;
    const suffixLower = '/' + lower;
    const exact: string[] = [];
    const insens: string[] = [];
    for (const id of ids) {
      if (id.endsWith(suffix)) exact.push(id);
      const il = id.toLowerCase();
      if (il === lower || il.endsWith(suffixLower)) insens.push(id);
    }
    return pickShortest(exact) ?? pickShortest(insens);
  }
  const lower = t.toLowerCase();
  const exact: string[] = [];
  const insens: string[] = [];
  for (const id of ids) {
    const name = id.slice(id.lastIndexOf('/') + 1);
    if (name === t) exact.push(id);
    else if (name.toLowerCase() === lower) insens.push(id);
  }
  return pickShortest(exact) ?? pickShortest(insens);
}

export function resolveLink(fromFile: string, ref: LinkRef, ids: Set<string>): string | null {
  if (ref.kind === 'wiki') return resolveWikilink(ref.target, ids);
  const file = mdTargetFile(fromFile, ref.target);
  if (file === null) return null;
  const id = idOfFile(file);
  return ids.has(id) ? id : null;
}

export function linksOf(fromFile: string, text: string, ids: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of findLinks(text)) {
    const id = resolveLink(fromFile, ref, ids);
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

function relativeFile(fromFile: string, targetFile: string): string {
  const rel = path.relative('/' + path.dirname(fromFile), '/' + targetFile);
  return rel;
}

/** Replace the destination of an md link with `newPath` (decoded form), keeping style. */
function replaceDest(text: string, r: Internal, newPath: string): string {
  const raw = text.slice(r.destStart, r.destEnd);
  const { pathRaw, suffix } = splitDest(raw);
  const wasEncoded = safeDecode(pathRaw) !== pathRaw;
  let p = newPath;
  let angle = r.angle;
  if (wasEncoded) p = p.replace(/%/g, '%25').replace(/ /g, '%20');
  else if (!angle && /[ \t]/.test(p)) angle = true;
  const dest = p + suffix;
  const before = text.slice(r.start, r.destStart);
  const after = text.slice(r.destEnd, r.end);
  if (angle === r.angle) return before + dest + after;
  // switching to angle brackets (only happens when not already in them)
  return before + '<' + dest + '>' + after;
}

function applyEdits(text: string, edits: Array<{ start: number; end: number; repl: string }>): string {
  if (edits.length === 0) return text;
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += text.slice(last, e.start) + e.repl;
    last = e.end;
  }
  return out + text.slice(last);
}

/**
 * Rewrite links in `text` that resolved to `oldId` so they point to `newId`.
 * `fromFile` is where `text` currently lives (relative md links are interpreted
 * against its directory and recomputed against it). `idsAfter` is the id set after
 * the move; the set before the move is derived from it.
 */
export function rewriteIncoming(fromFile: string, text: string, oldId: string, newId: string, idsAfter: Set<string>): string {
  const idsBefore = new Set(idsAfter);
  idsBefore.delete(newId);
  idsBefore.add(oldId);
  const edits: Array<{ start: number; end: number; repl: string }> = [];
  for (const r of scan(text)) {
    if (resolveLink(fromFile, r, idsBefore) !== oldId) continue;
    let repl: string;
    if (r.kind === 'md') {
      const rawPath = splitDest(text.slice(r.destStart, r.destEnd)).pathRaw;
      const rooted = rawPath.startsWith('/');
      const newFile = newId + '.md';
      repl = replaceDest(text, r, rooted ? '/' + newFile : relativeFile(fromFile, newFile));
    } else {
      const m = /^\[\[([^[\]\n|#]*)(#[^[\]\n|]*)?(\|[^[\]\n]*)?\]\]$/.exec(r.text)!;
      const rawName = m[1]!;
      const hadMd = /\.md\s*$/i.test(rawName);
      const bare = !r.target.includes('/');
      let name = newId;
      if (bare) {
        const newName = newId.slice(newId.lastIndexOf('/') + 1);
        if (resolveWikilink(newName, idsAfter) === newId) name = newName;
      }
      repl = '[[' + name + (hadMd ? '.md' : '') + (m[2] ?? '') + (m[3] ?? '') + ']]';
    }
    edits.push({ start: r.start, end: r.end, repl });
  }
  return applyEdits(text, edits);
}

/**
 * The file moved from `oldFile` to `newFile`: re-base its relative md links so they
 * still point at the same target files. Rooted md links and wikilinks are unchanged.
 */
export function rewriteOutgoing(oldFile: string, newFile: string, text: string): string {
  if (path.dirname(oldFile) === path.dirname(newFile)) return text;
  const edits: Array<{ start: number; end: number; repl: string }> = [];
  for (const r of scan(text)) {
    if (r.kind !== 'md') continue;
    const raw = text.slice(r.destStart, r.destEnd);
    if (raw.trim().startsWith('/')) continue;
    const target = mdTargetFile(oldFile, raw);
    if (target === null) continue;
    edits.push({ start: r.start, end: r.end, repl: replaceDest(text, r, relativeFile(newFile, target)) });
  }
  return applyEdits(text, edits);
}
