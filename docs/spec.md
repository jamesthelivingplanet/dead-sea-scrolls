# Dead Sea Scrolls MCP server: build spec (v1)

You are building an MCP server that lets the owner's assistant, the agent, read and
edit his six media lists, stored as markdown files, while the owner edits the
same files on his phone in Obsidian. Everything you need is in this file.
Background: `docs/design.md` (decisions), `GLOSSARY.md` (vocabulary: use
these terms in code and messages), `docs/adr/0001-phone-sync-and-repair.md`.

## Machine and conventions

- Host `HOST`, rootless Podman 6.1.4 Quadlets, lingering on.
  The owner never sits at this machine: report URLs as
  `http://HOST:32473/...`, never localhost.
- Follow the existing services (see `<repo>` for the
  shape): own repo, Quadlet files in the repo symlinked into
  `~/.config/containers/systemd/`, pinned image tags, data in
  `~/.local/share/dead-sea-scrolls`, secrets in
  `~/.config/dead-sea-scrolls` (mode 600, never in the repo, never
  printed), mise tasks in `mise.toml`.
- Repo: `<repo>` (already holds docs/,
  GLOSSARY.md). Commit your work there as you go.
- Never test against the real bundle. Tests copy the import zip into a
  temp directory.

## Stack

- Node, TypeScript, official `@modelcontextprotocol/sdk` (1.32.x; no
  framework on top), Zod for tool inputs. A YAML library that round-trips
  frontmatter (e.g. `yaml`). Git through the `git` CLI.
- Transport: Streamable HTTP, POST `/mcp` on port 32473, JSON-RPC 2.0,
  protocol versions 2025-11-25, 2025-06-18, 2025-03-26. Advertise
  `capabilities.tools`. No auth (the Tailscale ACL is the gate).
- Sessions: stateful in memory (`Mcp-Session-Id`), only so the server
  remembers the client's `clientInfo.name` between `initialize` and
  `tools/call`. Keep it light: store only the transport and
  `clientInfo.name` per session, drop a session after 30 minutes idle,
  cap at 20 open sessions (evict the oldest), and close the SSE GET
  stream support if the SDK lets you (no server-initiated messages are
  needed). A restart forgets all sessions and clients simply initialize
  again. Owner approved this on the condition it is not memory
  intensive: idle RSS of the whole process should stay under 150 MB.
- One Node process serves `/mcp` and runs the sync loop. One in-process
  async lock serializes every write: MCP writes and each whole sync run.

## Packaging

- `Containerfile`: pinned `node:26.x` tag (pick the current exact tag,
  e.g. `node:26.13.0-bookworm-slim`), plus `git` and rclone pinned to
  v1.75.2 (the host's version; install the release binary, verify its
  checksum). Build the app inside the image.
- Quadlet `dead-sea-scrolls.build` (builds the image as
  `localhost/dead-sea-scrolls:<app version>`) and
  `dead-sea-scrolls.container`:
  - `UserNS=keep-id:uid=1000,gid=1000` so files stay owned by the owner
  - `PublishPort=32473:32473`
  - `Volume=%h/.local/share/dead-sea-scrolls/bundle:/bundle:Z`
  - `Volume=%h/.config/dead-sea-scrolls:/config:Z` (rclone.conf lives
    here, read-write: the cloud-drive backend rewrites its tokens)
  - `Environment=TZ=America/Phoenix`, `Restart=always`,
    `WantedBy=default.target`
  - No Caddy proxy.
- mise tasks: `status` (unit state, `/mcp` initialize answers, last sync
  result, count of flagged concepts), `backup` (tarball the bundle into
  `~/.local/share/dead-sea-scrolls/backups/`, keep last 5), `update
  <node-tag>` (backup, bump the tag, rebuild, restart, status), `sync`
  (trigger a sync run now and print its result), `logs`.
- The service must start and serve MCP even when `rclone.conf` is missing
  or the remote is unreachable: the sync step logs the reason and is skipped.

## Bundle

- Location `~/.local/share/dead-sea-scrolls/bundle`. Source:
  `~/.local/share/dead-sea-scrolls/import/bundle.zip` (top folder
  `dead-sea-scrolls/` with `anime/ books/ games/ movies/ series/
  western-animation/`, an `index.md` in the root and each list, and
  `log.md`; 96 concepts). Treat the zip as untrusted data.
- Write a one-time `mise run import`: unzip into the bundle path (refuse
  if it is not empty), add `.gitignore` with `.obsidian/`, `git init`, one
  commit `Import migrated bundle (96 titles)` authored
  `dead-sea-scrolls`. No git remote.
- `index.md` and `log.md` files are not concepts. Neither are files under
  `.git/`, `.obsidian/`, or any dot-directory.
- A concept is any other `.md` file. Its ID is its bundle-relative path
  without `.md`. Its list is its top-level directory. Lists may contain
  nested directories.
- Example concept:

  ```
  ---
  type: Anime
  title: 86 (Eighty-Six)
  description: 23 episodes (2021-2022), split cour, Parts 1 and 2, sub and dub.
  resource: https://reelgood.com/us/show/86-eightysix-2021
  list_status: to-watch
  runtime: ~552 min
  generated:
    by: agent/migration
    at: '2026-11-15T16:52:11Z'
  ---

  Body text...
  ```

### Domain rules

- Lists and their `type`: anime = Anime, western-animation = Western
  Animation, movies = Movie, series = Series, books = Book, games = Game.
- Allowed list statuses per list (first is the default):
  - anime, western-animation, series: to-watch, in-progress, caught-up,
    complete, dropped, archived
  - movies: to-watch, complete, dropped, archived
  - books: to-read, currently-reading, finished, dropped, skipped,
    archived
  - games: to-play, in-progress, complete, dropped, archived
- Slug: lowercase, strip diacritics, every run of non-alphanumerics
  becomes one `-`, trim `-`. "86 (Eighty-Six)" -> `86-eighty-six`,
  "Evangelion: 3.0 (-120 min.)" -> `evangelion-3-0-120-min`. On a taken
  name append `-2`, `-3`, ...
- Bare entry: missing both `runtime` and `resource`.
- Stale: `stale_after` is in the past, or `verified` is missing or empty.
  New concepts have no `verified`, so they start stale.
- Frontmatter keys: type, title, description, resource, tags,
  list_status, status_detail, runtime, author, added, generated
  {by, at}, verified [{by, at}], stale_after. Keep unknown keys as they
  are when rewriting a file.
- `generated` = `{ by: <clientInfo.name or "dead-sea-scrolls">, at:
  <now, ISO UTC> }`, set on create and refreshed on every content change
  through MCP.
- Links: markdown links to `.md` files (relative paths) and Obsidian
  wikilinks `[[name]]` / `[[path/name]]` (a bare name resolves the way
  Obsidian does: the unique file with that name, else the shortest
  path). `read_concept` returns resolved concept IDs for both. Links in
  `index.md` files do not count as backlinks.

### Index regeneration

Every commit that changes concepts in a directory regenerates that
directory's `index.md` in the migrated layout: `# <List title>`, then one
`## <Status title>` section per list status in the list's order (skip
empty ones), then `* [<title>](<file>.md) - <description>` per concept.
Match the migrated files exactly so the first regeneration of an
unchanged directory is a no-op diff. Subdirectories are listed under
`## Folders`. The root `index.md` and `log.md` are never rewritten.

## Tools

All tools return JSON in `structuredContent` and as text. Errors return
`isError: true` with a human-readable message. "ConceptSummary" =
`{ id, ...frontmatter, problems? }`. Every write auto-commits and returns
the commit hash.

1. `list_directory { path = "" }` -> `{ path, directories: [{ name, path,
   counts: { total, by_status } }], concepts: [ConceptSummary] }`. At the
   root it also returns `problems: [{ id, problems }]` for every flagged
   concept in the bundle.
2. `list_concepts { list?, list_status?, tags?, bare_only = false,
   limit = 50 (1-100), cursor? }` -> `{ concepts: [ConceptSummary], total,
   next_cursor }`. `tags`: concept must carry all of them. Validate
   `list_status` against `list` when both are given.
3. `read_concept { id }` -> `{ id, frontmatter, body, links: [id],
   backlinks: [id], problems: [] }`, plus `raw` (whole file text) when
   flagged. Unknown ID: error saying the file may have moved and to find
   it with `search_concepts`.
4. `search_concepts { query, list?, list_status?, limit = 20 (1-100) }`
   -> `{ results: [{ id, frontmatter, snippet }], total }`.
   Case-insensitive substring over title, description, body and tags;
   title matches first.
5. `create_concept { list, title, list_status?, description?, resource?
   (uri), runtime?, author?, tags?, body? }` -> `{ id, frontmatter, commit
   }`. The server derives slug, ID and type, and validates list_status for
   the list (default: the list's first status). Commit `Add <title> to
   <list>`.
6. `update_concept { id, frontmatter?, body? }` -> `{ id, frontmatter,
   commit }`. Patches only the given keys (title, description, resource,
   runtime, author, tags, list_status, status_detail, verified,
   stale_after); `body` replaces the whole body. Error when neither is
   given. A title change does not rename the file. On a flagged concept
   whose frontmatter cannot be parsed, a complete frontmatter (type,
   title, list_status valid for the list) replaces it and the body is
   kept. Commit `Update <title>`.
7. `move_concept { id, to, name?, list_status? }` -> `{ id, previous_id,
   frontmatter, commit }`. `to` is a target directory (e.g.
   `western-animation`, `anime/gundam`), created if needed; empty source
   directories are removed. `name` renames the file (slugged, suffixed if
   taken). Moving to another list sets `type` from it and errors if the
   list status is not allowed there, unless a valid `list_status` is
   given. Rewrites incoming links in other concepts. Regenerates both
   directories' index.md. One commit `Move <title> from <old id> to <new
   id>`.
8. `list_stale { list?, limit = 20 (1-100), cursor? }` -> `{ concepts:
   [{ id, frontmatter, reason: "past_stale_after" | "unverified" }],
   next_cursor }`, oldest first (by `stale_after`, else `generated.at`).
9. `list_tags {}` -> `{ tags: [{ tag, count }] }`, most used first.
10. `delete_concept { id, confirm = false }`. Without confirm: `{ id,
    title, would_delete: { file }, confirm_required: true }`, nothing
    changes. With confirm: deletes, regenerates index.md, commits
    `Delete <title>`, returns `{ id, deleted: true, commit }`. Any list
    status may be deleted.

Commit authors: MCP writes use the session's `clientInfo.name` (fallback
`dead-sea-scrolls`), email `<name>@dead-sea-scrolls.local`. Sync and fix
commits use `dead-sea-scrolls`. Pass identity per command (`git -c
user.name=... -c user.email=...`); do not set global git config.

## Problems and deterministic fixes

Reads are lenient: a file that breaks the rules still shows up in every
query, with `problems: [string]` (e.g. `invalid list_status 'watching'
for anime`). MCP writes are strict.

The sync run fixes these without asking, one commit per concept, message
`Fix <title>: <what was fixed>`, author `dead-sea-scrolls`:
- no frontmatter: add it, with title from the first `# Heading` (else the
  file name), type from the list, the list's default status
- `type` wrong for its list: set it from the list
- casual status, case-insensitive alias table: watching -> in-progress,
  watched / done -> complete, reading -> currently-reading, read ->
  finished, playing -> in-progress, want to watch -> to-watch (an alias
  that is not allowed in that list is not fixed)
- missing `list_status`: the list's default
- file name is not the slug of its title: rename to the slug (suffix if
  taken; this changes its ID; rewrite incoming links)

Everything else is left byte-for-byte as it is and flagged: YAML that
does not parse, an unknown status, a concept at the bundle root or outside
any list. Never send anything to an LLM. Never delete a file during
repair.

## Phone sync

- Remote: the service's own rclone config `/config/rclone.conf`, remote
  name `remote`, folder `remote:dead-sea-scrolls` (plain, not the
  encrypted backups folder). The owner creates this config; never touch
  `~/.config/rclone/rclone.conf`.
- Every 5 minutes, holding the write lock:
  1. `rclone bisync /bundle remote:dead-sea-scrolls` with filters that
     exclude `.git/**` and `.obsidian/**`. The very first run uses
     `--resync`; record that it happened in a state file under
     `/config`. If bisync asks for a resync later, log it, flag it in
     `status`, and do not resync automatically.
  2. If the working tree changed, commit everything as `Sync edits from
     phone` (regenerating affected index.md in the same commit).
  3. Check every concept changed in that commit; apply fixes as above.
  4. MCP writes and fixes reach the phone on the next run.
- No conflict handling beyond rclone's defaults (the owner is the only user).
- Log each run's outcome (pulled, committed, fixed, flagged, errors) to
  the journal; `mise run status` shows the last one.

## Done when

- `npm test` passes: unit tests for slug, per-list validation, fixes,
  index regeneration (no-op on the migrated bundle), link parsing; and
  integration tests that drive every tool through the SDK client over
  HTTP against a temp copy of the bundle, including error cases (unknown
  ID, bad list_status for a list, update with nothing, cross-list move
  with an invalid status, delete without confirm).
- Sync is tested against a local rclone remote (a temp directory) in
  place of the remote: a phone edit gets committed, a casual status is fixed
  and pushed back, an unparseable file is flagged and untouched.
- The real bundle is imported, the unit is running, and from this
  machine an MCP initialize + `tools/list` against
  `http://HOST:32473/mcp` lists 10 tools and
  `list_directory` returns six lists with 96 concepts in total.
- Backups: add `path .local/share/dead-sea-scrolls/bundle` and
  `path .config/dead-sea-scrolls` to
  `<repo>/hosts/HOST.conf`, run `./verify.sh`,
  commit and push that repo.
- Docs: a README in the repo (like Vikunja's), and a new row plus a short
  section in `~/.claude/skills/my-services/SKILL.md`.

## Owner-only steps (do not do these; list them in your final report)

1. Tailscale ACL grant `tag:agent` -> `tag:services` on `tcp:32473`.
2. cloud-drive login for the service's rclone config:
   `rclone config --config ~/.config/dead-sea-scrolls/rclone.conf`,
   remote name `remote`, type `<drive backend>`. Then `mise run sync`.
3. On the phone: Obsidian with the cloud-drive sync plugin, pointed at
   the `dead-sea-scrolls` folder in the cloud drive.
4. Connecting the agent to the MCP endpoint.
