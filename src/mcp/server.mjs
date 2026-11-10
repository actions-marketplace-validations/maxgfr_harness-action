#!/usr/bin/env node
// Zero-dependency MCP server (stdio, newline-delimited JSON-RPC 2.0).
//
// It is spawned BY THE HARNESS and therefore runs with the agent's privileges: it holds no
// GitHub token. Write tools append intents to an outbox the publish step replays with the
// token; read tools serve files the prepare step fetched beforehand.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate } from '../contract.mjs';

const STATE = process.env.HARNESS_STATE ?? '';
const outbox = () => path.join(STATE, 'outbox.jsonl');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readText(file) {
  try { return fs.readFileSync(path.join(STATE, file), 'utf8'); } catch { return null; }
}
function enqueue(kind, payload) {
  fs.appendFileSync(outbox(), JSON.stringify({ kind, at: new Date().toISOString(), ...payload }) + '\n');
}

/** What one tool result may hold: about 50,000 tokens. A whole large diff does not fit a context window. */
const DIFF_LIMIT = 200_000;

/** A unified diff as [{ file, text }], one entry per `diff --git` section. */
function diffSections(diff) {
  const sections = [];
  for (const text of diff.split(/^(?=diff --git )/m)) {
    if (!text.startsWith('diff --git ')) continue;
    const name = /^\+\+\+ b\/(.+)$/m.exec(text)?.[1] ?? /^--- a\/(.+)$/m.exec(text)?.[1] ?? /^diff --git a\/(.+?) b\//.exec(text)?.[1] ?? '?';
    sections.push({ file: name.trim(), text });
  }
  return sections;
}

/**
 * The pull request diff as a tool result: whole when it fits, the diff of one file when `path` is
 * given, and otherwise the list of changed files to choose from.
 */
export function prDiff(diff, { path: file, limit = DIFF_LIMIT } = {}) {
  const clip = (text) => (text.length > limit ? `${text.slice(0, limit)}\n… truncated: ${text.length - limit} more characters. Read the file itself for the rest.\n` : text);
  const sections = diffSections(diff);
  const listing = () => sections.map((s) => `- ${s.file} (${s.text.length} characters)`).join('\n');
  if (file) {
    const wanted = String(file).replace(/^\.\//, '');
    const hits = sections.filter((s) => s.file === wanted);
    return hits.length ? clip(hits.map((s) => s.text).join('')) : `"${wanted}" is not in the diff. Changed files:\n${listing()}`;
  }
  if (diff.length <= limit) return diff;
  return `The diff is ${diff.length} characters, too large to return at once. It changes ${sections.length} file(s):\n${listing()}\n\nCall get_pr_diff again with \`path\` set to the file you want.`;
}

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

export function toolDefinitions(cfg) {
  const tools = [
    {
      name: 'update_progress',
      description:
        'Replace the progress section of the tracking comment shown to the user. Pass a short Markdown checklist (- [x] done / - [ ] todo). Call it when you start, and whenever a step completes.',
      inputSchema: { type: 'object', properties: { markdown: str('Markdown checklist / status') }, required: ['markdown'] },
      run: ({ markdown }) => { enqueue('progress', { markdown: String(markdown) }); return 'Progress recorded.'; },
    },
    {
      name: 'report_finding',
      description:
        'Report one finding (bug, violation, risk) at a file location. Findings become annotations, SARIF results and can fail the check depending on configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          file: str('Path relative to the repository root'),
          line: int('1-based line'),
          end_line: int('Optional last line'),
          severity: { type: 'string', enum: ['error', 'warning', 'notice'] },
          title: str('Short title'),
          message: str('What is wrong and how to fix it'),
          rule: str('Optional rule identifier'),
        },
        required: ['file', 'severity', 'message'],
      },
      run: (args) => { enqueue('finding', { finding: args }); return 'Finding recorded.'; },
    },
    {
      name: 'read_thread',
      description: 'Read the issue / pull request conversation (title, body, comments) that triggered this run.',
      inputSchema: { type: 'object', properties: {} },
      run: () => readText('thread.md') ?? 'No conversation is attached to this run.',
    },
  ];
  if (cfg.isPR) {
    tools.push(
      {
        name: 'get_pr_diff',
        description: 'Return the unified diff of the pull request (base...head). A large diff comes back as the list of changed files: call again with `path` to get the diff of one file.',
        inputSchema: { type: 'object', properties: { path: str('Optional: only the diff of this file (path relative to the repository root)') } },
        run: ({ path: file } = {}) => { const diff = readText('pr.diff'); return diff === null ? 'The diff is not available.' : prDiff(diff, { path: file }); },
      },
      {
        name: 'add_inline_comment',
        description:
          'Queue a review comment on a line of the pull request diff (RIGHT side = new code). Comments are posted together as one review when the run ends; lines outside the diff are moved to the summary comment.',
        inputSchema: {
          type: 'object',
          properties: {
            path: str('File path relative to the repository root'),
            line: int('Line number in the new version of the file'),
            start_line: int('Optional first line of a multi-line comment'),
            body: str('Comment body (Markdown). Use a ```suggestion block to propose a change.'),
          },
          required: ['path', 'line', 'body'],
        },
        run: (args) => { enqueue('inline', { comment: args }); return 'Inline comment queued.'; },
      },
    );
  }
  if (cfg.ciStatus) {
    tools.push({
      name: 'get_ci_status',
      description: 'Return the status of the CI checks/workflow runs for the head commit, as fetched when this run started.',
      inputSchema: { type: 'object', properties: {} },
      run: () => readText('ci.json') ?? 'CI status is not available.',
    });
  }
  if (cfg.loop) {
    tools.push({
      name: 'task_complete',
      description: 'Declare that the task is fully done (and verified). Call it once, at the very end. Until you call it, you will be asked to continue.',
      inputSchema: { type: 'object', properties: { summary: str('What was done') }, required: ['summary'] },
      run: ({ summary }) => { enqueue('complete', { summary: String(summary ?? '') }); return 'Task marked as complete.'; },
    });
  }
  if (cfg.schema) {
    tools.push({
      name: 'submit_structured_output',
      description: 'Submit the final structured result of this task. The arguments must follow the required JSON schema. Call it exactly once, at the end.',
      inputSchema: cfg.schema,
      run: (args) => {
        // Checked here, while the agent can still correct it: the publish step validates the
        // same way, but by then the run is over and an invalid result is a failed run.
        const errors = validate(cfg.schema, args);
        if (errors.length) throw new Error(`the result does not follow the schema (${errors.slice(0, 10).join('; ')}). Nothing was recorded: fix it and call this tool again.`);
        fs.writeFileSync(path.join(STATE, 'structured_output.json'), JSON.stringify(args, null, 2));
        return 'Structured output recorded.';
      },
    });
  }
  return tools;
}

function serve() {
  if (!STATE) {
    process.stderr.write('harness-action mcp: HARNESS_STATE is not set\n');
    process.exit(2);
  }
  const tools = toolDefinitions(readJson(path.join(STATE, 'mcp.json'), {}));
  let send;
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'harness', version: '0.1.0' },
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const text = tool.run(params.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text: String(text) }] });
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    if (method === 'resources/list') return reply(id, { resources: [] });
    if (method === 'prompts/list') return reply(id, { prompts: [] });
    if (id !== undefined) return fail(id, -32601, `Method not found: ${method}`);
    // notifications (initialized, cancelled…) need no answer
  }

  // Framing is auto-detected: the MCP spec says newline-delimited JSON, but some clients
  // speak LSP-style `Content-Length` headers. Answer in the framing we were spoken to.
  let framing = null;
  let buffer = Buffer.alloc(0);
  send = (msg) => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    if (framing === 'header') process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    else process.stdout.write(Buffer.concat([body, Buffer.from('\n')]));
  };
  const dispatch = (text) => {
    if (!text.trim()) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  };
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!framing) {
        const head = buffer.toString('utf8', 0, Math.min(buffer.length, 32)).trimStart();
        if (!head.length) return;
        framing = /^content-length:/i.test(head) ? 'header' : head.length >= 15 || head.startsWith('{') || head.startsWith('[') ? 'line' : null;
        if (!framing) return;
      }
      if (framing === 'header') {
        const sep = buffer.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const match = /content-length:\s*(\d+)/i.exec(buffer.toString('utf8', 0, sep));
        if (!match) { buffer = buffer.subarray(sep + 4); continue; }
        const len = Number(match[1]);
        if (buffer.length < sep + 4 + len) return;
        dispatch(buffer.toString('utf8', sep + 4, sep + 4 + len));
        buffer = buffer.subarray(sep + 4 + len);
      } else {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) return;
        dispatch(buffer.toString('utf8', 0, nl).replace(/\r$/, ''));
        buffer = buffer.subarray(nl + 1);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) serve();
