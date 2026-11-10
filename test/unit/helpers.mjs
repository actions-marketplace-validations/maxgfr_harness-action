// Shared fixtures of the unit tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readInputs } from '../../src/inputs.mjs';

/** The action inputs, as `readInputs` parses them from INPUT_* variables. */
export const inputs = (over = {}) => readInputs(Object.fromEntries(Object.entries({ model: 'a/b', ...over }).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])));

export const tmpDir = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ha-${name}-`)));

const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
export const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...IDENTITY } }).trim();

/** Commits the whole working tree with plumbing only (no hook and no signing involved). */
export function commitAll(cwd, message) {
  g(cwd, 'add', '-A');
  let parent = '';
  try { parent = g(cwd, 'rev-parse', '--verify', '-q', 'HEAD'); } catch {}
  const sha = g(cwd, 'commit-tree', g(cwd, 'write-tree'), ...(parent ? ['-p', parent] : []), '-m', message);
  g(cwd, 'update-ref', 'HEAD', sha);
  return sha;
}

/** A repository with one commit: README.md and packages/app/a.txt. */
export function makeRepo() {
  const tmp = tmpDir('git');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(repo, 'packages', 'app', 'a.txt'), 'a\n');
  return { tmp, repo, base: commitAll(repo, 'init') };
}

/**
 * Runs the publish stage. With the defaults it is offline: the working directory is not a git
 * checkout and there is no tracking comment or pull request, so it never calls the GitHub API.
 * @returns {{ exitCode: number, outputs: Record<string, string>, summary: string, stateDir: string }}
 */
export async function runPublish({ context = {}, run = {}, inputs: over = {}, files = {}, env: extraEnv = {} } = {}) {
  const { publish } = await import('../../src/stages/publish.mjs');
  const stateDir = tmpDir('publish');
  const write = (name, data) => {
    fs.mkdirSync(path.dirname(path.join(stateDir, name)), { recursive: true });
    fs.writeFileSync(path.join(stateDir, name), typeof data === 'string' ? data : JSON.stringify(data));
  };
  write('context.json', {
    run: true, mode: 'automation', harness: 'pi', model: 'a/b', workDir: tmpDir('work'), version: '1', commitMode: 'none',
    ctx: { owner: 'acme', repo: 'demo', number: null, isPR: false, actor: 'alice', runUrl: 'https://example/run', serverUrl: 'https://github.com', sha: 'abc' },
    ...context,
  });
  if (run !== null) write('run.json', { status: 'success', exitCode: 0, durationMs: 1000, finalText: 'done', tools: 1, inputTokens: 1, outputTokens: 1, cost: 0, costKnown: false, errors: [], iterations: [{ n: 1 }], loopResult: 'single', loopUntil: '', ...run });
  for (const [name, data] of Object.entries(files)) write(name, data);
  const env = { ...Object.fromEntries(Object.entries({ model: 'a/b', harness: 'pi', ...over }).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])), ...extraEnv };
  const outputFile = path.join(stateDir, 'outputs.txt');
  const summaryFile = path.join(stateDir, 'summary.md');
  const saved = { GITHUB_OUTPUT: process.env.GITHUB_OUTPUT, GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY };
  Object.assign(process.env, { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile });
  try {
    const { exitCode } = await publish({ env, stateDir });
    const outputs = {};
    for (const m of fs.readFileSync(outputFile, 'utf8').matchAll(/^([\w-]+)<<(ghadelim_[\w-]+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
    return { exitCode, outputs, summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '', stateDir };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
