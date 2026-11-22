import { parseDocument, stringify, isMap } from 'yaml';

export type Parsed =
  | { kind: 'ok'; data: Record<string, unknown>; body: string }
  | { kind: 'missing'; body: string }
  | { kind: 'unparseable'; error: string; body: string };

interface Split {
  bom: string;
  /** opening '---' line including its line ending */
  open: string;
  /** raw YAML text between the fences */
  yaml: string;
  /** closing '---' line including its line ending (may be '' at EOF); null when unclosed */
  close: string | null;
  /** everything after the closing line */
  rest: string;
  eol: '\n' | '\r\n';
}

const OPEN_RE = /^---[ \t]*(\r?\n)/;

function split(text: string): Split | null {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const t = text.slice(bom.length);
  const m = OPEN_RE.exec(t);
  if (!m) return null;
  const open = m[0];
  const eol = m[1] === '\r\n' ? '\r\n' : '\n';
  let pos = open.length;
  const yamlStart = pos;
  while (pos <= t.length) {
    let nl = t.indexOf('\n', pos);
    const end = nl === -1 ? t.length : nl + 1;
    const line = t.slice(pos, end).replace(/\r?\n$/, '').replace(/[ \t]+$/, '');
    if (line === '---' && pos < t.length) {
      return { bom, open, yaml: t.slice(yamlStart, pos), close: t.slice(pos, end), rest: t.slice(end), eol };
    }
    if (nl === -1) break;
    pos = end;
  }
  return { bom, open, yaml: t.slice(yamlStart), close: null, rest: '', eol };
}

/** Body = text after the closing line, minus ONE leading blank line. */
function bodyOf(rest: string): string {
  if (rest.startsWith('\r\n')) return rest.slice(2);
  if (rest.startsWith('\n')) return rest.slice(1);
  return rest;
}

const MAX_ALIAS_COUNT = 100;
const YAML_OPTS = { prettyErrors: false, maxAliasCount: MAX_ALIAS_COUNT } as const;

export function parseConceptText(text: string): Parsed {
  const s = split(text);
  if (!s) return { kind: 'missing', body: text };
  if (s.close === null) {
    return {
      kind: 'unparseable',
      error: "frontmatter has no closing '---' line",
      body: text.slice(s.bom.length + s.open.length),
    };
  }
  const body = bodyOf(s.rest);
  try {
    const doc = parseDocument(s.yaml, YAML_OPTS);
    if (doc.errors.length > 0) {
      return { kind: 'unparseable', error: firstLine(doc.errors[0]!.message), body };
    }
    if (!isMap(doc.contents)) {
      return { kind: 'unparseable', error: 'frontmatter is not a YAML mapping', body };
    }
    const data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT }) as Record<string, unknown>;
    return { kind: 'ok', data, body };
  } catch (e) {
    return { kind: 'unparseable', error: firstLine(e instanceof Error ? e.message : String(e)), body };
  }
}

function firstLine(msg: string): string {
  return msg.split('\n')[0]!.trim();
}

function yamlOf(data: Record<string, unknown>): string {
  return stringify(data, { lineWidth: 0 });
}

function withEol(s: string, eol: '\n' | '\r\n'): string {
  return eol === '\n' ? s : s.replace(/\r?\n/g, '\r\n');
}

/** Patch keys in place with the yaml Document API. Untouched keys keep order and formatting. */
export function setFrontmatterKeys(text: string, patch: Record<string, unknown>): string {
  const s = split(text);
  if (!s || s.close === null) throw new Error('setFrontmatterKeys requires parseable frontmatter');
  let doc;
  try {
    doc = parseDocument(s.yaml, YAML_OPTS);
    // Resolve aliases now so a bad document fails here with a clear error.
    if (doc.errors.length === 0 && isMap(doc.contents)) doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (e) {
    throw new Error(`setFrontmatterKeys requires parseable frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error('setFrontmatterKeys requires parseable frontmatter');
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return text;
  for (const key of keys) {
    const value = patch[key];
    if (value === undefined) doc.delete(key);
    else doc.set(key, value);
  }
  let out = doc.toString({ lineWidth: 0 });
  if (out !== '' && !out.endsWith('\n')) out += '\n';
  // A closing line at EOF without newline needs the yaml text to end with a newline: it does.
  return s.bom + s.open + withEol(out, s.eol) + s.close + s.rest;
}

export function replaceFrontmatter(text: string, data: Record<string, unknown>): string {
  const s = split(text);
  const eol = s?.eol ?? '\n';
  const block = '---' + eol + withEol(yamlOf(data), eol) + '---' + eol;
  if (!s) return block + (text === '' ? '' : eol + text);
  if (s.close === null) {
    const body = text.slice(s.bom.length + s.open.length);
    return s.bom + block + (body === '' ? '' : eol + body);
  }
  return s.bom + block + s.rest;
}

export function replaceBody(text: string, body: string): string {
  const s = split(text);
  if (!s || s.close === null) return body;
  const close = s.close.endsWith('\n') ? s.close : s.close + s.eol;
  let b = body;
  if (b !== '' && !b.endsWith('\n')) b += s.eol;
  return s.bom + s.open + s.yaml + close + (b === '' ? '' : s.eol + b);
}

export function buildConceptText(data: Record<string, unknown>, body: string): string {
  let out = '---\n' + yamlOf(data) + '---\n';
  if (body !== '') out += '\n' + body;
  if (!out.endsWith('\n')) out += '\n';
  return out;
}
