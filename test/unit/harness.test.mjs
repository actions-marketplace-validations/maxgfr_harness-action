import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, createAccumulator, permissionProfile, splitArgs } from '../../src/harness/index.mjs';
import { buildConfig as opencodeConfig } from '../../src/harness/opencode.mjs';
import { buildConfig as codexConfig } from '../../src/harness/codex.mjs';
import { toolList } from '../../src/harness/pi.mjs';
import { modelRouting } from '../../src/harness/claw.mjs';
import { resolveEndpoint } from '../../src/harness/providers.mjs';

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

for (const id of ['opencode', 'codex', 'pi', 'claw']) {
  test(`${id}: tool run is parsed into the normalised model`, () => {
    const { acc, events } = replay(id, `${id}-tools.jsonl`);
    assert.match(acc.finalText, /ECHO_DONE/);
    assert.equal(acc.tools, 2, `${id} tool calls: ${acc.toolCalls}`);
    assert.ok(acc.toolCalls.some((n) => /report_finding/.test(n)));
    assert.ok(acc.inputTokens > 0);
    assert.equal(acc.errors.length, 0);
    if (id !== 'claw') assert.ok(acc.sessionId);
    assert.ok(events.some((e) => e.t === 'tool_result'));
  });

  test(`${id}: provider failure surfaces as an error`, () => {
    const { acc } = replay(id, `${id}-error.jsonl`);
    assert.ok(acc.errors.length >= 1, `${id} errors`);
    assert.match(acc.errors.at(-1), /401|auth|Unauthorized/i);
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

test('opencode config: permissions, MCP, custom provider, harness_config merge', () => {
  const cfg = opencodeConfig({
    model: { provider: 'mock', id: 'm1' },
    endpoint: resolveEndpoint({ provider: 'mock', baseUrl: 'http://x/v1', apiKeyEnv: 'K' }),
    perms: permissionProfile('edit', ['npm test*']),
    mcpServers: { harness: { command: 'node', args: ['s.mjs'], env: { A: '1' } }, docs: { url: 'https://d/mcp' } },
    harnessConfig: { permission: { webfetch: 'allow' } },
  });
  assert.deepEqual(cfg.permission.bash, { '*': 'deny', 'npm test*': 'allow' });
  assert.equal(cfg.permission.edit, 'allow');
  assert.equal(cfg.permission.webfetch, 'allow');
  assert.deepEqual(cfg.mcp.harness.command, ['node', 's.mjs']);
  assert.equal(cfg.mcp.docs.type, 'remote');
  assert.equal(cfg.provider.mock.options.apiKey, '{env:K}');
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

test('claw model routing', () => {
  assert.equal(modelRouting({ model: { provider: 'anthropic', id: 'claude-sonnet-5-5' }, endpoint: resolveEndpoint({ provider: 'anthropic' }) }).modelArg, 'claude-sonnet-5-5');
  const or = modelRouting({ model: { provider: 'openrouter', id: 'qwen/qwen3-coder' }, endpoint: resolveEndpoint({ provider: 'openrouter' }) });
  assert.equal(or.modelArg, 'openai/qwen/qwen3-coder');
  assert.equal(or.env.OPENAI_BASE_URL, 'https://openrouter.ai/api/v1');
  assert.equal(or.env.OPENAI_API_KEY, '$env:OPENROUTER_API_KEY');
});

test('splitArgs honours quotes', () => {
  assert.deepEqual(splitArgs(`--a 1 --b "two words" --c ''`), ['--a', '1', '--b', 'two words', '--c', '']);
});
