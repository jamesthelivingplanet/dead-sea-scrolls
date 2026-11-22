# Architecture and module contracts (build plan)

Internal contract for the build. `docs/spec.md` wins over everything else;
where `docs/design.md` differs from the spec, the spec wins (sessions are
**stateful**, the remote is **`remote:`**).

Facts found in the migrated bundle (import zip) that the code must respect:

- `index.md` per list: H1 is the list's **type** (`# Anime`, `# Western
  Animation`, `# Movie`, `# Series`, `# Book`, `# Game`), then `## <Status
  title>` sections, then `* [<title>](<file>.md) - <description>` lines, a
  blank line between blocks, file ends with exactly one `\n`.
- Section order and entry order in the migrated files are **not** derivable
  (anime has `## Caught Up` after `## Complete`; entries are in the original
  table order). So regeneration MERGES with the existing index.md (see
  indexgen) to keep the first regeneration a no-op.
- Slugs need transliteration beyond diacritic stripping: `Æon Flux` ->
  `aeon-flux`. Use a table (Æ/æ->ae, Œ/œ->oe, ß->ss, Ø/ø->o, Đ/đ->d, Ł/ł->l,
  Þ/þ->th, ı->i, plus NFKD + strip combining marks). Every migrated file name
  equals slug(title).
- Links in the bundle are bundle-rooted markdown links:
  `[Evangelion: 3.0 (-46h)](/anime/evangelion-3-0-46h.md)`.
- Frontmatter keys seen: type, title, description, resource, list_status,
  runtime, status_detail, author, added, generated.

## Layout

```
package.json          type: module, scripts: build (tsc), test (vitest run), start
tsconfig.json         strict, NodeNext, outDir dist, rootDir src
src/config.ts         env -> Config
src/domain/lists.ts   lists, types, statuses, status titles, aliases
src/domain/slug.ts    slugify, uniqueName
src/domain/paths.ts   id/path validation (traversal guard)
src/bundle/frontmatter.ts  parse/serialize concept text (yaml Document API)
src/bundle/scan.ts    scanBundle -> BundleSnapshot
src/bundle/problems.ts computeProblems
src/bundle/links.ts   link extraction, resolution, rewriting
src/bundle/indexgen.ts index.md regeneration
src/git.ts            git CLI wrapper (execFile, per-command identity)
src/lock.ts           Mutex
src/errors.ts         ToolError (user-facing message)
src/ops/read.ts       read tools logic
src/ops/write.ts      create/update/move/delete (UNLOCKED; caller holds lock)
src/repair.ts         deterministic fixes (UNLOCKED)
src/sync.ts           rclone bisync run + loop + state file
src/tools.ts          MCP tool registration (zod schemas, lock around writes)
src/server.ts         HTTP server, /mcp, sessions
src/control.ts        loopback-only control server (sync now, status)
src/main.ts           entrypoint: server + control + sync loop
src/cli.ts            `node dist/cli.js sync|status` -> talks to control server
src/import.ts         one-time import of the zip (host side, via mise)
test/                 vitest; test/helpers make temp bundle copies from the zip
```

Runtime deps: `@modelcontextprotocol/sdk@1.32.2` (exact), `zod@^4`, `yaml@^2`.
Dev: `typescript`, `vitest`, `@types/node`. No express (use `node:http`).

## Config (src/config.ts)

Env vars, no defaults pointing at real data:
`DSS_BUNDLE_DIR` (required), `DSS_CONFIG_DIR` (required),
`DSS_PORT` (default 32473), `DSS_HOST` (default `0.0.0.0`),
`DSS_CONTROL_PORT` (default 32474, always bound to 127.0.0.1),
`DSS_SYNC_INTERVAL_SECONDS` (default 300; 0 disables the loop),
`DSS_REMOTE` (default `remote:dead-sea-scrolls`), `DSS_RCLONE` (default `rclone`).
Files under the config dir: `rclone.conf`, `bisync/` (rclone workdir),
`sync-state.json`.

## Domain (src/domain)

```ts
export const LISTS = ['anime','western-animation','movies','series','books','games'] as const;
export type ListName = typeof LISTS[number];
export const LIST_TYPES: Record<ListName,string>;      // anime->'Anime', western-animation->'Western Animation', movies->'Movie', series->'Series', books->'Book', games->'Game'
export const LIST_STATUSES: Record<ListName, readonly string[]>; // spec order, first = default
export function isList(s: string): s is ListName;
export function defaultStatus(list: ListName): string;
export function isValidStatus(list: ListName, status: unknown): boolean;
export function statusTitle(status: string): string;   // 'caught-up' -> 'Caught Up', 'currently-reading' -> 'Currently Reading'
export function aliasStatus(list: ListName, value: string): string | null; // case-insensitive, trimmed alias table; null if no alias or not allowed in list
export const ALL_STATUSES: string[];                   // union

slugify(title: string): string;                        // may return '' -> callers fall back to 'untitled'
uniqueName(base: string, taken: (name: string) => boolean): string; // base, base-2, base-3, ...
fileNameMatchesTitle(name: string, title: string): boolean; // name === slug or slug-<n>, n>=2

assertConceptId(id: string): void;  // throws ToolError: non-empty, no leading/trailing '/', no '\\', no NUL, no '.'-prefixed or empty segments, no '..', no '.md' suffix
assertDirPath(path: string): void;  // same rules, '' allowed (root)
listOf(idOrPath: string): ListName | null;             // first segment if a list
```

## Bundle (src/bundle)

```ts
// frontmatter.ts
type Parsed =
  | { kind: 'ok'; data: Record<string, unknown>; body: string }
  | { kind: 'missing'; body: string }               // no leading '---' line
  | { kind: 'unparseable'; error: string; body: string }; // opening '---' but no closing line, YAML error, or YAML not a mapping
parseConceptText(text: string): Parsed;
// body = text after the closing '---\n' line with ONE leading blank line removed.
setFrontmatterKeys(text: string, patch: Record<string, unknown>): string;
//   requires kind 'ok'; yaml Document API: untouched keys keep order and formatting,
//   new keys appended, value `undefined` deletes; body bytes kept as they are.
replaceFrontmatter(text: string, data: Record<string, unknown>): string; // new block, body kept
replaceBody(text: string, body: string): string;                         // frontmatter bytes kept
buildConceptText(data: Record<string, unknown>, body: string): string;
// Serialized form: '---\n' + yaml + '---\n' + ('\n' + body if body non-empty) ; ensure trailing '\n'.
// yaml stringify options: lineWidth 0 (no folding), default quoting of the yaml lib.

// scan.ts
interface Concept {
  id: string;            // 'anime/86-eighty-six'
  file: string;          // 'anime/86-eighty-six.md'
  dir: string;           // 'anime' or 'anime/gundam' or '' (root)
  name: string;          // '86-eighty-six'
  list: ListName | null;
  raw: string;
  frontmatter: Record<string, unknown> | null; // null when missing/unparseable
  frontmatterState: 'ok' | 'missing' | 'unparseable';
  body: string;
  problems: string[];
}
interface BundleSnapshot {
  root: string;
  concepts: Map<string, Concept>;  // sorted by id
  dirs: string[];                  // every non-dot directory, bundle-relative, sorted, excluding ''
}
scanBundle(root: string): Promise<BundleSnapshot>;
// skips: any path segment starting with '.', index.md and log.md anywhere, non-.md files, symlinks.

// problems.ts
computeProblems(c: Omit<Concept,'problems'>): string[];
// Messages (exact wording):
//   'no frontmatter'
//   'frontmatter does not parse: <error>'
//   'concept is at the bundle root, not in a list'
//   (areas, i.e. dirs outside the six lists, get only: frontmatter/title problems and "invalid status '<x>' (allowed: draft, stable, deprecated)")
//   'missing title'
//   "type '<x>' should be '<Type>' for <list>"   (also when type missing: "missing type, should be '<Type>'")
//   'missing list_status'
//   "invalid list_status '<x>' for <list>"
// File-name-vs-title is NOT a read problem (update_concept may change titles
// without renaming); it is only fixed by sync repair.

// links.ts
interface LinkRef { kind: 'md' | 'wiki'; start: number; end: number; text: string; target: string }
findLinks(text: string): LinkRef[];
//   md: [label](target) where target (before '#'/'?', URL-decoded) ends in '.md' and is not a URL (has no scheme).
//       target starting with '/' is bundle-rooted; otherwise relative to the file's dir.
//   wiki: [[target]], [[target|alias]], [[target#heading]]; target without '.md'.
resolveLink(fromFile: string, ref: LinkRef, ids: Set<string>): string | null;
resolveWikilink(target: string, ids: Set<string>): string | null;
//   with '/': exact id match, else unique id ending with '/<target>', else shortest such.
//   bare: unique concept with that file name; else the shortest path (tie: alphabetical).
linksOf(fromFile: string, text: string, ids: Set<string>): string[]; // resolved, deduped, in order
rewriteIncoming(fromFile: string, text: string, oldId: string, newId: string, idsAfter: Set<string>): string;
//   md: keep style (rooted stays rooted, relative recomputed relative to fromFile's dir), keep '#anchor' and label.
//   wiki: keep the bare form if it now resolves to newId, else full newId; keep |alias and #heading.
rewriteOutgoing(oldFile: string, newFile: string, text: string): string;
//   relative md links in the moved file re-based so they point to the same targets; rooted and wiki links unchanged.

// indexgen.ts
renderDirIndex(args: {
  dir: string; list: ListName;
  concepts: Concept[];                      // direct children of dir
  subdirs: { name: string; total: number }[]; // direct child dirs with recursive concept count
  existing: string | null;                  // current index.md text
}): string;
regenerateIndexes(root: string, dirs: string[]): Promise<string[]>;
//   dirs are bundle-relative; for each dir AND its ancestors inside a list (never '' root,
//   never outside a list): re-scan, render, write only when changed; skip dirs that no longer exist.
//   Returns written paths. Root index.md and log.md are never written.
```

Index merge rules:
- H1: keep the existing H1 line; otherwise `# <Type>` at a list root,
  `# <dir basename>` in a nested dir.
- Sections: keep the existing order of `## <Status title>` sections; a
  section that is new is inserted at its list-order position relative to
  the sections that exist; empty sections are dropped.
- Entries: an entry whose concept still exists and still has that status
  stays in place, with its title/description refreshed; entries for removed
  concepts are dropped; new or re-statused concepts are appended to the end
  of their section, sorted by title among themselves.
- Line: `* [<title>](<name>.md) - <description>`; no ` - ...` when there is
  no description. Title/description are the decoded YAML values.
- Concepts with no valid status (flagged) go under `## Unsorted`, after the
  status sections; title falls back to the file name.
- Subdirectories: `## Folders` last, `* [<name>](<name>/) - <n> titles`,
  sorted by name.
- Blocks separated by one blank line; file ends with one `\n`.
- No existing index: list order for sections, entries sorted by title.
- Test: for all six migrated lists, regeneration is byte-identical.

## Git, lock, errors

```ts
// git.ts
interface Author { name: string; email: string }
authorFor(clientName?: string | null): Author;
//   strip control chars, '<', '>', newlines; trim; cap 100 chars; empty -> 'dead-sea-scrolls'.
//   email `${slugify(name) || 'dead-sea-scrolls'}@dead-sea-scrolls.local`.
export const SYSTEM_AUTHOR: Author; // dead-sea-scrolls <dead-sea-scrolls@dead-sea-scrolls.local>
git(root: string, args: string[], opts?: { author?: Author }): Promise<string>;
//   execFile('git', ['-c','user.name=..','-c','user.email=..','-c','commit.gpgsign=false','-c','core.quotepath=off', ...args], {cwd: root, env with GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null})
//   never shell; paths after '--'.
commitAll(root: string, message: string, author: Author): Promise<string | null>;
//   git add -A; if nothing staged return null; commit; return full HEAD hash.
isDirty(root: string): Promise<boolean>;
changedSince(root: string, rev: string): Promise<{ status: string; path: string; from?: string }[]>; // name-status with -M

// lock.ts
class Mutex { runExclusive<T>(fn: () => Promise<T>): Promise<T> }

// errors.ts
class ToolError extends Error {}  // message is shown to the client as isError text
```

## Ops (src/ops) — UNLOCKED; tools.ts wraps writes in `lock.runExclusive`

```ts
// read.ts — all take the bundle root, scan fresh each call (96 files is cheap)
listDirectory(root, { path = '' })      -> { path, directories: [{ name, path, counts: { total, by_status } }], concepts: ConceptSummary[], problems?: [{ id, problems }] }
listConcepts(root, { path?, list_status?, tags?, bare_only?, limit?, cursor? }) -> { concepts, total, next_cursor: string | null }
readConcept(root, { id })               -> { id, frontmatter, body, links, backlinks, problems, raw? }
searchConcepts(root, { query, path?, list_status?, limit? }) -> { results: [{ id, frontmatter, snippet }], total }
listStale(root, { path?, limit?, cursor? }, now = new Date()) -> { concepts: [{ id, frontmatter, reason }], next_cursor }
listTags(root)                          -> { tags: [{ tag, count }] }
// ConceptSummary = { id, ...frontmatter, problems? } (problems only when non-empty)
// Cursor: opaque base64url of JSON {o: offset}; bad cursor -> ToolError.
// list_status given with a path inside a list: must be valid for that list (ToolError otherwise);
// otherwise: must be in ALL_STATUSES. path is any dir (nested ok); missing dir = empty result.
// Unknown ID -> ToolError(`No concept with ID '<id>'. The file may have moved or been renamed; find it again with search_concepts.`)

// write.ts
interface Actor { author: Author; clientName: string } // clientName used for generated.by
createConcept(root, input, actor) -> { id, frontmatter, commit }
updateConcept(root, input, actor) -> { id, frontmatter, commit }
moveConcept(root, input, actor)   -> { id, previous_id, frontmatter, commit }
deleteConcept(root, input, actor) -> preview | { id, deleted: true, commit }
// Each write: validate strictly, change files, regenerateIndexes(affected dirs + ancestors),
// remove now-empty non-list directories (move/delete), commitAll(message, actor.author).
// `generated = { by: actor.clientName, at: now ISO UTC (no ms) }` on create and on every content change.
```

## Repair, sync, server

```ts
// repair.ts (UNLOCKED)
planFixes(c: Concept, snapshot: BundleSnapshot): { fixes: string[]; ... } ;
repairConcept(root: string, id: string): Promise<{ id: string; newId: string; fixed: string[]; commit: string | null; problems: string[] }>;
//   applies the spec's deterministic fixes, one commit `Fix <title>: <what was fixed>` (what = fixes joined with ', '),
//   author SYSTEM_AUTHOR; rename rewrites incoming links and regenerates indexes in the same commit.
//   Unparseable YAML, unknown status, root/outside-list files: untouched, returned as problems. Never deletes.

// sync.ts
interface SyncResult { startedAt: string; finishedAt: string; outcome: 'ok' | 'skipped' | 'error' | 'resync-needed';
  reason?: string; pulled: boolean; committed: string | null; fixed: { id: string; commit: string; what: string }[];
  flagged: { id: string; problems: string[] }[]; errors: string[] }
runSync(deps: { config: Config; lock: Mutex; log: (line: string) => void }): Promise<SyncResult>;
startSyncLoop(deps): () => void; // first run shortly after start, then every interval; never overlapping
// state file <configDir>/sync-state.json: { resyncDone: boolean, resyncNeeded: boolean, lastResult: SyncResult | null }

// server.ts
startServer(config, ctx): Promise<{ port: number; close(): Promise<void> }>;
//   node:http; POST/GET/DELETE /mcp via StreamableHTTPServerTransport (stateful, sessionIdGenerator randomUUID).
//   Per session: { transport, clientName, lastSeen }; McpServer per session (registerTools).
//   Idle > 30 min dropped (sweep every minute); > 20 sessions evict the least recently used.
//   GET /mcp (SSE) answers 405. Everything else 404.
```

## Write transactions (added in review round 2)

`src/tx.ts` (`Tx`, `inTx`): every MCP write and every repair records the
original bytes of each bundle path it touches (`tx.write/rename/unlink`,
index regeneration via the `write` callback of `regenerateIndexes`). It
commits only those paths (`commitPaths` in `src/git.ts`: unstage, stage the
touched paths, commit), and on any failure before the commit it restores the
original bytes. So a failed write never leaks into a later commit, and
uncommitted phone edits are never committed under an MCP author or reverted.
Only the sync step's `Sync edits from phone` commit uses `commitAll` (it
commits everything bisync brought in). Git runs with literal pathspecs.
Index regeneration only reads/writes a regular-file `index.md` (never a
symlink or a directory of that name); directory names ending in `.md` are
rejected in IDs and paths. Sync prunes nested directories the phone emptied.
