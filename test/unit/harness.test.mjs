import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHarness } from '../../src/runner.mjs';
import { capture } from '../../src/harness/exec.mjs';
import { buildConfig as opencodeConfig } from '../../src/harness/opencode.mjs';
import { fileURLToPath } from 'node:url';
import { getAdapter, createAccumulator, permissionProfile, splitArgs } from '../../src/harness/index.mjs';
import { buildConfig as codexConfig } from '../../src/harness/codex.mjs';
import { toolList } from '../../src/harness/pi.mjs';
import { buildConfig as openclawConfig } from '../../src/harness/openclaw.mjs';
import { resolveEndpoint } from '../../src/harness/providers.mjs';
import { redactMcpSecrets } from '../../src/stages/prepare.mjs';
import { toToml } from '../../src/util.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'events');

function replay(id, file) {
  const adapter = getAdapter(id);
  const acc = createAccumulator();
  const text = fs.readFileSync(path.join(FIX, file), 'utf8');
  const events = adapter.streaming
    ? text.split('\n').filter(Boolean).flatMap((l) => adapter.parse(JSON.parse(l)))
    : adapter.parseAll(text);
  for (const ev of events) acc.push(ev);
  return { acc, events };
}

const ext = (id) => (id === 'openclaw' ? 'json' : 'jsonl'); // OpenClaw prints one JSON document

for (const id of ['opencode', 'codex', 'pi', 'openclaw']) {
  test(`${id}: tool run is parsed into the normalised model`, () => {
    const { acc, events } = replay(id, `${id}-tools.${ext(id)}`);
    assert.match(acc.finalText, /ECHO_DONE/);
    assert.equal(acc.tools, 2, `${id} tool calls: ${acc.toolCalls}`);
    assert.ok(acc.toolCalls.some((n) => /report_finding/.test(n)));
    assert.ok(acc.inputTokens > 0);
    assert.equal(acc.errors.length, 0);
    assert.ok(acc.sessionId);
    assert.ok(events.some((e) => e.t === 'tool_result'));
  });

  test(`${id}: provider failure surfaces as an error`, () => {
    const { acc } = replay(id, `${id}-error.${ext(id)}`);
    assert.ok(acc.errors.length >= 1, `${id} errors`);
    assert.match(acc.errors.at(-1), /401|auth|Unauthorized|sign in/i);
  });
}

test('codex transient reconnect errors are warnings, turn.failed is the error', () => {
  const { acc, events } = replay('codex', 'codex-error.jsonl');
  assert.equal(acc.errors.length, 1);
  assert.ok(events.filter((e) => e.t === 'warning').length >= 1);
});

test('permission profiles', () => {
  assert.deepEqual(permissionProfile('read-only'), { level: 'read-only', edit: false, bash: 'none', allowBash: [], web: false });
  assert.equal(permissionProfile('edit', ['npm test*']).bash, 'allowlist');
  assert.equal(permissionProfile('full').bash, 'all');
});

test('openclaw config: tool search off, permissions as deny lists, env-referenced key, skills dir', () => {
  const base = { model: { provider: 'mock', id: 'm1' }, mcpServers: { harness: { command: 'node', args: ['s.mjs'], env: { A: '1' } } }, workDir: '/w', skillsDir: '/h/.agents/skills' };
  const ro = openclawConfig({ ...base, endpoint: resolveEndpoint({ provider: 'mock', baseUrl: 'http://x/v1', apiKeyEnv: 'K' }), perms: permissionProfile('read-only') });
  assert.equal(ro.tools.toolSearch, false);
  for (const t of ['write', 'edit', 'apply_patch', 'exec', 'web_fetch', 'ask_user']) assert.ok(ro.tools.deny.includes(t), t);
  assert.equal(ro.tools.exec.mode, 'deny');
  assert.deepEqual(ro.models.providers.mock.apiKey, { source: 'env', provider: 'env', id: 'K' }); // never the key itself
  assert.deepEqual(ro.secrets.providers.env, { source: 'env' });
  assert.deepEqual(ro.skills.load.extraDirs, ['/h/.agents/skills']);
  assert.equal(ro.agents.defaults.workspace, '/w');
  assert.deepEqual(ro.mcp.servers.harness, { command: 'node', args: ['s.mjs'], env: { A: '1' } });
  const full = openclawConfig({ ...base, model: { provider: 'anthropic', id: 'claude-haiku-5-5' }, endpoint: resolveEndpoint({ provider: 'anthropic' }), perms: permissionProfile('full') });
  assert.ok(!full.tools.deny.includes('exec'));
  assert.equal(full.tools.exec.mode, 'full');
  assert.equal(full.models, undefined); // a built-in provider needs no provider block
  assert.equal(full.agents.defaults.model, 'anthropic/claude-haiku-5-5');
});

test('codex config: sandbox, providers, MCP auto-approval', () => {
  const base = { model: { provider: 'openrouter', id: 'qwen/qwen3-coder' }, perms: permissionProfile('read-only'), mcpServers: { harness: { command: 'node', args: ['s'] } }, workDir: '/w' };
  const cfg = codexConfig({ ...base, endpoint: resolveEndpoint({ provider: 'openrouter' }) });
  assert.equal(cfg.sandbox_mode, 'read-only');
  assert.equal(cfg.model_provider, 'openrouter');
  assert.equal(cfg.model_providers.openrouter.env_key, 'OPENROUTER_API_KEY');
  assert.equal(cfg.mcp_servers.harness.default_tools_approval_mode, 'approve');
  const openai = codexConfig({ ...base, model: { provider: 'openai', id: 'gpt-5.1' }, endpoint: resolveEndpoint({ provider: 'openai' }) });
  assert.equal(openai.model_provider, undefined);
  assert.throws(() => codexConfig({ ...base, model: { provider: 'anthropic', id: 'x' }, endpoint: resolveEndpoint({ provider: 'anthropic' }) }), /OpenAI-compatible/);
});

test('pi tool list keeps MCP tools', () => {
  assert.deepEqual(toolList(permissionProfile('read-only')), ['read', 'grep', 'find', 'ls', 'mcp__*']);
  assert.ok(toolList(permissionProfile('full')).includes('bash'));
});

test('openclaw command: the action picks the session id, then reuses it', () => {
  const a = getAdapter('openclaw');
  const first = a.command({ prepared: { newSessionId: 'new-id' }, prompt: 'hi', extraArgs: [], sessionId: null, timeoutMinutes: 2 });
  assert.equal(first.sessionId, 'new-id');
  assert.deepEqual(first.args.slice(0, 4), ['agent', '--local', '--session-id', 'new-id']);
  assert.ok(first.args.includes('--json'));
  assert.equal(first.args[first.args.indexOf('--timeout') + 1], '120');
  assert.equal(a.command({ prepared: { newSessionId: 'new-id' }, prompt: 'hi', extraArgs: [], sessionId: 'old-id' }).sessionId, 'old-id');
});

test('runner: exit 1 after a finished turn keeps the result; exit 1 without one fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-runner-'));
  const fake = (lines, code) => {
    const script = path.join(tmp, `fake-${code}-${lines.length}.mjs`);
    fs.writeFileSync(script, `${lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n')}\nprocess.exit(${code});\n`);
    return script;
  };
  const run = (script) => runHarness({ adapter: getAdapter('opencode'), bin: process.execPath, args: [script], stdin: null, cwd: tmp, env: process.env, executionFile: path.join(tmp, `exec-${path.basename(script)}.jsonl`), limits: { maxSteps: 50, timeoutMinutes: 1, budgetUsd: 0 }, log: () => {} });
  const finished = [
    { type: 'tool_use', part: { tool: 'websearch', state: { status: 'error', input: {}, error: 'Web search cancelled' } } },
    { type: 'text', sessionID: 's', part: { text: 'REPORT DONE' } },
    { type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0 } },
  ];
  const ok = await run(fake(finished, 1));
  assert.equal(ok.status, 'success');
  assert.match(ok.acc.finalText, /REPORT DONE/);
  const bad = await run(fake([{ type: 'step_start', sessionID: 's', part: {} }], 1));
  assert.equal(bad.status, 'error');
  assert.match(bad.acc.errors.at(-1), /exited with code 1/);

  // a remark followed by more work is not a finished turn: the harness died in the middle
  const midTask = [
    { type: 'text', sessionID: 's', part: { text: 'I will start by reading the code.' } },
    { type: 'tool_use', part: { tool: 'edit', state: { status: 'completed', input: {}, output: 'ok' } } },
  ];
  const crashed = await run(fake(midTask, 2));
  assert.equal(crashed.status, 'error');
  assert.match(crashed.acc.errors.at(-1), /exited with code 2/);
  // … and neither is a process killed by a signal, whatever it printed last
  const script = path.join(tmp, 'killed.mjs');
  fs.writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(finished[1]))});\nsetTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);\nsetTimeout(() => {}, 5000);\n`);
  const killed = await run(script);
  assert.equal(killed.status, 'error');
});

test('runner: a harness that exits without reading its stdin is an error, not a crash', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-runner-stdin-'));
  // codex gets its prompt on stdin; a prompt larger than the pipe buffer is still being written
  // when the process is already gone
  const result = await runHarness({ adapter: getAdapter('codex'), bin: process.execPath, args: ['-e', 'process.exit(3)'], stdin: 'x'.repeat(2_000_000), cwd: tmp, env: process.env, executionFile: path.join(tmp, 'exec.jsonl'), limits: { maxSteps: 50, timeoutMinutes: 1, budgetUsd: 0 }, log: () => {} });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 3);
  const helper = await capture(process.execPath, ['-e', 'process.exit(4)'], { env: process.env, cwd: tmp, stdin: 'x'.repeat(2_000_000) });
  assert.equal(helper.code, 4);
});

test('opencode: web search gets a keyless provider only when web access is allowed', () => {
  const base = { model: { provider: 'anthropic', id: 'm' }, endpoint: resolveEndpoint({ provider: 'anthropic' }), mcpServers: {} };
  assert.deepEqual(opencodeConfig({ ...base, perms: permissionProfile('full') }).websearch, { provider: 'exa' });
  assert.equal(opencodeConfig({ ...base, perms: permissionProfile('read-only') }).websearch, undefined);
});

test('MCP header and env values are redacted from the configs kept in the report', () => {
  const mcpConfig = {
    docs: { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer docs-token-123' } },
    db: { command: 'npx', args: ['-y', 'db-mcp'], env: { DATABASE_URL: 'postgres://u:p"w@host/db', MODE: 'ro' } },
  };
  const mcpServers = { ...mcpConfig, harness: { command: 'node', args: ['s.mjs'], env: { HARNESS_STATE: '/tmp/state' } } };
  const base = { model: { provider: 'openai', id: 'm' }, endpoint: resolveEndpoint({ provider: 'openai' }), perms: permissionProfile('read-only'), mcpServers, workDir: '/w', skillsDir: '/s' };
  const configs = [
    JSON.stringify(opencodeConfig(base), null, 2),
    toToml(codexConfig(base), { inline: [/^mcp_servers\.[^.]+\.(env|http_headers)$/] }),
    JSON.stringify(openclawConfig(base), null, 2),
  ];
  for (const text of configs) {
    assert.match(text, /docs-token-123/); // the live config needs them
    const shown = redactMcpSecrets(text, mcpConfig);
    assert.doesNotMatch(shown, /docs-token-123|postgres:|p\\"w/);
    assert.match(shown, /"\*\*\*"/);
    assert.match(shown, /docs\.example\/mcp/); // not a secret
    assert.match(shown, /\/tmp\/state/); // the action's own server is left alone
  }
  assert.equal(redactMcpSecrets('{"a":"b"}', null), '{"a":"b"}');
});

test('splitArgs honours quotes', () => {
  assert.deepEqual(splitArgs(`--a 1 --b "two words" --c ''`), ['--a', '1', '--b', 'two words', '--c', '']);
});
