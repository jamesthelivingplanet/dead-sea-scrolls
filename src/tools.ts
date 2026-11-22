import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToolError } from './errors.js';
import { authorFor } from './git.js';
import type { Mutex } from './lock.js';
import {
  listConcepts,
  listDirectory,
  listStale,
  listTags,
  readConcept,
  searchConcepts,
} from './ops/read.js';
import { createConcept, deleteConcept, moveConcept, updateConcept } from './ops/write.js';

export interface ToolContext {
  root: string;
  lock: Mutex;
  /** The MCP client's clientInfo.name for the calling session. */
  clientName: () => string | undefined;
}

const limitSchema = (def: number) => z.number().int().min(1).max(100).default(def);

const PATH_HELP =
  'Bundle-relative directory, nested allowed (e.g. "anime", "notes", "notes/projects"). No leading or trailing slash, no "..", no hidden segments.';
const FILTER_HELP = `${PATH_HELP} Matches that directory and everything below it. Omit for the whole bundle; a directory that does not exist matches nothing.`;
const OKF_STATUS_HELP = 'Lifecycle status: draft, stable or deprecated. A fresh note is a draft. Media queries ignore it.';
const STATUS_HELP =
  'List status. Allowed values depend on the list: anime/western-animation/series use to-watch, in-progress, caught-up, complete, dropped, archived; movies use to-watch, complete, dropped, archived; books use to-read, currently-reading, finished, dropped, skipped, archived; games use to-play, in-progress, complete, dropped, archived.';

function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function guard(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message);
    console.error('Unexpected tool error:', e instanceof Error ? (e.stack ?? e.message) : e);
    return fail('Internal error while running the tool. The operation may not have completed; check the server log.');
  }
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const actor = () => {
    const author = authorFor(ctx.clientName());
    return { author, clientName: author.name };
  };
  const write = <T>(fn: () => Promise<T>) => ctx.lock.runExclusive(fn);

  server.registerTool(
    'list_directory',
    {
      title: 'List directory',
      description:
        'List the entries at a bundle path (lists and areas such as notes alike): subdirectories with counts, and concepts with frontmatter only. Default path is the bundle root, which also reports every flagged concept (problems). Use this to browse the hierarchy and discover what exists.',
      inputSchema: {
        path: z
          .string()
          .default('')
          .describe('Bundle-relative directory path, no leading slash. Empty string means the bundle root.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guard(async () => listDirectory(ctx.root, args)),
  );

  server.registerTool(
    'list_concepts',
    {
      title: 'List concepts',
      description:
        'Flat filtered query across the bundle. Returns frontmatter only, no bodies, paged with cursor. Use tags to find everything carrying all of the given tags, and bare_only to find entries still missing both runtime and resource. path accepts any directory (a list, notes, or any area). When path is a list and list_status is given, list_status must be valid for that list. A list_status filter excludes notes, which have none.',
      inputSchema: {
        path: z.string().optional().describe(FILTER_HELP),
        list_status: z.string().optional().describe(STATUS_HELP),
        tags: z.array(z.string()).optional().describe('Concepts must carry every listed tag.'),
        bare_only: z.boolean().default(false).describe('Only concepts missing both runtime and resource.'),
        limit: limitSchema(50).describe('Page size, 1 to 100.'),
        cursor: z.string().optional().describe('Opaque cursor (next_cursor) from a previous response.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guard(async () => listConcepts(ctx.root, args)),
  );

  server.registerTool(
    'read_concept',
    {
      title: 'Read concept',
      description:
        'Read one full concept: frontmatter, body, its links and backlinks (as concept IDs) and any problems. Flagged concepts also return the raw file text. Select by full concept ID (path without .md), never by bare filename; use list_directory or search_concepts to find IDs.',
      inputSchema: {
        id: z.string().describe('Concept ID, e.g. anime/86-eighty-six.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guard(async () => readConcept(ctx.root, args)),
  );

  server.registerTool(
    'search_concepts',
    {
      title: 'Search concepts',
      description:
        'Full-text search over title, description, body, and tags. Case-insensitive substring match, title matches first. Returns frontmatter and a snippet per result.',
      inputSchema: {
        query: z.string().describe('Text to look for.'),
        path: z.string().optional().describe(FILTER_HELP),
        list_status: z.string().optional().describe(STATUS_HELP),
        limit: limitSchema(20).describe('Maximum results, 1 to 100.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guard(async () => searchConcepts(ctx.root, args)),
  );

  server.registerTool(
    'create_concept',
    {
      title: 'Create concept',
      description:
        'Create a new concept in a directory (path). Pass path and title; the server derives the file name and concept ID (made unique if taken), sets generated, regenerates index.md, commits, and returns the new ID and commit. Type: the explicit type if given; else derived from the list for the six media lists; else Note under notes/ (flat or nested); else type is required and the call fails naming it. Inside the six lists, list_status defaults to the list\'s first status and a type that disagrees with the list is rejected. Outside them (notes and other areas) there is no list_status (rejected: use status); status defaults to draft. Directories are created on demand. New concepts have no verified entry, so they start stale. Bare entries (title only) are fine: fill in runtime and resource later with update_concept.',
      inputSchema: {
        path: z.string().min(1).describe(PATH_HELP),
        title: z.string().min(1).describe('Title of the concept.'),
        type: z.string().optional().describe('Concept type, e.g. Note. Optional in the six lists and under notes/, required elsewhere.'),
        status: z.enum(['draft', 'stable', 'deprecated']).optional().describe(OKF_STATUS_HELP),
        list_status: z.string().optional().describe(`${STATUS_HELP} Defaults to the list's first status.`),
        description: z.string().optional(),
        resource: z.url().optional().describe('Where to watch, read, or play it (URL).'),
        runtime: z.string().optional().describe('e.g. "~552 min".'),
        author: z.string().optional().describe('Author (books).'),
        tags: z.array(z.string()).optional(),
        body: z.string().optional().describe('Markdown body.'),
      },
    },
    (args) => guard(() => write(async () => createConcept(ctx.root, args, actor()))),
  );

  server.registerTool(
    'update_concept',
    {
      title: 'Update concept',
      description:
        'Patch a concept\'s frontmatter and/or replace its body, then commit. Only the frontmatter keys given change; body replaces the whole body. List status moves are update_concept with frontmatter.list_status (the file stays where it is); outside the six lists use frontmatter.status (draft, stable, deprecated) instead, and list_status is rejected. Works on notes and other areas too; type is never overwritten there. A title change does not rename the file. Pass null for description, resource, runtime, author, tags, status_detail, verified or stale_after to remove that key (title and list_status cannot be removed). Give at least one of frontmatter or body. To repair a flagged concept whose frontmatter cannot be parsed, send a complete frontmatter (title and a list_status valid for its list); the body is kept.',
      inputSchema: {
        id: z.string().describe('Concept ID, e.g. anime/86-eighty-six.'),
        frontmatter: z
          .object({
            title: z.string().optional(),
            description: z.string().nullable().optional(),
            resource: z.url().nullable().optional(),
            runtime: z.string().nullable().optional(),
            author: z.string().nullable().optional(),
            tags: z.array(z.string()).nullable().optional(),
            list_status: z.string().optional().describe(STATUS_HELP),
            status: z.enum(['draft', 'stable', 'deprecated']).optional().describe(OKF_STATUS_HELP),
            status_detail: z.string().nullable().optional(),
            verified: z
              .array(z.object({ by: z.string(), at: z.string().describe('ISO date-time') }))
              .nullable()
              .optional()
              .describe('Replaces the whole verified list.'),
            stale_after: z.string().nullable().optional().describe('ISO date-time after which the concept is stale.'),
          })
          .strict()
          .optional(),
        body: z.string().optional().describe('Replaces the whole body.'),
      },
    },
    (args) => guard(() => write(async () => updateConcept(ctx.root, args, actor()))),
  );

  server.registerTool(
    'move_concept',
    {
      title: 'Move concept',
      description:
        'Move a concept to another directory and/or rename its file, as one commit. "to" is a target directory such as "western-animation" or "anime/gundam" (created if needed). "name" renames the file (slugged, suffixed if taken). The concept gets a new ID; incoming links in other concepts are rewritten and index.md files regenerated. Moving to another list changes its type and fails if the current list_status is not allowed there, unless you pass a valid list_status for the new list. Moving out of the six lists drops list_status, sets status draft (unless you pass status) and keeps the type (unless you pass type); moving into notes/ or below sets type Note. Moving from an area into a list drops status and needs a valid list_status. Moves between other directories keep the type.',
      inputSchema: {
        id: z.string().describe('Concept ID to move.'),
        to: z.string().describe('Target directory, e.g. "movies", "anime/gundam" or "notes/projects".'),
        name: z.string().optional().describe('New file name (without .md).'),
        type: z.string().optional().describe('Type to set when moving out of the six lists.'),
        status: z.enum(['draft', 'stable', 'deprecated']).optional().describe(`${OKF_STATUS_HELP} Used when moving out of the six lists (default draft).`),
        list_status: z.string().optional().describe(`${STATUS_HELP} Needed when moving across lists with an incompatible status.`),
      },
    },
    (args) => guard(() => write(async () => moveConcept(ctx.root, args, actor()))),
  );

  server.registerTool(
    'list_stale',
    {
      title: 'List stale concepts',
      description:
        'Concepts in the six media lists past their stale_after, or with no verified entry, oldest first (by stale_after, else generated.at). Each has a reason: past_stale_after or unverified. Notes and other areas are exempt (path=notes returns nothing). Feeds the re-verification scan; record the check with update_concept (frontmatter.verified).',
      inputSchema: {
        path: z.string().optional().describe(FILTER_HELP),
        limit: limitSchema(20).describe('Page size, 1 to 100.'),
        cursor: z.string().optional().describe('Opaque cursor (next_cursor) from a previous response.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guard(async () => listStale(ctx.root, args)),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'All tags in use across the bundle, with counts, most used first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => listTags(ctx.root)),
  );

  server.registerTool(
    'delete_concept',
    {
      title: 'Delete concept',
      description:
        'Delete a concept. Always two steps: without confirm=true it returns a preview (confirm_required) and deletes nothing. With confirm=true it deletes the file, regenerates index.md, and commits. Any list status may be deleted.',
      inputSchema: {
        id: z.string().describe('Concept ID to delete.'),
        confirm: z.boolean().default(false).describe('Must be true to actually delete.'),
      },
      annotations: { destructiveHint: true },
    },
    (args) => guard(() => write(async () => deleteConcept(ctx.root, args, actor()))),
  );
}
