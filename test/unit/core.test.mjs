import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectMode, containsTrigger, keepCommentAuthor, checkAccess, classifyIntent } from '../../src/modes.mjs';
import { readInputs, effectiveTools, splitModel } from '../../src/inputs.mjs';
import { validate, failsGate, normalizeFinding, collect } from '../../src/contract.mjs';
import { finalBody, toSarif, findingsTable } from '../../src/publish/render.mjs';
import { toToml, deepMerge, sanitizedEnv } from '../../src/util.mjs';
import { parseSource, parseFrontmatter, discoverSkills, installSkills, cloneSource, authEnv } from '../../src/skills.mjs';
import { commentableLines } from '../../src/git.mjs';
import { branchNameFor, splitWorkflowChanges, splitInlineComments } from '../../src/stages/publish.mjs';
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
  // a PR / issue body mentioning the phrase is a request only without a prompt
  const prBody = { pull_request: { title: 't', body: 'cc @harness' } };
  assert.equal(detectMode(ctx('pull_request', 'opened', prBody), inputs()).mode, 'tag');
  assert.equal(detectMode(ctx('pull_request', 'opened', prBody), inputs({ prompt: 'review' })).mode, 'automation');
  assert.equal(detectMode(ctx('issue_comment', 'created', { comment: { body: '@harness go' } }), inputs({ prompt: 'extra' })).mode, 'tag');
});

test('tag mode intent: questions are answered, action verbs act', () => {
  const p = '@harness';
  for (const q of ['@harness why is the build slow?', '@harness what do you recommend for caching?', '@harness pourquoi ce test échoue ?', '@harness how would you fix the login bug?', '@harness est-ce que ce code est sûr ?', '@harness review this approach', '@harness explain the retry logic', '@harness do you think this is safe?', '@harness do not change anything, just explain', '@harness does this handle errors?', '@harness in src/a.mjs, why is it slow?', '@harness review and fix nothing', '@harness comment out this line']) assert.equal(classifyIntent(q, p), 'ask', q);
  for (const d of ['@harness fix the flaky test', '@harness please add a --json flag', '@harness can you implement retries?', '@harness corrige le bug de login', '@harness peux-tu ajouter des tests', '@harness run the echo check', 'Create DONE.md @harness create DONE.md', '@harness in src/a.mjs, add a flag', '@harness on line 12: remove the log', '@harness dans src/a.mjs, ajoute un test']) assert.equal(classifyIntent(d, p), 'do', d);
  assert.equal(classifyIntent('@harness do whatever you recommend', p), 'do');
  assert.equal(classifyIntent('@harness do it', p), 'do');
  assert.equal(classifyIntent('@harness do: the fix', p), 'do');
  assert.equal(classifyIntent('@harness do comment out this line', p), 'do');
  assert.equal(classifyIntent('@harness ask: fix or rewrite?', p), 'ask');
  // first word in neither list: unclear intent falls back to answering read-only
  assert.equal(classifyIntent('@harness tests are flaky', p), 'ask');
  assert.equal(classifyIntent('@harness', p), 'ask');
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
  // a pattern that is not a valid regular expression is reported, it does not throw
  assert.deepEqual(validate({ type: 'string', pattern: '^[a-z]+$' }, 'abc'), []);
  assert.match(validate({ type: 'string', pattern: '(unclosed' }, 'abc').join(), /not a valid regular expression/);
});

test('findings: an end line needs a start line', () => {
  assert.equal(normalizeFinding({ file: 'a', message: 'm', end_line: null }).endLine, undefined);
  assert.equal(normalizeFinding({ file: 'a', message: 'm', end_line: 9 }).endLine, undefined);
  assert.equal(normalizeFinding({ file: 'a', message: 'm', line: 4, end_line: 2 }).endLine, undefined);
  assert.deepEqual([normalizeFinding({ file: 'a', message: 'm', line: 4, end_line: '9' })].map((f) => [f.line, f.endLine]), [[4, 9]]);
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
  for (const base of ['.agents/skills']) assert.ok(fs.existsSync(path.join(tmp, 'home', base, 'echo-check', 'SKILL.md')));
});

test('a failed skills clone does not put the token in its error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-skill-clone-'));
  // no network: github.com is rewritten to a directory that does not exist
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, `[url "${path.join(tmp, 'nowhere')}/"]\n\tinsteadOf = https://github.com/\n`);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  const token = 'ghp_skillsTokenThatMustNotLeak';
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  // git does get the header, from its environment, and only for github.com
  const env = authEnv({ url: 'https://github.com/acme/private-skills.git' }, token);
  assert.equal(execFileSync('git', ['config', '--get', 'http.https://github.com/.extraheader'], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim(), `AUTHORIZATION: basic ${encoded}`);
  assert.deepEqual(authEnv({ url: 'https://gitlab.com/acme/skills.git' }, token), {});
  try {
    for (const ref of [null, 'v1', 'abcdef1234']) {
      let message = '';
      try { cloneSource({ url: 'https://github.com/acme/private-skills.git', ref }, path.join(tmp, `dest-${ref}`), token); } catch (err) { message = `${err.message}\n${err.stack}`; }
      assert.match(message, /Cannot fetch skills from https:\/\/github\.com\/acme\/private-skills\.git/, String(ref));
      assert.ok(!message.includes(token) && !message.includes(encoded) && !/AUTHORIZATION/i.test(message), message);
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test('a skill name cannot escape the skills directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-skill-name-'));
  const victim = path.join(tmp, 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
  const src = path.join(tmp, 'src', 'evil-skill');
  fs.mkdirSync(src, { recursive: true });
  // from <tmp>/home/.agents/skills, three levels up is <tmp>
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: ../../../victim\ndescription: d\n---\n');
  fs.writeFileSync(path.join(src, 'payload.mjs'), 'export {};\n');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  const list = installSkills({ sources: [path.join(tmp, 'src')], home: path.join(tmp, 'home'), workDir: work });
  assert.deepEqual(list.map((s) => s.name), ['evil-skill']);
  assert.deepEqual(fs.readdirSync(victim), ['keep.txt']);
  assert.ok(fs.existsSync(path.join(tmp, 'home', '.agents', 'skills', 'evil-skill', 'payload.mjs')));
  for (const name of ['..', '.', 'a/b', 'a\\b', '/abs']) {
    fs.writeFileSync(path.join(src, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    assert.equal(discoverSkills(path.join(tmp, 'src'))[0].name, 'evil-skill', name);
  }
});

test('diff → commentable lines', () => {
  const lines = commentableLines('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n');
  assert.deepEqual([...lines.get('f')], [1, 2, 3, 4]);
});

test('diff parsing: content that looks like a header, several files, deleted files', () => {
  const diff = [
    'diff --git a/notes.md b/notes.md', '--- a/notes.md', '+++ b/notes.md',
    '@@ -1,2 +1,4 @@', ' intro', '++ counter;', '+-- a comment', ' outro', // added lines `+ counter;` and `-- a comment`
    '@@ -10 +12,2 @@', ' ten', '+eleven', '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt', '--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '--- b',
    'diff --git a/new.txt b/new.txt', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+only',
  ].join('\n');
  const lines = commentableLines(diff);
  assert.deepEqual([...lines.keys()], ['notes.md', 'new.txt']);
  assert.deepEqual([...lines.get('notes.md')], [1, 2, 3, 4, 12, 13]);
  assert.deepEqual([...lines.get('new.txt')], [1]);

  const { inside, outside } = splitInlineComments([
    { path: './notes.md', line: 3, body: 'a' }, // `./` is how some agents write paths
    { path: 'notes.md', line: 13, start_line: 12, body: 'b' },
    { path: 'notes.md', line: 7, body: 'between the hunks' },
    { path: 'gone.txt', line: 1, body: 'deleted file' },
  ], lines);
  assert.deepEqual(inside.map((c) => [c.path, c.line]), [['notes.md', 3], ['notes.md', 13]]);
  assert.deepEqual(outside.map((c) => c.body), ['between the hunks', 'deleted file']);
});

test('workflow files are split from the rest of a commit', () => {
  const { kept, workflows } = splitWorkflowChanges({ additions: ['a.js', '.github/workflows/ci.yml', '.github/dependabot.yml'], deletions: ['.github/workflows/old.yml', 'b.js'], any: true });
  assert.deepEqual(workflows, ['.github/workflows/ci.yml', '.github/workflows/old.yml']);
  assert.deepEqual(kept.additions, ['a.js', '.github/dependabot.yml']);
  assert.deepEqual(kept.deletions, ['b.js']);
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
  assert.match(buildPrompt({ ...base, harness: 'pi' }), /mcp__harness__report_finding/);
  assert.match(buildPrompt({ ...base, harness: 'openclaw' }), /harness__report_finding/);
});

test('mock LLM resolves steps against each harness tool shape', () => {
  assert.equal(resolveStep({ tool: 'report_finding' }, [{ function: { name: 'harness_report_finding' } }]).call.name, 'harness_report_finding');
  assert.equal(resolveStep({ shell: 'ls' }, [{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: 'string' } } } }]).call.args.cmd, 'ls');
  assert.equal(resolveStep({ tool: 'x' }, [{ type: 'namespace', name: 'mcp__harness', tools: [{ type: 'function', name: 'x' }] }]).call.namespace, 'mcp__harness');
});

/** Runs `node src/cli.mjs resolve` like the first step of action.yml and returns its outputs. */
function runResolve(inputs, { eventName, event }) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-resolve-')));
  fs.writeFileSync(path.join(tmp, 'event.json'), JSON.stringify(event));
  const outputFile = path.join(tmp, 'output.txt');
  fs.writeFileSync(outputFile, '');
  execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), 'resolve'], {
    stdio: 'pipe',
    env: { PATH: process.env.PATH, RUNNER_TEMP: tmp, GITHUB_OUTPUT: outputFile, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: path.join(tmp, 'event.json'), GITHUB_REPOSITORY: 'acme/demo', GITHUB_RUN_ID: '42', HARNESS_INPUTS: JSON.stringify({ model: 'a/b', ...inputs }) },
  });
  const outputs = {};
  for (const m of fs.readFileSync(outputFile, 'utf8').matchAll(/^([\w-]+)<<(ghadelim_[\w-]+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
  return { outputs, tmp };
}

test('resolve says when the event will be skipped, before anything is restored from a cache', () => {
  const comment = (body) => ({ eventName: 'issue_comment', event: { action: 'created', issue: { number: 7, title: 't' }, comment: { id: 1, body } } });
  assert.equal(runResolve({}, comment('thanks!')).outputs.skip, 'true');
  assert.equal(runResolve({}, comment('@harness fix it')).outputs.skip, 'false');
  assert.equal(runResolve({ prompt: 'triage this' }, comment('thanks!')).outputs.skip, 'false');
  assert.equal(runResolve({}, { eventName: 'push', event: {} }).outputs.skip, 'true');
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

test('MCP server: an invalid structured output is refused with the reason, so the agent can correct it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-mcp-schema-'));
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } } } }));
  const call = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'submit_structured_output', arguments: args } });
  const out = await mcpSession(dir, 'line', [call(1, { verdict: 'maybe' }), call(2, {})]);
  const [wrong, missing] = out.trim().split('\n').map((l) => JSON.parse(l).result);
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /must be one of \["pass","fail"\]/);
  assert.match(missing.content[0].text, /missing required property "verdict"/);
  assert.ok(!fs.existsSync(path.join(dir, 'structured_output.json')));
  const ok = JSON.parse((await mcpSession(dir, 'line', [call(3, { verdict: 'pass' })])).trim()).result;
  assert.equal(ok.isError, undefined);
  assert.deepEqual(collect(dir).structured, { verdict: 'pass' });
});
