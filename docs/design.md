# Dead Sea Scrolls: settled design (v1)

Outcome of the grill sessions of 2026-11-15 and 2026-11-16. Supersedes the
open questions in "Dead Sea Scrolls: API and MCP Design" (2026-11-15); its
draft schema still holds except where changed below. Vocabulary is in
`GLOSSARY.md`; the sync decision is `docs/adr/0001-phone-sync-and-repair.md`.

## Scope

- MCP only. No REST API in v1. The owner reads and edits on his phone in Obsidian.
- Ten tools: list_directory, list_concepts, read_concept, search_concepts,
  create_concept, update_concept, move_concept, list_stale, list_tags,
  delete_concept.

## Stack and packaging

- Node with the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`),
  `McpServer` + `StreamableHTTPServerTransport` in stateless mode, Zod input
  schemas. Tested with MCP Inspector and SDK-client integration tests.
  No framework on top (settled 2026-11-16, Q41): the alternatives (FastMCP,
  xmcp, mcp-framework, mcp-handler) save only the tool-registration
  boilerplate and add a layer between this server and spec updates.
- Rootless Podman Quadlet, own image: pinned `node:26.x` base + `git` +
  pinned `rclone`. No Caddy proxy (no token to inject).
- One Node process: serves POST `/mcp` on port 32473 and runs the 5-minute
  sync loop. One in-memory lock serializes MCP writes and sync runs.
- Repo `<repo>`; Quadlet files symlinked into
  `~/.config/containers/systemd/`; mise tasks `status`, `backup`,
  `update <node-version>`, `sync` (run a sync now).
- Data: `~/.local/share/dead-sea-scrolls/bundle` (git repo, no remote).
- Secrets: `~/.config/dead-sea-scrolls/rclone.conf` (mode 600, mounted
  read-write, its own cloud-drive login, separate from the backup job's config).
- Owner adds the Tailscale ACL grant `tag:agent` -> `tag:services` on
  `tcp:32473`.

## Bundle setup

- Import the migrated zip (96 concepts, index.md files, log.md) with
  `git init` and one commit: `Import migrated bundle (96 titles)`.
- `.gitignore`: `.obsidian/`. rclone filters exclude `.git/**` and
  `.obsidian/**`.
- Added to the normal age-encrypted nightly backup
  (`backups/hosts/HOST.conf`), then `./verify.sh` and push.

## Phone sync

- `rclone bisync` every 5 minutes between the bundle and the plain cloud-drive
  Drive folder `remote:dead-sea-scrolls` (exact remote name from the
  service's own rclone config). Phone: Obsidian + cloud-drive sync plugin.
- Each run: pull (bisync) -> commit phone edits as `Sync edits from phone`
  -> check changed concepts -> deterministic fixes, one commit each,
  `Fix <title>: <problems>` -> the next bisync pushes fixes to the phone.
  MCP writes go out on the next run.
- No conflict handling: the owner is the only user. rclone's default keeps
  both copies if it ever happens.

## Problems and repair

- Reads are lenient: a concept that breaks the rules still appears in
  queries, with `problems: [string]`. Writes through MCP are strict.
- Deterministic fixes only (no agent):
  - no frontmatter -> add it: title from first `# Heading` or file name,
    type from folder, list's default status
  - type wrong for its folder -> set from folder
  - casual status -> fixed alias table, case-insensitive (watching ->
    in-progress, watched/done -> complete, reading -> currently-reading,
    read -> finished, playing -> in-progress, want to watch -> to-watch)
  - missing list_status -> list default
  - file name not a slug -> rename to slug of title (ID changes)
- Anything else (unparseable YAML, unknown status, file at the bundle root) is left untouched and flagged. list_directory at the
  root returns a `problems` list of flagged concepts. The agent's morning scan
  picks them up and fixes them through MCP or asks the owner.
- read_concept on a flagged concept returns `problems` and `raw` (the file
  text). update_concept with a complete, valid frontmatter replaces broken
  frontmatter and keeps the body. move_concept fixes misplaced files.

## Domain rules

- Each list allows only its own list statuses:
  - anime, western-animation, series: to-watch, in-progress, caught-up,
    complete, dropped, archived
  - movies: to-watch, complete, dropped, archived
  - books: to-read, currently-reading, finished, dropped, skipped, archived
  - games: to-play, in-progress, complete, dropped, archived
- Lists may contain nested directories (e.g. `anime/gundam/`). A concept's
  list is its top-level directory. Directories are created on first move
  in and removed when the last concept leaves.
- Bare entry: missing both runtime and resource. Other fields do not count.
- New concepts start stale (no `verified`). The first morning scan sees all
  96 migrated concepts.
- Concept IDs are stable only until something moves the file (move_concept,
  or a move or rename in Obsidian). An unknown ID error tells the caller to
  find the concept again with search_concepts.
- `generated.by` and the git author come from the MCP client's
  `clientInfo.name`, falling back to `dead-sea-scrolls`. Sync and fix
  commits are authored by `dead-sea-scrolls`.
- Delete: confirmation is the only gate; the concept does not have to be
  archived first.

## Notes and areas (extension)

- Vocabulary: an **area** is any bundle directory outside the six lists
  (`notes`, `learning/rust`, ...). A **note** is a concept of type `Note`,
  normally in `notes/` or below. See `GLOSSARY.md`.
- `list` becomes `path` (a bundle-relative directory, nested allowed) on
  create_concept, list_concepts, list_stale and search_concepts. No `list`
  shim. A filter matches the directory and everything below it; omitted means
  everywhere; a directory that does not exist matches nothing. Paths reject
  `..`, absolute paths, hidden segments and leading/trailing slashes; create
  also rejects an empty path.
- `create_concept({path, title, type?, list_status?, status?, ...})`. Type:
  explicit `type`, else derived from the list, else `Note` at `notes` or
  below, else error naming the missing type. Outside `notes`, `type` is
  always explicit. In the six lists an explicit type that disagrees with the
  list is rejected and behavior is otherwise unchanged. Outside the lists
  `list_status` is rejected (use `status`) and `status` defaults to `draft`.
  `status` is draft, stable or deprecated.
- Problems: inside the six lists the rules are unchanged. In an area a
  concept needs only parseable frontmatter, a title, and (if present) a valid
  `status`. No list_status, no type check.
- update_concept works in areas: it accepts `status`, rejects `list_status`,
  and never overwrites `type`.
- move_concept takes optional `type` and `status`. Out of the lists:
  `list_status` is dropped, `status` becomes draft unless passed, type is
  kept unless passed. Into `notes/` or below: type `Note`. From an area into
  a list: `status` is dropped and a valid `list_status` is required (the
  existing rule). Moves between areas keep the type.
- list_stale only considers concepts in the six lists (notes are exempt).
  A `list_status` filter naturally excludes notes. list_directory lists
  areas with totals and an empty `by_status`.
- index.md is generated for every directory holding concepts. In an area it
  is a flat title-sorted list (plus Folders), not grouped by status. Phone
  sync commits and re-indexes edits anywhere in the bundle. A hand-written
  index.md in an area is replaced on the next write there. The Obsidian
  sync-back design is not part of this extension.

## Schema changes from the 2026-11-15 draft

- New tool `move_concept(id, to, name?, list_status?)`: `to` is a target
  directory path; optional `name` renames the file (slug derived by the
  server, numeric suffix if taken). Moving to another list sets `type` from
  the new list and rejects a list status not valid there unless a valid
  `list_status` is given. Rewrites incoming links in other concepts and
  regenerates index.md in both directories, all in one commit:
  `Move <title> from <old> to <new>`.
  Output: `{ id, previous_id, frontmatter, commit }`.
- list_status enums are validated per list (above), not one shared enum.
- list_stale gains `limit` (default 20, max 100) and `cursor`, oldest first;
  output adds `next_cursor`.
- read_concept output adds `problems` and, when flagged, `raw`.
- list_directory at the root adds `problems: [{ id, problems }]`.
- update_concept accepts a full frontmatter replacement on a flagged concept.
- index.md is regenerated in the migrated layout: grouped by list status,
  `[title](file.md) - description`. log.md is frozen after the import.
