#!/usr/bin/env node
// Keyless end-to-end test: the real harness binaries, a scripted mock LLM and a mock GitHub API,
// driven through the exact steps of action.yml (resolve → prepare → run → publish).
//
//   node test/e2e/run.mjs [--harness opencode,codex,pi,openclaw] [--scenario issue-tag,pr-automation,conversation-loop,sandbox]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMockServer } from '../mock-llm/server.mjs';
import { createGitHubMock } from '../mock-github/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const HARNESSES = arg('harness', 'opencode,codex,pi,openclaw').split(',');
const SCENARIOS = arg('scenario', 'issue-tag,pr-automation,conversation-loop,sandbox').split(',');
const TOOLS_DIR = process.env.HARNESS_TOOLS_DIR || path.join(ROOT, '.harness', 'tools');

function harnessInputs(h) {
  return { harness: h };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const readOutputs = (file) => {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  const re = /^([\w-]+)<<(ghadelim_[\w-]+)\n([\s\S]*?)\n\2$/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3];
  return out;
};

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n\nHello.\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  // what actions/checkout v7 leaves behind: credentials in an includeIf'd file
  const cred = path.join(dir, '..', 'checkout-cred.config');
  fs.writeFileSync(cred, '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n');
  g('config', '--local', `includeIf.gitdir:${dir}/.git.path`, cred);
  return { sha: g('rev-parse', 'HEAD').trim(), cred };
}

const SCRIPTS = {
  'issue-tag': [
    { tool: 'update_progress', args: { markdown: '- [x] read the request\n- [ ] write ECHO.md' } },
    { tool: 'report_finding', args: { file: 'README.md', line: 1, severity: 'warning', message: 'echo-check ran' } },
    // ECHO.md, plus a workflow file the job token is not allowed to commit
    { shell: "printf 'echo-check ran\\n' > ECHO.md && mkdir -p .github/workflows && printf 'on: push\\n' > .github/workflows/agent.yml" },
    { text: 'ECHO_DONE — I created ECHO.md.' },
  ],
  'pr-automation': [
    { tool: 'update_progress', args: { markdown: '- [x] reviewed the diff' } },
    { tool: 'report_finding', args: { file: 'README.md', line: 3, severity: 'warning', message: 'echo-check ran' } },
    { tool: 'add_inline_comment', args: { path: 'README.md', line: 3, body: 'Consider a longer greeting.' } },
    { tool: 'add_inline_comment', args: { path: 'README.md', line: 99, body: 'outside the diff' } },
    { tool: 'submit_structured_output', args: { verdict: 'fail', score: 3 } },
    { text: 'ECHO_DONE — review complete.' },
  ],
};

async function scenario(harness, name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ha-e2e-${harness}-`));
  const workspace = path.join(tmp, 'workspace');
  const { sha, cred } = makeRepo(workspace);
  const llm = createMockServer({ steps: SCRIPTS[name], log: path.join(tmp, 'llm.jsonl') });
  const llmPort = await listen(llm);

  const isPR = name === 'pr-automation';
  const pr = { number: 12, title: 'Improve readme', body: 'Please review', html_url: 'https://github.com/acme/demo/pull/12', user: { login: 'alice' }, state: 'open', head: { ref: 'feature', sha, repo: { full_name: 'acme/demo' } }, base: { ref: 'main', sha, repo: { full_name: 'acme/demo' } } };
  const issue = { number: 7, title: 'Add an echo file', body: 'We need ECHO.md', html_url: 'https://github.com/acme/demo/issues/7', user: { login: 'alice' }, state: 'open' };
  const diff = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n # demo\n \n+Hello.\n';
  const gh = createGitHubMock({ pr: isPR ? pr : null, issue, diff });
  const ghPort = await listen(gh.server);

  const event = isPR
    ? { action: 'opened', pull_request: pr, sender: { login: 'alice', id: 1, type: 'User' }, repository: { default_branch: 'main' } }
    : { action: 'created', issue, comment: { id: 555, body: '@harness please run the echo check', user: { login: 'alice' } }, sender: { login: 'alice', id: 1, type: 'User' }, repository: { default_branch: 'main' } };
  fs.writeFileSync(path.join(tmp, 'event.json'), JSON.stringify(event));

  const inputs = {
    harness,
    model: 'mock/mock-model',
    base_url: `http://127.0.0.1:${llmPort}/v1`,
    api_key_env: 'MOCK_API_KEY',
    github_token: 'ghs_mocktoken',
    skills: path.join(ROOT, 'test', 'fixtures', 'skills'),
    skill: 'echo-check',
    tools: isPR ? 'read-only' : 'full',
    prompt: isPR ? 'Run the echo check on this pull request.' : '',
    post_comment: isPR ? 'true' : 'false',
    fail_on: isPR ? 'warning' : '',
    sarif: 'true',
    timeout_minutes: '5',
    json_schema: isPR ? JSON.stringify({ type: 'object', required: ['verdict'], properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, score: { type: 'integer' } } }) : '',
    ...harnessInputs(harness),
  };
  const outputFile = path.join(tmp, 'output.txt');
  const summaryFile = path.join(tmp, 'summary.md');
  const baseEnv = {
    ...process.env,
    GITHUB_EVENT_NAME: isPR ? 'pull_request' : 'issue_comment',
    GITHUB_EVENT_PATH: path.join(tmp, 'event.json'),
    GITHUB_REPOSITORY: 'acme/demo',
    GITHUB_API_URL: `http://127.0.0.1:${ghPort}`,
    GITHUB_GRAPHQL_URL: `http://127.0.0.1:${ghPort}/graphql`,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKSPACE: workspace,
    GITHUB_RUN_ID: '42',
    GITHUB_ACTOR: 'alice',
    GITHUB_SHA: sha,
    GITHUB_JOB: 'e2e',
    RUNNER_TEMP: tmp,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    HARNESS_TOOLS_DIR: TOOLS_DIR,
    MOCK_API_KEY: 'mock-key',
  };
  // Async on purpose: the mock servers live in this process and must keep serving.
  const step = (cmd, env) => new Promise((resolve) => {
    fs.writeFileSync(outputFile, '');
    const child = spawn(process.execPath, [CLI, cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out, outputs: readOutputs(outputFile) }));
  });

  const log = [];
  const resolve = await step('resolve', { ...baseEnv, HARNESS_INPUTS: JSON.stringify(inputs) });
  const stateDir = resolve.outputs.state_dir;
  const prep = await step('prepare', { ...baseEnv, HARNESS_INPUTS: JSON.stringify(inputs), HARNESS_STATE_DIR: stateDir });
  log.push(prep.out);
  let runRes = { code: null, out: '' };
  if (prep.outputs.run === 'true') {
    const credDuringRun = fs.readFileSync(cred, 'utf8');
    runRes = await step('run', { ...baseEnv, HARNESS_STATE_DIR: stateDir });
    log.push(runRes.out);
    runRes.credStripped = !credDuringRun.includes('extraheader');
  }
  const pub = await step('publish', { ...baseEnv, HARNESS_INPUTS: JSON.stringify(inputs), HARNESS_STATE_DIR: stateDir });
  log.push(pub.out);
  llm.close();
  gh.server.close();

  const comments = [...gh.comments.values()].map((c) => c.body);
  const graphql = gh.calls.find((c) => c.path === '/graphql');
  const review = gh.calls.find((c) => /\/reviews$/.test(c.path));
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const findings = readJson(path.join(stateDir, 'report', 'findings.json'), []);
  const runJson = readJson(path.join(stateDir, 'run.json'), {});
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '';
  const tokenLeak = fs.existsSync(path.join(stateDir, 'plan.json')) && fs.readFileSync(path.join(stateDir, 'plan.json'), 'utf8').includes('ghs_mocktoken');

  const checks = [
    ['prepare ran', prep.code === 0 && prep.outputs.run === 'true'],
    ['run succeeded', runJson.status === 'success'],
    ['final text', /ECHO_DONE/.test(runJson.finalText ?? '')],
    ['finding collected', findings.length === 1 && findings[0].message === 'echo-check ran'],
    ['credentials stripped during run', runRes.credStripped === true],
    ['credentials restored after', fs.readFileSync(cred, 'utf8').includes('extraheader')],
    ['token absent from plan', !tokenLeak],
    ['summary written', /ECHO_DONE/.test(summary)],
    ['comment updated with result', comments.some((b) => /ECHO_DONE/.test(b))],
    ['progress in comment', comments.some((b) => /reviewed the diff|read the request/.test(b))],
  ];
  if (name === 'issue-tag') {
    checks.push(
      ['eyes reaction', gh.calls.some((c) => /reactions$/.test(c.path))],
      ['branch created', gh.calls.some((c) => c.path.endsWith('/git/refs') && /refs\/heads\/harness\/issue-7-/.test(c.body?.ref))],
      ['signed commit with ECHO.md, without the workflow file', (() => {
        const commits = gh.calls.filter((c) => c.path === '/graphql').map((c) => c.body?.variables?.input?.fileChanges?.additions?.map((a) => a.path) ?? []);
        const last = commits.at(-1) ?? [];
        return commits.length === 2 && commits[0].includes('.github/workflows/agent.yml') && last.includes('ECHO.md') && !last.includes('.github/workflows/agent.yml');
      })()],
      // nothing a harness writes for itself in the working directory (state, bootstrap files)
      ['only the files the agent changed are committed', (() => {
        const last = gh.calls.filter((c) => c.path === '/graphql').at(-1)?.body?.variables?.input?.fileChanges?.additions?.map((a) => a.path) ?? [];
        if (last.length !== 1) console.log(`   (committed: ${last.join(', ')})`);
        return last.length === 1 && last[0] === 'ECHO.md';
      })()],
      ['workflow file reported as not committed', comments.some((b) => /Not committed[\s\S]*agent\.yml/.test(b))],
      ['create-PR link', comments.some((b) => /quick_pull=1/.test(b))],
      ['publish green', pub.code === 0],
    );
  } else {
    checks.push(
      ['no commit in read-only', !graphql],
      ['review with 1 inline comment', review?.body?.comments?.length === 1 && review.body.comments[0].line === 3],
      ['outside-diff comment listed', comments.some((b) => /outside the diff/.test(b))],
      ['fail_on gate failed the job', pub.code === 1],
      ['sarif written', fs.existsSync(path.join(stateDir, 'report', 'results.sarif'))],
      ['structured output validated', pub.outputs.structured_output && JSON.parse(pub.outputs.structured_output).verdict === 'fail'],
    );
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${failed.length ? '✗' : '✓'} ${harness} / ${name}`);
  for (const [label, ok] of checks) console.log(`   ${ok ? '✓' : '✗'} ${label}`);
  if (failed.length) {
    console.log('----- logs -----');
    console.log(log.join('\n').split('\n').slice(-80).join('\n'));
    console.log(`(state: ${stateDir})`);
  } else {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return failed.length === 0;
}

// ---------------------------------------------------------------------------------------------
// conversation-loop: two runs of the action on one conversation.
//   run 1 — `@harness` on issue #7, loop_until `test -f DONE.md`, open_pr: turn 1 answers without
//           doing the work, the check fails, turn 2 (same session, fed the check output) creates
//           DONE.md, the check passes, PR #21 is opened, the session is saved under pr-21;
//   run 2 — `@harness` on PR #21: the session is resumed (the mock refuses to answer unless the
//           history it receives contains run 1's last message).
// ---------------------------------------------------------------------------------------------
const CONVERSATION_SCRIPT = [
  { text: 'FIRST_TURN — not done yet.' },
  { shell: 'touch DONE.md' },
  { text: 'FIRST_DONE — DONE.md exists now.' },
  { text: 'SECOND_WITH_MEMORY — I remember the first run.', expectHistory: 'FIRST_DONE' },
];

async function conversationLoop(harness) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ha-e2e-conv-${harness}-`));
  const workspace = path.join(tmp, 'workspace');
  const { sha } = makeRepo(workspace);
  const llm = createMockServer({ steps: CONVERSATION_SCRIPT, log: path.join(tmp, 'llm.jsonl') });
  const llmPort = await listen(llm);
  const issue = { number: 7, title: 'Create DONE.md', body: 'We need DONE.md', html_url: 'https://github.com/acme/demo/issues/7', user: { login: 'alice' }, state: 'open' };
  const pr = { number: 21, title: 'Create DONE.md', body: 'opened by harness', html_url: 'https://github.com/acme/demo/pull/21', user: { login: 'harness[bot]' }, state: 'open', head: { ref: 'harness/issue-7', sha, repo: { full_name: 'acme/demo' } }, base: { ref: 'main', sha, repo: { full_name: 'acme/demo' } } };
  const gh = createGitHubMock({ pr, issue, diff: 'diff --git a/DONE.md b/DONE.md\n--- /dev/null\n+++ b/DONE.md\n@@ -0,0 +1 @@\n+\n' });
  const ghPort = await listen(gh.server);
  const outputFile = path.join(tmp, 'output.txt');
  const inputs = {
    harness,
    model: 'mock/mock-model',
    base_url: `http://127.0.0.1:${llmPort}/v1`,
    api_key_env: 'MOCK_API_KEY',
    github_token: 'ghs_mocktoken',
    tools: 'full',
    loop_until: 'test -f DONE.md',
    max_iterations: '3',
    open_pr: 'true',
    timeout_minutes: '5',
    ...harnessInputs(harness),
  };
  const envFor = (event, eventName) => {
    const file = path.join(tmp, `event-${eventName}.json`);
    fs.writeFileSync(file, JSON.stringify(event));
    return {
      ...process.env,
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_EVENT_PATH: file,
      GITHUB_REPOSITORY: 'acme/demo',
      GITHUB_API_URL: `http://127.0.0.1:${ghPort}`,
      GITHUB_GRAPHQL_URL: `http://127.0.0.1:${ghPort}/graphql`,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_WORKSPACE: workspace,
      GITHUB_RUN_ID: eventName === 'first' ? '100' : '101',
      GITHUB_ACTOR: 'alice',
      GITHUB_SHA: sha,
      GITHUB_JOB: 'e2e',
      RUNNER_TEMP: tmp,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'),
      HARNESS_TOOLS_DIR: TOOLS_DIR,
      MOCK_API_KEY: 'mock-key',
    };
  };
  const step = (cmd, env) => new Promise((resolve) => {
    fs.writeFileSync(outputFile, '');
    const child = spawn(process.execPath, [CLI, cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out, outputs: readOutputs(outputFile) }));
  });
  const actionRun = async (env, { keepSession = false } = {}) => {
    const withInputs = { ...env, HARNESS_INPUTS: JSON.stringify(inputs), ...(keepSession ? { HARNESS_SESSION_KEEP: '1' } : {}) };
    const resolve = await step('resolve', withInputs);
    const stateDir = resolve.outputs.state_dir;
    const prep = await step('prepare', { ...withInputs, HARNESS_STATE_DIR: stateDir });
    const runRes = prep.outputs.run === 'true' ? await step('run', { ...env, HARNESS_STATE_DIR: stateDir }) : { out: '' };
    const pub = await step('publish', { ...withInputs, HARNESS_STATE_DIR: stateDir });
    let runJson = {};
    try { runJson = JSON.parse(fs.readFileSync(path.join(stateDir, 'run.json'), 'utf8')); } catch {}
    return { prep, pub, runJson, log: [prep.out, runRes.out, pub.out].join('\n'), stateDir };
  };

  const sender = { login: 'alice', id: 1, type: 'User' };
  const first = await actionRun(envFor({ action: 'created', issue, comment: { id: 601, body: '@harness create DONE.md', user: { login: 'alice' } }, sender, repository: { default_branch: 'main' } }, 'first'));
  const prCall = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'));
  const checks = [
    ['run 1: loop ran 2 iterations', first.runJson.iterations?.length === 2],
    ['run 1: completion check passed', first.runJson.loopResult === 'passed'],
    ['run 1: final text', /FIRST_DONE/.test(first.runJson.finalText ?? '')],
    ['run 1: DONE.md committed', gh.calls.some((c) => c.path === '/graphql' && c.body?.variables?.input?.fileChanges?.additions?.some((a) => a.path === 'DONE.md'))],
    ['run 1: pull request opened with the reply', /FIRST_DONE/.test(prCall?.body?.body ?? '') && /Closes #7/.test(prCall?.body?.body ?? '')],
    ['run 1: comment links the PR', [...gh.comments.values()].some((c) => /Pull request #21/.test(c.body ?? ''))],
    ['run 1: publish green', first.pub.code === 0],
  ];
  let second = null;
  {
    // What action.yml's upload-artifact step does: zip the session dir under the given name. Then
    // the dir is wiped, so run 2 can only resume through the artifact API.
    const artifactName = first.pub.outputs.session_artifact ?? '';
    const sessionDir = first.pub.outputs.session_dir;
    checks.push(['run 1: conversation saved under the PR', /^harness-session-v1-.*-pr-21$/.test(artifactName) && fs.existsSync(path.join(sessionDir ?? '', 'meta.json'))]);
    if (artifactName && sessionDir) {
      const zip = path.join(tmp, 'session.zip');
      execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: sessionDir });
      gh.addArtifact(artifactName, fs.readFileSync(zip));
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    second = await actionRun(envFor({ action: 'created', issue: { ...issue, number: 21, title: pr.title, pull_request: { url: 'x' } }, comment: { id: 602, body: '@harness are you still there?', user: { login: 'alice' } }, sender, repository: { default_branch: 'main' } }, 'second'));
    checks.push(
      ['run 2: session resumed', second.runJson.resumed === true],
      ['run 2: the history carried run 1', /SECOND_WITH_MEMORY/.test(second.runJson.finalText ?? '')],
      ['run 2: reply says it continued', [...gh.comments.values()].some((c) => /continued the conversation/.test(c.body ?? ''))],
    );
  }
  llm.close();
  gh.server.close();
  const failed = checks.filter(([, okc]) => !okc);
  console.log(`\n${failed.length ? '✗' : '✓'} ${harness} / conversation-loop`);
  for (const [label, okc] of checks) console.log(`   ${okc ? '✓' : '✗'} ${label}`);
  if (failed.length) {
    console.log('----- logs -----');
    console.log([first.log, second?.log ?? ''].join('\n').split('\n').slice(-90).join('\n'));
    console.log(`(tmp: ${tmp})`);
  } else {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return failed.length === 0;
}

// ---------------------------------------------------------------------------------------------
// sandbox: the agent (tools: full) tries to reach the steps that hold the token. Where the
// runner can give it its own user (Linux, passwordless sudo) every attempt must fail; elsewhere
// the scenario is skipped.
// ---------------------------------------------------------------------------------------------
async function sandboxScenario(harness) {
  const { sandboxSupport } = await import(path.join(ROOT, 'src', 'sandbox.mjs'));
  const support = sandboxSupport();
  if (!support.ok) { console.log(`\n- ${harness} / sandbox: skipped (${support.reason})`); return true; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ha-e2e-sandbox-${harness}-`));
  const workspace = path.join(tmp, 'workspace');
  const { sha, cred } = makeRepo(workspace);
  const probe = path.join(ROOT, 'src', '.sandbox-probe'); // the action's own sources
  const stolen = path.join(tmp, 'stolen.txt');
  // The attack is the completion check: code the agent influences, run after its turn. (Codex
  // would refuse to run it from its own shell tool.)
  const attackFile = path.join(tmp, 'attack.sh');
  const llm = createMockServer({ steps: [{ shell: "printf 'sandboxed\\n' > ECHO.md" }, { text: 'ECHO_DONE — done.' }], log: path.join(tmp, 'llm.jsonl') });
  const llmPort = await listen(llm);
  const issue = { number: 7, title: 'Sandbox', body: 'b', html_url: 'https://github.com/acme/demo/issues/7', user: { login: 'alice' }, state: 'open' };
  const gh = createGitHubMock({ issue });
  const ghPort = await listen(gh.server);
  fs.writeFileSync(path.join(tmp, 'event.json'), JSON.stringify({ action: 'created', issue, comment: { id: 555, body: '@harness do: create ECHO.md', user: { login: 'alice' } }, sender: { login: 'alice', id: 1, type: 'User' }, repository: { default_branch: 'main' } }));
  const inputs = { harness, model: 'mock/mock-model', base_url: `http://127.0.0.1:${llmPort}/v1`, api_key_env: 'MOCK_API_KEY', github_token: 'ghs_mocktoken', tools: 'full', timeout_minutes: '5', loop_until: `bash ${attackFile}`, max_iterations: '2' };
  const outputFile = path.join(tmp, 'output.txt');
  const baseEnv = { ...process.env, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: path.join(tmp, 'event.json'), GITHUB_REPOSITORY: 'acme/demo', GITHUB_API_URL: `http://127.0.0.1:${ghPort}`, GITHUB_GRAPHQL_URL: `http://127.0.0.1:${ghPort}/graphql`, GITHUB_SERVER_URL: 'https://github.com', GITHUB_WORKSPACE: workspace, GITHUB_RUN_ID: '42', GITHUB_ACTOR: 'alice', GITHUB_SHA: sha, GITHUB_JOB: 'e2e', RUNNER_TEMP: tmp, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'), HARNESS_TOOLS_DIR: TOOLS_DIR, MOCK_API_KEY: 'mock-key' };
  const step = (cmd, env) => new Promise((resolve) => {
    fs.writeFileSync(outputFile, '');
    const child = spawn(process.execPath, [CLI, cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out, outputs: readOutputs(outputFile) }));
  });
  const withInputs = { ...baseEnv, HARNESS_INPUTS: JSON.stringify(inputs) };
  const resolveRes = await step('resolve', withInputs);
  const stateDir = resolveRes.outputs.state_dir;
  fs.writeFileSync(attackFile, [
    `touch ${probe}`,
    `printf tampered > ${path.join(stateDir, 'context.json')}`,
    `rm -f ${path.join(stateDir, 'plan.json')}`,
    `cat ${cred} > ${stolen}`,
    // left behind, to read the credentials once Publish has put them back
    `(setsid sh -c 'sleep 20; cat ${cred} > ${stolen}' > /dev/null 2>&1 &)`,
  ].map((c) => `${c} 2>/dev/null`).join('\n') + '\nexit 0\n');
  const prep = await step('prepare', { ...withInputs, HARNESS_STATE_DIR: stateDir });
  const before = fs.readFileSync(path.join(stateDir, 'context.json'), 'utf8');
  const runRes = await step('run', { ...baseEnv, HARNESS_STATE_DIR: stateDir });
  const agentAlive = spawnSync('pgrep', ['-u', 'harness-agent']).status === 0;
  const contextKept = fs.readFileSync(path.join(stateDir, 'context.json'), 'utf8') === before && fs.existsSync(path.join(stateDir, 'plan.json'));
  const pub = await step('publish', { ...withInputs, HARNESS_STATE_DIR: stateDir });
  llm.close();
  gh.server.close();
  let runJson = {};
  try { runJson = JSON.parse(fs.readFileSync(path.join(stateDir, 'run.json'), 'utf8')); } catch {}
  const commits = gh.calls.filter((c) => c.path === '/graphql').map((c) => c.body?.variables?.input?.fileChanges?.additions?.map((a) => a.path) ?? []);
  const ownedByRunner = (f) => fs.statSync(f).uid === process.getuid();
  const checks = [
    ['the agent ran as its own user', /runs as harness-agent/.test(prep.out)],
    ['run succeeded', runJson.status === 'success'],
    ["the action's sources could not be written", !fs.existsSync(probe)],
    ['context.json and plan.json could not be replaced', contextKept],
    ['the credentials could not be read', !fs.existsSync(stolen) || !fs.readFileSync(stolen, 'utf8').includes('extraheader')],
    ['no agent process outlived the run step', !agentAlive],
    ['the agent still did its work', commits.at(-1)?.includes('ECHO.md')],
    ['its files are the runner\'s again', fs.existsSync(path.join(workspace, 'ECHO.md')) && ownedByRunner(path.join(workspace, 'ECHO.md')) && ownedByRunner(stateDir)],
    ['publish green', pub.code === 0],
  ];
  fs.rmSync(probe, { force: true });
  const failed = checks.filter(([, okc]) => !okc);
  console.log(`\n${failed.length ? '✗' : '✓'} ${harness} / sandbox`);
  for (const [label, okc] of checks) console.log(`   ${okc ? '✓' : '✗'} ${label}`);
  if (failed.length) {
    console.log('----- logs -----');
    console.log([prep.out, runRes.out, pub.out].join('\n').split('\n').slice(-80).join('\n'));
    console.log(`(tmp: ${tmp})`);
  } else {
    spawnSync('sudo', ['-n', 'rm', '-rf', tmp]);
  }
  return failed.length === 0;
}

let ok = true;
for (const h of HARNESSES) {
  for (const s of SCENARIOS) ok = (s === 'conversation-loop' ? await conversationLoop(h) : s === 'sandbox' ? await sandboxScenario(h) : await scenario(h, s)) && ok;
}
process.exit(ok ? 0 : 1);
