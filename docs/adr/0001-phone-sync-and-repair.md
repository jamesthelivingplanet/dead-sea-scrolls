---
status: accepted
---

# Two-way phone sync via the cloud drive, with deterministic repair only

The owner reads and edits the bundle in Obsidian on his phone, so the server is not the only writer. The server runs `rclone bisync` every 5 minutes against a plain cloud-drive folder (the phone uses the the cloud drive Sync Obsidian plugin). It commits outside edits as they arrive and repairs only problems that have one obvious answer; anything else is flagged in `problems` for the agent or the owner to fix through MCP. MCP writes stay strict, reads stay lenient, so a malformed note from the phone never breaks a query.

## Considered Options

- **View-only phone with one-way sync**: rejected, the owner wants to edit on the phone.
- **Syncthing**: rejected by the owner; the cloud drive is already his storage.
- **An LLM agent (`claude -p` or the Claude API) to fix what code cannot**: rejected. `claude -p` needed the service on the host instead of a Quadlet; with it gone, unfixable files are left untouched and flagged instead.

## Consequences

- The service has its own rclone config (`~/.config/dead-sea-scrolls/rclone.conf`), separate from the backup job's, because the cloud-drive backend rewrites its tokens in that file.
- Concept IDs are stable only until something moves the file; Obsidian moves and renames change IDs too.
- The phone copy is plain (the provider's own encryption only); the nightly backup of the bundle stays age-encrypted like every other service.
