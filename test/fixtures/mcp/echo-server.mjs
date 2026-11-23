#!/usr/bin/env node
// Minimal stdio MCP server for the live e2e (e2e-scenarios.yml): newline-delimited JSON-RPC,
// one tool, `secret_word`, that returns $SECRET_WORD. The word is drawn by the workflow and
// handed over through the `env` of mcp_config only, so an agent that reports it called the tool.
import readline from 'node:readline';

const WORD = process.env.SECRET_WORD || '';
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

const TOOLS = [{
  name: 'secret_word',
  description: 'Return the secret word of this run. Takes no arguments.',
  inputSchema: { type: 'object', properties: {} },
}];

function handle({ id, method, params }) {
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    if (params?.name !== 'secret_word') return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
    if (!WORD) return send({ id, result: { content: [{ type: 'text', text: 'Error: SECRET_WORD is not set' }], isError: true } });
    return send({ id, result: { content: [{ type: 'text', text: WORD }] } });
  }
  if (method === 'resources/list') return send({ id, result: { resources: [] } });
  if (method === 'prompts/list') return send({ id, result: { prompts: [] } });
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  // notifications (initialized, cancelled…) need no answer
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg);
});
