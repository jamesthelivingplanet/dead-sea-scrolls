import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/server.js';

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

function initBody(version: string, name = 'raw-client') {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name, version: '1' } },
  };
}

async function rawInit(url: string, version: string, name?: string) {
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(initBody(version, name)) });
  return { res, json: (await res.json()) as any };
}

describe('MCP server transport', () => {
  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('initializes with protocol %s', async (version) => {
    t = await startTestServer({ connectClient: false });
    const { res, json } = await rawInit(t.url, version);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    expect(json.result.protocolVersion).toBe(version);
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.serverInfo.name).toBe('dead-sea-scrolls');
    expect(t.server.sessionCount()).toBe(1);
  });

  it('ignores the query string and 404s other paths', async () => {
    t = await startTestServer({ connectClient: false });
    const ok = await rawInit(`${t.url}?x=1`, '2025-06-18');
    expect(ok.res.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${t.port}/other`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${t.port}/`)).status).toBe(404);
  });

  it('GET /mcp is 405 with an Allow header', async () => {
    t = await startTestServer({ connectClient: false });
    const res = await fetch(t.url, { headers: { Accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, DELETE');
  });

  it('rejects unknown and missing sessions', async () => {
    t = await startTestServer({ connectClient: false });
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    const unknown = await fetch(t.url, { method: 'POST', headers: { ...HEADERS, 'Mcp-Session-Id': 'nope' }, body: JSON.stringify(call) });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error.message).toMatch(/session/i);
    const missing = await fetch(t.url, { method: 'POST', headers: HEADERS, body: JSON.stringify(call) });
    expect(missing.status).toBe(400);
    const del = await fetch(t.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': 'nope' } });
    expect(del.status).toBe(404);
  });

  it('rejects bad JSON (400) and oversized bodies (413)', async () => {
    t = await startTestServer({ connectClient: false });
    const bad = await fetch(t.url, { method: 'POST', headers: HEADERS, body: '{nope' });
    expect(bad.status).toBe(400);
    const big = await fetch(t.url, { method: 'POST', headers: HEADERS, body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) });
    expect(big.status).toBe(413);
  });

  it('DELETE closes the session', async () => {
    t = await startTestServer({ connectClient: false });
    const { res } = await rawInit(t.url, '2025-11-25');
    const sid = res.headers.get('mcp-session-id')!;
    const del = await fetch(t.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-11-25' } });
    expect(del.status).toBe(200);
    expect(t.server.sessionCount()).toBe(0);
    const after = await fetch(t.url, {
      method: 'POST',
      headers: { ...HEADERS, 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(after.status).toBe(404);
  });

  it('evicts the least recently used session past the cap of 20', async () => {
    t = await startTestServer({ connectClient: false });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push((await rawInit(t.url, '2025-11-25', `c${i}`)).res.headers.get('mcp-session-id')!);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(t.server.sessionCount()).toBe(20);
    const extra = (await rawInit(t.url, '2025-11-25', 'c20')).res.headers.get('mcp-session-id')!;
    expect(t.server.sessionCount()).toBe(20);
    const probe = (sid: string) =>
      fetch(t!.url, {
        method: 'POST',
        headers: { ...HEADERS, 'Mcp-Session-Id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
    expect((await probe(ids[0]!)).status).toBe(404);
    expect((await probe(ids[1]!)).status).toBe(200);
    expect((await probe(extra)).status).toBe(200);
  });

  it('drops idle sessions on the sweep', async () => {
    t = await startTestServer({ connectClient: false, serverOptions: { idleTimeoutMs: 150, sweepIntervalMs: 50 } });
    await rawInit(t.url, '2025-11-25');
    expect(t.server.sessionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(t.server.sessionCount()).toBe(0);
  });
});
