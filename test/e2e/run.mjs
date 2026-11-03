#!/usr/bin/env node
// Keyless end-to-end test: the real harness binaries, a scripted mock LLM and a mock GitHub API,
// driven through the exact steps of action.yml (resolve → prepare → run → publish).
//
//   node test/e2e/run.mjs [--harness opencode,codex,pi,claw] [--scenario issue-tag,pr-automation]
//   CLAW_BIN=/path/to/claw  uses a prebuilt claw instead of building it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMockServer } from '../mock-llm/server.mjs';
import { createGitHubMock } from '../mock-github/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const HARNESSES = arg('harness', 'opencode,codex,pi,claw').split(',');
const SCENARIOS = arg('scenario', 'issue-tag,pr-automation').split(',');
const TOOLS_DIR = process.env.HARNESS_TOOLS_DIR || path.join(ROOT, '.harness', 'tools');

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
    { shell: "printf 'echo-check ran\\n' > ECHO.md" },
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
    harness_version: harness === 'claw' && process.env.CLAW_BIN ? process.env.CLAW_BIN : '',
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
      ['signed commit with ECHO.md', graphql?.body?.variables?.input?.fileChanges?.additions?.some((a) => a.path === 'ECHO.md')],
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

let ok = true;
for (const h of HARNESSES) for (const s of SCENARIOS) ok = (await scenario(h, s)) && ok;
process.exit(ok ? 0 : 1);
