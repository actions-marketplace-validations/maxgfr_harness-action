import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitHubMock } from '../mock-github/server.mjs';
import { createClient } from '../../src/github/api.mjs';
import { restoreSessionArtifact } from '../../src/github/session-store.mjs';
import { resolveHarness, permissionProfile } from '../../src/harness/index.mjs';
import { buildConfig as oc2Config, permissionRules, mcpReady } from '../../src/harness/opencode2.mjs';
import { resolveEndpoint } from '../../src/harness/providers.mjs';
import { readInputs, loopSettings, sessionThread, sessionCachePrefix } from '../../src/inputs.mjs';
import { feedbackPrompt, TURN_MARKER, runCheck } from '../../src/stages/run.mjs';
import { previousReply } from '../../src/stages/prepare.mjs';
import { buildFollowupPrompt, buildPrompt } from '../../src/prompt.mjs';
import { loopLine, finalBody } from '../../src/publish/render.mjs';
import { stepIndex } from '../mock-llm/server.mjs';

const inputs = (over = {}) => readInputs(Object.fromEntries(Object.entries({ model: 'a/b', ...over }).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])));

test('opencode resolves to OpenCode 2 unless a 1.x version is asked for', () => {
  assert.equal(resolveHarness('opencode').adapterId, 'opencode');
  assert.equal(resolveHarness('opencode').meta.package, '@opencode/cli');
  assert.equal(resolveHarness('opencode', '1').adapterId, 'opencode-v1');
  assert.equal(resolveHarness('opencode', '1').version, '1.19.5');
  assert.equal(resolveHarness('opencode', '1.18.0').version, '1.18.0');
  assert.equal(resolveHarness('opencode', '2.3.0').adapterId, 'opencode');
  assert.equal(resolveHarness('pi').meta.package, '@earendil-works/pi-coding-agent');
  assert.throws(() => resolveHarness('opencode-v1'), /Unknown harness/);
});

test('OpenCode 2 config: ordered permissions, mcp.servers without code mode, custom provider', () => {
  const rules = permissionRules(permissionProfile('edit', ['npm test *']));
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'allow' });
  assert.ok(rules.some((r) => r.action === 'question' && r.effect === 'deny'));
  const shell = rules.filter((r) => r.action === 'shell');
  assert.deepEqual(shell.map((r) => [r.resource, r.effect]), [['*', 'deny'], ['npm test *', 'allow']]); // last match wins
  assert.ok(!rules.some((r) => r.action === 'edit' && r.effect === 'deny'));
  assert.ok(permissionRules(permissionProfile('read-only')).some((r) => r.action === 'edit' && r.effect === 'deny'));
  const cfg = oc2Config({
    model: { provider: 'mock', id: 'm' },
    endpoint: resolveEndpoint({ provider: 'mock', baseUrl: 'http://x/v1', apiKeyEnv: 'K' }),
    perms: permissionProfile('full'),
    mcpServers: { harness: { command: 'node', args: ['s.mjs'], env: { A: '1' } }, docs: { url: 'https://d' } },
  });
  assert.deepEqual(cfg.mcp.servers.harness, { type: 'local', command: ['node', 's.mjs'], environment: { A: '1' }, codemode: false });
  assert.equal(cfg.mcp.servers.docs.type, 'remote');
  assert.deepEqual(cfg.providers.mock.env, ['K']);
  assert.equal(cfg.providers.mock.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(cfg.update, 'disable');
});

test('OpenCode 2 `mcp list` readiness', () => {
  assert.equal(mcpReady('No MCP servers configured', ['harness']), false);
  assert.equal(mcpReady('✓ harness  connected\n', ['harness']), true);
  assert.equal(mcpReady('✓ harness  connected\n… docs  connecting', ['harness', 'docs']), false);
  assert.equal(mcpReady('✓ harness  connected\n✗ docs  failed: boom', ['harness', 'docs']), true);
});

test('loop settings', () => {
  assert.deepEqual(loopSettings(inputs()), { maxIterations: 1, until: '' });
  assert.deepEqual(loopSettings(inputs({ loop_until: 'npm test' })), { maxIterations: 5, until: 'npm test' });
  assert.deepEqual(loopSettings(inputs({ max_iterations: '3' })), { maxIterations: 3, until: '' });
});

test('conversation key', () => {
  const issue = { number: 7, isPR: false };
  assert.equal(sessionThread(inputs(), issue, 'tag'), 'issue-7');
  assert.equal(sessionThread(inputs(), { number: 9, isPR: true }, 'tag'), 'pr-9');
  assert.equal(sessionThread(inputs(), issue, 'automation'), null);
  assert.equal(sessionThread(inputs({ session: 'on' }), issue, 'automation'), 'issue-7');
  assert.equal(sessionThread(inputs({ session: 'off' }), issue, 'tag'), null);
  assert.equal(sessionThread(inputs({ session_key: 'my chat/1' }), {}, 'automation'), 'my-chat-1');
  assert.equal(sessionCachePrefix('pi', 'pr-9'), 'harness-session-v1-pi-pr-9-');
  assert.equal(sessionThread(inputs({ open_pr: 'true' }), { runId: '55' }, 'automation'), 'run-55');
  assert.equal(sessionThread(inputs(), { runId: '55' }, 'automation'), null);
});

test('feedback prompts', () => {
  const check = feedbackPrompt({ check: { command: 'npm test', code: 1, output: 'FAIL x' }, iteration: 2, max: 5, resumable: true });
  assert.ok(check.startsWith(TURN_MARKER));
  assert.match(check, /npm test.*exit code 1/);
  assert.match(check, /FAIL x/);
  assert.doesNotMatch(check, /Previous attempt/);
  const fresh = feedbackPrompt({ iteration: 2, max: 3, resumable: false, original: 'ORIGINAL TASK', previousText: 'did half' });
  assert.match(fresh, /ORIGINAL TASK/);
  assert.match(fresh, /did half/);
  assert.match(fresh, /task_complete/);
});

test('completion check runner', async () => {
  assert.equal((await runCheck('true', { cwd: process.cwd(), env: process.env })).code, 0);
  const r = await runCheck('echo boom; exit 3', { cwd: process.cwd(), env: process.env });
  assert.equal(r.code, 3);
  assert.match(r.output, /boom/);
});

test('earlier replies are part of the conversation, reduced to their text', () => {
  const body = '<!-- harness-action:tracking -->\n✅ **pi** finished · [View job run](u)\n\n---\n\nI fixed it.\n\n<sub>**pi** · `m` · 3s</sub>';
  const r = previousReply(body);
  assert.doesNotMatch(r, /harness-action:tracking|<sub>/);
  assert.match(r, /I fixed it\./);
});

test('follow-up prompt of a resumed session is short and carries the new request', () => {
  const p = { harness: 'codex', mode: 'tag', ctx: { eventName: 'issue_comment', action: 'created', actor: 'alice', repoFull: 'o/r' }, request: 'now add tests', isPR: true, perms: { level: 'edit', bash: 'none', edit: true }, loop: { maxIterations: 1 } };
  const f = buildFollowupPrompt(p);
  assert.match(f, /now add tests/);
  assert.ok(f.length < buildPrompt({ ...p, skills: [] }).length);
  assert.match(buildPrompt({ ...p, loop: { maxIterations: 4, until: 'npm test' } }), /runs `npm test`/);
  assert.match(buildPrompt({ ...p, loop: { maxIterations: 4, until: '' } }), /task_complete/);
});

test('loop and session lines in the reply', () => {
  assert.equal(loopLine({ iterations: [{}], loopResult: 'single' }), '');
  assert.match(loopLine({ iterations: [{}, {}], loopResult: 'passed', loopUntil: 'npm test' }), /2 iterations · `npm test` passed/);
  assert.match(loopLine({ resumed: true, iterations: [{}], loopResult: 'single' }), /continued the conversation/);
  const body = finalBody({ harness: 'pi', model: 'm', runUrl: 'u', run: { resumed: true, iterations: [{}], loopResult: 'single', durationMs: 1, tools: 0 }, status: 'success', finalText: 'ok', branch: { name: 'b', url: 'bu', created: true, pullUrl: 'pu', pullNumber: 21 } });
  assert.match(body, /Pull request #21/);
  assert.match(body, /continued the conversation/);
});

test('a conversation is restored from the newest artifact of its name', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-art-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  const zipOf = (content, name) => {
    fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ sessionId: content }));
    const file = path.join(tmp, name);
    execFileSync('zip', ['-r', '-q', file, '.'], { cwd: src });
    return fs.readFileSync(file);
  };
  const gh = createGitHubMock();
  gh.addArtifact('harness-session-v1-pi-issue-7', zipOf('old', 'a.zip'));
  gh.addArtifact('harness-session-v1-pi-issue-7', zipOf('new', 'b.zip'));
  gh.addArtifact('harness-session-v1-pi-issue-8', zipOf('other', 'c.zip'));
  const port = await new Promise((r) => gh.server.listen(0, '127.0.0.1', () => r(gh.server.address().port)));
  const github = createClient({ token: 't', apiUrl: `http://127.0.0.1:${port}` });
  const dir = path.join(tmp, 'restored');
  const hit = await restoreSessionArtifact({ github, owner: 'acme', repo: 'demo', name: 'harness-session-v1-pi-issue-7', dir, tmpDir: tmp });
  assert.equal(hit.restored, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).sessionId, 'new');
  const miss = await restoreSessionArtifact({ github, owner: 'acme', repo: 'demo', name: 'harness-session-v1-pi-issue-99', dir: path.join(tmp, 'none'), tmpDir: tmp });
  assert.equal(miss.restored, false);
  assert.match(miss.reason, /no saved conversation/);
  gh.server.close();
});

test('mock LLM counts turns across loop iterations and resumed sessions', () => {
  const user = (t) => ({ role: 'user', content: t });
  assert.equal(stepIndex('chat', { messages: [user(`${TURN_MARKER} hi`)] }), 0);
  assert.equal(stepIndex('chat', { messages: [user(`${TURN_MARKER} hi`), { role: 'assistant', content: 'x' }, user(`${TURN_MARKER} again`)] }), 1);
  assert.equal(stepIndex('chat', { messages: [user(`${TURN_MARKER}\nrestated ${TURN_MARKER} task`)] }), 1); // non-resumable restatement
  assert.equal(stepIndex('responses', { input: [{ role: 'user', content: [{ type: 'input_text', text: `${TURN_MARKER} a` }] }, { type: 'function_call' }, { type: 'function_call_output' }] }), 1);
});
