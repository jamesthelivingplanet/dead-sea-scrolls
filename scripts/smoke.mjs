// Read-only smoke check against a running server: initialize, tools/list, list_directory.
// Usage: node scripts/smoke.mjs [url]   (default: the tailnet URL)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] ?? 'http://HOST:32473/mcp';
const client = new Client({ name: 'dead-sea-scrolls-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));
const res = await client.callTool({ name: 'list_directory', arguments: {} });
const dir = res.structuredContent;
const total = dir.directories.reduce((n, d) => n + d.counts.total, 0);
console.log(`lists (${dir.directories.length}):`, dir.directories.map((d) => `${d.name}=${d.counts.total}`).join(', '));
console.log(`concepts total: ${total}, flagged: ${dir.problems.length}`);
await client.close();
process.exit(tools.length === 10 && dir.directories.length === 6 && total === 96 ? 0 : 1);
