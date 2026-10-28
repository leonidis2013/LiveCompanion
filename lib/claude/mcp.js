/*
 * The Model Context Protocol side: JSON-RPC over Streamable HTTP, answered with plain
 * JSON (no event stream, no sessions). It understands both the older handshake
 * (initialize, protocol 2024-11-05 .. 2025-11-25) and the stateless 2026-07-28
 * revision (server/discover, per-request protocol version), so current and older
 * Claude apps can connect.
 */
'use strict';

const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK = '2025-11-25';
const META_VER = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

const err = (id, code, message, data) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: Object.assign({ code, message }, data ? { data } : {}) });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * opts.serverInfo   { name, title, version }
 * opts.instructions text for the model
 * opts.listTools()  -> [{ name, title, description, inputSchema, annotations }]
 * opts.callTool(name, args) -> { text, isError }
 */
function create(opts) {
  const capabilities = { tools: { listChanged: false } };

  function versionOf(msg, headers) {
    const m = msg.params && msg.params._meta && msg.params._meta[META_VER];
    return String(m || (headers && headers['mcp-protocol-version']) || '');
  }

  async function one(msg, headers, who) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return err(msg && msg.id, -32600, 'Invalid request');
    }
    const isNote = msg.id === undefined || msg.id === null;
    if (isNote) return null; // notifications (initialized, cancelled, ...) need no answer
    const id = msg.id, p = msg.params || {};
    const ver = versionOf(msg, headers);
    const stateless = ver === '2026-07-28';
    const finish = (r) => { if (stateless) { r.resultType = 'complete'; r._meta = Object.assign({}, r._meta, { [META_SERVER]: opts.serverInfo }); } return ok(id, r); };

    switch (msg.method) {
      case 'initialize': {
        const want = String(p.protocolVersion || '');
        return ok(id, { protocolVersion: VERSIONS.includes(want) ? want : FALLBACK, capabilities, serverInfo: opts.serverInfo, instructions: opts.instructions });
      }
      case 'server/discover':
        return ok(id, { resultType: 'complete', supportedVersions: VERSIONS, capabilities, serverInfo: opts.serverInfo, instructions: opts.instructions, ttlMs: 30000, cacheScope: 'private', _meta: { [META_SERVER]: opts.serverInfo } });
      case 'ping':
        return ok(id, {});
      case 'tools/list': {
        const list = opts.listTools(who);
        if (opts.onListed) opts.onListed(who, list.map((t) => t.name));
        const tools = list.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
        // short: clients that honour it (protocol 2026-07-28) pick up permission changes within seconds
        return finish({ tools, ttlMs: 5000, cacheScope: 'private' });
      }
      case 'tools/call': {
        const name = String(p.name || '');
        if (!opts.listTools(who).some((t) => t.name === name)) return err(id, -32602, 'Unknown tool: ' + name + '. It may not be allowed for this connection.');
        const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {};
        const r = await opts.callTool(name, args, who);
        return finish({ content: [{ type: 'text', text: r.text }], isError: !!r.isError });
      }
      case 'resources/list': return finish({ resources: [], ttlMs: 30000, cacheScope: 'private' });
      case 'prompts/list': return finish({ prompts: [], ttlMs: 30000, cacheScope: 'private' });
      case 'logging/setLevel': return ok(id, {});
      default:
        return err(id, -32601, 'Method not found: ' + msg.method);
    }
  }

  /** Handles a parsed body (one message or a batch). Returns what to send back, or null for 202. */
  /** who: whoever is asking (passed on to listTools and callTool) */
  async function handle(body, headers, who) {
    if (Array.isArray(body)) {
      if (!body.length) return err(null, -32600, 'Empty batch');
      if (body.length > 20) return err(null, -32600, 'Batch too large');
      const out = (await Promise.all(body.map((m) => one(m, headers, who)))).filter(Boolean);
      return out.length ? out : null;
    }
    return one(body, headers, who);
  }

  return { handle };
}

module.exports = { create, VERSIONS, parseError: () => err(null, -32700, 'Parse error') };
