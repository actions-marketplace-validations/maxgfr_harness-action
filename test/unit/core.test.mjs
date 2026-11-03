import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectMode, containsTrigger, keepCommentAuthor, checkAccess } from '../../src/modes.mjs';
import { readInputs, effectiveTools, splitModel } from '../../src/inputs.mjs';
import { validate, failsGate, normalizeFinding, collect } from '../../src/contract.mjs';
import { finalBody, toSarif, findingsTable } from '../../src/publish/render.mjs';
import { toToml, deepMerge, sanitizedEnv } from '../../src/util.mjs';
import { parseSource, parseFrontmatter, discoverSkills, installSkills } from '../../src/skills.mjs';
import { commentableLines } from '../../src/git.mjs';
import { branchNameFor } from '../../src/stages/publish.mjs';
import { buildPrompt } from '../../src/prompt.mjs';
import { resolveStep } from '../mock-llm/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inputs = (over = {}) => readInputs(Object.fromEntries(Object.entries({ model: 'a/b', ...over }).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])));

test('trigger phrase matching', () => {
  assert.ok(containsTrigger('hey @harness fix it', '@harness'));
  assert.ok(containsTrigger('@harness', '@harness'));
  assert.ok(!containsTrigger('mail me@harness.dev', '@harness'));
  assert.ok(!containsTrigger('@harness-bot do', '@harness'));
});

test('mode detection', () => {
  const ctx = (eventName, action, payload) => ({ eventName, action, payload });
  assert.equal(detectMode(ctx('issue_comment', 'created', { comment: { body: '@harness go' } }), inputs()).mode, 'tag');
  assert.equal(detectMode(ctx('issue_comment', 'created', { comment: { body: 'thanks' } }), inputs()).mode, 'skip');
  assert.equal(detectMode(ctx('issue_comment', 'created', { comment: { body: 'thanks' } }), inputs({ prompt: 'triage' })).mode, 'automation');
  assert.equal(detectMode(ctx('issues', 'labeled', { label: { name: 'Harness' }, issue: { title: 't', body: 'b' } }), inputs()).mode, 'tag');
  assert.equal(detectMode(ctx('issues', 'assigned', { assignee: { login: 'bot' }, issue: { title: 't' } }), inputs({ assignee_trigger: '@bot' })).mode, 'tag');
  assert.equal(detectMode(ctx('push', '', {}), inputs({ prompt: 'x' })).mode, 'automation');
  assert.equal(detectMode(ctx('push', '', {}), inputs()).mode, 'skip');
});

test('inputs: validation and defaults', () => {
  const i = inputs();
  assert.equal(i.harness, 'opencode');
  assert.equal(i.triggerPhrase, '@harness');
  assert.equal(effectiveTools('auto', 'tag'), 'edit');
  assert.equal(effectiveTools('auto', 'automation'), 'read-only');
  assert.throws(() => inputs({ harness: 'nope' }), /harness must be one of/);
  assert.throws(() => inputs({ max_steps: '-1' }), /positive/);
  assert.deepEqual(splitModel('openrouter/qwen/qwen3'), { provider: 'openrouter', id: 'qwen/qwen3' });
});

test('access control', async () => {
  const gh = (perm) => ({ get: async () => ({ permission: perm, role_name: perm }) });
  const ctx = { eventName: 'issue_comment', actor: 'eve', senderType: 'User', owner: 'o', repo: 'r' };
  assert.equal((await checkAccess(ctx, inputs(), 'tag', gh('read'))).allowed, false);
  assert.equal((await checkAccess(ctx, inputs(), 'tag', gh('write'))).allowed, true);
  assert.equal((await checkAccess(ctx, inputs({ allowed_non_write_users: 'eve' }), 'tag', gh('read'))).allowed, true);
  const bot = { ...ctx, actor: 'renovate[bot]', senderType: 'Bot' };
  assert.equal((await checkAccess(bot, inputs(), 'tag', gh('write'))).allowed, false);
  assert.equal((await checkAccess(bot, inputs({ allowed_bots: 'renovate' }), 'tag', gh('write'))).allowed, true);
  assert.equal((await checkAccess({ ...ctx, eventName: 'push' }, inputs(), 'automation', gh('none'))).allowed, true);
});

test('comment author filters', () => {
  const i = inputs({ exclude_comments_by_actor: '*[bot]', include_comments_by_actor: 'alice,renovate[bot]' });
  assert.equal(keepCommentAuthor('alice', i), true);
  assert.equal(keepCommentAuthor('bob', i), false);
  assert.equal(keepCommentAuthor('renovate[bot]', i), false);
});

test('json schema validation', () => {
  const schema = { type: 'object', required: ['ok', 'items'], additionalProperties: false, properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } };
  assert.deepEqual(validate(schema, { ok: true, items: ['a'] }), []);
  assert.equal(validate(schema, { ok: 1, items: ['c'], x: 1 }).length, 3);
  assert.match(validate(schema, {}).join(), /missing required property "ok"/);
});

test('findings: normalisation, gate, SARIF, table', () => {
  const f = [normalizeFinding({ file: './a.js', line: '3', severity: 'error', message: 'boom', rule: 'R1' }), normalizeFinding({ path: 'b.js', severity: 'weird', message: 'meh' })];
  assert.equal(f[0].file, 'a.js');
  assert.equal(f[0].line, 3);
  assert.equal(f[1].severity, 'warning');
  assert.equal(failsGate(f, 'error').length, 1);
  assert.equal(failsGate(f, 'warning').length, 2);
  assert.equal(failsGate(f, '').length, 0);
  const sarif = toSarif(f, { harness: 'pi', version: '1' });
  assert.equal(sarif.runs[0].results[0].level, 'error');
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 3);
  assert.match(findingsTable(f), /a\.js:3/);
});

test('outbox collection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-'));
  fs.writeFileSync(path.join(dir, 'outbox.jsonl'), [
    { kind: 'progress', markdown: 'one' }, { kind: 'progress', markdown: 'two' },
    { kind: 'finding', finding: { file: 'x', severity: 'notice', message: 'n' } },
    { kind: 'inline', comment: { path: 'x', line: 2, body: 'b' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
  const c = collect(dir);
  assert.equal(c.progress, 'two');
  assert.equal(c.findings.length, 1);
  assert.equal(c.inline.length, 1);
});

test('final comment rendering', () => {
  const body = finalBody({ harness: 'pi', model: 'a/b', runUrl: 'u', run: { durationMs: 61000, tools: 2, costKnown: true, cost: 0.01 }, status: 'success', finalText: 'All good', branch: { name: 'harness/x', url: 'bu', created: true, prUrl: 'pu' } });
  assert.match(body, /harness-action:tracking/);
  assert.match(body, /All good/);
  assert.match(body, /Create PR/);
  assert.match(body, /1m 1s/);
});

test('toml + merge + env sanitising', () => {
  assert.equal(toToml({ a: 1, t: { b: 'x' } }), 'a = 1\n\n[t]\nb = "x"\n');
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  const env = sanitizedEnv({ GITHUB_TOKEN: 'x', INPUT_GITHUB_TOKEN: 'y', HARNESS_INPUTS: '{}', PATH: '/bin', OPENAI_API_KEY: 'k' });
  assert.deepEqual(Object.keys(env).sort(), ['OPENAI_API_KEY', 'PATH']);
});

test('skill sources and frontmatter', () => {
  assert.deepEqual(parseSource('acme/skills@v2#lint'), { type: 'git', url: 'https://github.com/acme/skills.git', ref: 'v2', skill: 'lint', raw: 'acme/skills@v2#lint' });
  assert.equal(parseSource('https://github.com/a/b').url, 'https://github.com/a/b.git');
  assert.equal(parseSource('./skills').type, 'local');
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: >\n  long\n  text\n---\nbody'), { name: 'x', description: 'long text' });
  const found = discoverSkills(path.join(ROOT, 'test', 'fixtures', 'skills'));
  assert.equal(found[0].name, 'echo-check');
});

test('skills are installed into the isolated home, repository skills included', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-skills-'));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(work, '.claude', 'skills', 'local-one'), { recursive: true });
  fs.writeFileSync(path.join(work, '.claude', 'skills', 'local-one', 'SKILL.md'), '---\nname: local-one\ndescription: d\n---\n');
  const list = installSkills({ sources: [path.join(ROOT, 'test', 'fixtures', 'skills')], home: path.join(tmp, 'home'), workDir: work });
  assert.deepEqual(list.map((s) => s.name).sort(), ['echo-check', 'local-one']);
  for (const base of ['.agents/skills', '.claw/skills']) assert.ok(fs.existsSync(path.join(tmp, 'home', base, 'echo-check', 'SKILL.md')));
});

test('diff → commentable lines', () => {
  const lines = commentableLines('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n');
  assert.deepEqual([...lines.get('f')], [1, 2, 3, 4]);
});

test('branch names', () => {
  const now = new Date('2026-11-03T10:20:30Z');
  assert.equal(branchNameFor({ prefix: 'harness/', ctx: { number: 7, isPR: false }, now }), 'harness/issue-7-20261103-1020');
  assert.equal(branchNameFor({ template: '{{prefix}}{{entityNumber}}-{{description}}', prefix: 'bot/', ctx: { number: 3, isPR: true, title: 'Fix: the Thing!' }, now }), 'bot/3-fix-the-thing');
});

test('prompt mentions the skill and the harness-specific MCP tool names', () => {
  const base = { mode: 'automation', ctx: { repoFull: 'o/r', eventName: 'push', actor: 'a' }, perms: { level: 'read-only', bash: 'none', edit: false }, skills: [{ name: 's1', description: 'd', dir: '/h/s1' }], skill: 's1', request: 'do it' };
  assert.match(buildPrompt({ ...base, harness: 'opencode' }), /harness_report_finding/);
  assert.match(buildPrompt({ ...base, harness: 'codex' }), /\$s1/);
  assert.match(buildPrompt({ ...base, harness: 'claw' }), /mcp__harness__report_finding/);
});

test('mock LLM resolves steps against each harness tool shape', () => {
  assert.equal(resolveStep({ tool: 'report_finding' }, [{ function: { name: 'harness_report_finding' } }]).call.name, 'harness_report_finding');
  assert.equal(resolveStep({ shell: 'ls' }, [{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: 'string' } } } }]).call.args.cmd, 'ls');
  assert.equal(resolveStep({ tool: 'x' }, [{ type: 'namespace', name: 'mcp__harness', tools: [{ type: 'function', name: 'x' }] }]).call.namespace, 'mcp__harness');
});

function mcpSession(stateDir, framing, messages) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp', 'server.mjs')], { env: { ...process.env, HARNESS_STATE: stateDir } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    for (const m of messages) {
      const body = JSON.stringify(m);
      child.stdin.write(framing === 'header' ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
    }
    child.stdin.end();
    child.on('close', () => resolve(out));
  });
}

test('MCP server: newline and Content-Length framing, outbox, structured output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-mcp-'));
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ isPR: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }));
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report_finding', arguments: { file: 'a', severity: 'error', message: 'm' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'submit_structured_output', arguments: { ok: true } } },
  ];
  const line = await mcpSession(dir, 'line', msgs);
  const replies = line.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(replies[0].result.serverInfo.name, 'harness');
  assert.ok(replies[1].result.tools.some((t) => t.name === 'add_inline_comment'));
  assert.ok(replies[1].result.tools.some((t) => t.name === 'submit_structured_output'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'structured_output.json'), 'utf8')), { ok: true });
  const header = await mcpSession(dir, 'header', msgs.slice(0, 1));
  assert.match(header, /^Content-Length: \d+\r\n\r\n\{/);
  assert.equal(collect(dir).findings.length, 1);
});
