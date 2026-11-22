# Dead Sea Scrolls MCP server on HOST

- Service: MCP server v1.0.0 for the six media lists plus notes and other areas, which the agent reads and edits
- Image: `localhost/dead-sea-scrolls:1.0.0`, built by Quadlet `dead-sea-scrolls.build` (`node:26.13.1-bookworm-slim` + git + rclone v1.75.2, checksum-verified)
- Containers: `dead-sea-scrolls` (unit `dead-sea-scrolls.service`), no Caddy proxy, publishes port `32473`
- Quadlets: `dead-sea-scrolls.build` and `dead-sea-scrolls.container` in this repo, symlinked into `~/.config/containers/systemd/`
- Endpoint: http://HOST:32473/mcp (Streamable HTTP, POST, no auth; the Tailscale ACL is the gate, `tag:agent` -> `tag:services` on `tcp:32473`)
- Data: bundle `~/.local/share/dead-sea-scrolls/bundle` (git repo, no remote, every write is a commit); backups in `~/.local/share/dead-sea-scrolls/backups/` (last 5); import zip in `~/.local/share/dead-sea-scrolls/import/`
- Config: personal config (remote credentials, real remote name, DSS_* overrides) lives only in `~/.config/dead-sea-scrolls` and `~/.local/share/dead-sea-scrolls`, never in this repo. The config dir (mode 700) holds `rclone.conf` (the service's own cloud-drive login, remote `remote`; separate from `~/.config/rclone/rclone.conf`), `bisync/` workdir and `sync-state.json`. Never print `rclone.conf`.
- Env: `DSS_BUNDLE_DIR`, `DSS_CONFIG_DIR`, `DSS_PORT`, `DSS_SYNC_INTERVAL_SECONDS` (300), `DSS_REMOTE`, `DSS_RCLONE`; see `docs/architecture.md`
- Idle RSS about 100 MB
- Backups: nightly encrypted backups include the bundle and the config dir (`hosts/HOST.conf` in `<repo>`)

Tasks: `mise run status | backup | update <node-tag> | sync | logs` (`import` and `install` were one-time and are done)

Gotcha: on the host use `127.0.0.1:32473`, not `localhost`. The rootless port forward does not answer on `::1`.

## Tools

- `list_directory`, `list_concepts`, `read_concept`, `search_concepts`, `list_stale`, `list_tags` (reads)
- `create_concept`, `update_concept`, `move_concept`, `delete_concept` (writes; delete needs `confirm: true`)
- Create and the query tools (`list_concepts`, `list_stale`, `search_concepts`) take `path`, a bundle-relative directory (`anime`, `notes`, `notes/projects`). `create_concept` takes an optional `type` (derived in the six lists, `Note` under `notes/`, required elsewhere) and `status` (draft/stable/deprecated). Notes use `status`, never `list_status`.
- Every write auto-commits and returns the commit hash. Writes are strict; reads show flagged files with `problems`.

## Phone sync

- Every 5 minutes: `rclone bisync` with `remote:dead-sea-scrolls` (excludes `.git/**` and `.obsidian/**`), then commit phone edits as `Sync edits from phone`.
- Deterministic fixes go in one commit per concept as `Fix <title>: ...`. Unfixable files are flagged and left untouched.
- Missing `rclone.conf` or an unreachable remote: the sync is skipped and logged; MCP still works.
- If bisync asks for a resync, `status` shows `resyncNeeded`. Nothing resyncs automatically.

## Development

- `npm ci`
- `npm test` (tests use temp copies of the import zip, never the real bundle)
- `npm run build`
- Read-only check against a running server: `node scripts/smoke.mjs`

## Owner-only steps

1. Tailscale ACL grant `tag:agent` -> `tag:services` on `tcp:32473`.
2. cloud-drive login: `rclone config --config ~/.config/dead-sea-scrolls/rclone.conf` (remote `remote`, type `<drive backend>`), then `mise run sync`.
3. On the phone: Obsidian with the cloud-drive sync plugin, pointed at the `dead-sea-scrolls` folder in the cloud drive.
4. Connect the agent to the MCP endpoint.
