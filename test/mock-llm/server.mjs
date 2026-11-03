#!/usr/bin/env node
// Scripted mock LLM for keyless end-to-end tests.
//
// Speaks OpenAI Chat Completions, OpenAI Responses and Anthropic Messages (streaming and not).
// A script is a list of steps replayed in order, whatever harness is on the other end:
//   { "tool": "report_finding", "args": {…} }  → call the offered tool whose name ends with it
//   { "shell": "echo hi > x" }                  → call the harness's shell tool (bash, exec_command…)
//   { "text": "done" }                          → final answer
// The step index is derived from the conversation itself (number of tool rounds so far), so
// the server is stateless and every harness retry lands on the same step.
//
//   node test/mock-llm/server.mjs --port 4010 --script script.json [--log requests.jsonl]
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SHELL_TOOLS = /^(bash|exec_command|shell|run_shell_command|local_shell|Bash|run_command)$/;

export function flattenTools(tools = []) {
  const out = [];
  for (const t of tools) {
    if (Array.isArray(t.tools)) {
      for (const inner of flattenTools(t.tools)) out.push({ ...inner, namespace: inner.namespace ?? t.name });
      continue;
    }
    const name = t.function?.name ?? t.name;
    if (!name) continue;
    out.push({ name, schema: t.function?.parameters ?? t.parameters ?? t.input_schema ?? {}, type: t.type });
  }
  return out;
}

function shellArgs(schema, cmd) {
  const props = schema?.properties ?? {};
  const args = {};
  for (const [key, def] of Object.entries(props)) {
    if (key === 'command' || key === 'cmd') args[key] = def.type === 'array' ? ['bash', '-lc', cmd] : cmd;
  }
  if (!Object.keys(args).length) args.command = cmd;
  if (props.description) args.description = 'run a shell command';
  return args;
}

export function resolveStep(step, tools) {
  if (!step || step.text !== undefined) return { text: step?.text ?? 'done' };
  const offered = flattenTools(tools);
  if (step.shell !== undefined) {
    const t = offered.find((x) => SHELL_TOOLS.test(x.name));
    if (!t) return { text: `MOCK_ERROR no shell tool among: ${offered.map((x) => x.name).join(', ')}` };
    return { call: { name: t.name, namespace: t.namespace, args: shellArgs(t.schema, step.shell) } };
  }
  const want = step.tool;
  const t =
    offered.find((x) => x.name === want) ??
    offered.find((x) => x.name.endsWith(`__${want}`) || x.name.endsWith(`_${want}`) || x.name.endsWith(`.${want}`));
  if (t) return { call: { name: t.name, namespace: t.namespace, args: step.args ?? {} } };
  // claw-code style: MCP tools are deferred (discoverable through ToolSearch) but callable by
  // their qualified name straight away.
  if (offered.some((x) => x.name === 'ToolSearch')) {
    return { call: { name: `mcp__${step.server ?? 'harness'}__${want}`, args: step.args ?? {} } };
  }
  return { text: `MOCK_ERROR no tool matching ${want} among: ${offered.map((x) => x.name).join(', ')}` };
}

/** How many tool rounds the conversation already contains. */
export function roundsSoFar(api, body) {
  if (api === 'responses') {
    return (Array.isArray(body.input) ? body.input : []).filter((i) => /function_call$|custom_tool_call$/.test(i.type ?? '') && !/output/.test(i.type)).length;
  }
  if (api === 'anthropic') {
    return (body.messages ?? []).filter((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_use')).length;
  }
  return (body.messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
}

const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

function sseWriter(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return (event, data) => res.write((event ? `event: ${event}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function chat(res, body, out) {
  const id = 'chatcmpl-mock';
  const message = out.call
    ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: out.call.name, arguments: JSON.stringify(out.call.args) } }] }
    : { role: 'assistant', content: out.text };
  const finish = out.call ? 'tool_calls' : 'stop';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
  }
  const w = sseWriter(res);
  const base = { id, object: 'chat.completion.chunk', model: body.model };
  if (out.call) {
    const tc = message.tool_calls[0];
    w(null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }] });
    w(null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] });
  } else {
    w(null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: out.text }, finish_reason: null }] });
  }
  w(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
  w(null, '[DONE]');
  res.end();
}

function responses(res, body, out) {
  const w = sseWriter(res);
  const respId = `resp_${Date.now()}`;
  let item;
  if (out.call) {
    item = { type: 'function_call', id: `fc_${Date.now()}`, call_id: `call_${Date.now()}`, name: out.call.name, arguments: JSON.stringify(out.call.args), status: 'completed' };
    if (out.call.namespace) item.namespace = out.call.namespace;
  } else {
    item = { type: 'message', id: `msg_${Date.now()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: out.text, annotations: [] }] };
  }
  w('response.created', { type: 'response.created', response: { id: respId, status: 'in_progress', output: [] } });
  w('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: out.call ? { ...item, arguments: '', status: 'in_progress' } : { ...item, status: 'in_progress', content: [] } });
  if (out.call) {
    w('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
    w('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    w('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: out.text });
  }
  w('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
  w('response.completed', {
    type: 'response.completed',
    response: { id: respId, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } },
  });
  res.end();
}

function anthropic(res, body, out) {
  const block = out.call
    ? { type: 'tool_use', id: `toolu_${Date.now()}`, name: out.call.name, input: out.call.args }
    : { type: 'text', text: out.text };
  const stop = out.call ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stop, usage: { input_tokens: 100, output_tokens: 10 } }));
  }
  const w = sseWriter(res);
  w('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  if (out.call) {
    w('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    w('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  } else {
    w('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    w('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } });
  }
  w('content_block_stop', { type: 'content_block_stop', index: 0 });
  w('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 10 } });
  w('message_stop', { type: 'message_stop' });
  res.end();
}

export function createMockServer({ steps = [], log, fail = 0 } = {}) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const url = req.url.replace(/\?.*/, '');
      if (log) fs.appendFileSync(log, JSON.stringify({ method: req.method, url, body }) + '\n');
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }], models: [] }));
      }
      if (fail) {
        res.writeHead(fail, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'authentication_error', message: `mock failure ${fail}`, code: fail } }));
      }
      const api = url.endsWith('/responses') ? 'responses' : url.endsWith('/messages') ? 'anthropic' : url.endsWith('/chat/completions') ? 'chat' : null;
      if (!api) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}'); }
      const tools = body.tools ?? [];
      // Side requests (session titles, summaries) come without tools: never consume a step.
      const out = tools.length ? resolveStep(steps[roundsSoFar(api, body)], tools) : { text: 'harness run' };
      if (api === 'responses') return responses(res, body, out);
      if (api === 'anthropic') return anthropic(res, body, out);
      return chat(res, body, out);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
  const script = arg('script') ? JSON.parse(fs.readFileSync(arg('script'), 'utf8')) : { steps: [] };
  const port = Number(arg('port', '4010'));
  createMockServer({ steps: script.steps ?? script, log: arg('log'), fail: Number(arg('fail', '0')) }).listen(port, '127.0.0.1', () => {
    process.stdout.write(`mock-llm listening on http://127.0.0.1:${port}\n`);
  });
}
