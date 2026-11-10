import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readInputs } from '../../src/inputs.mjs';
import { commitChanges } from '../../src/stages/publish.mjs';

const inputs = (over = {}) => readInputs(Object.fromEntries(Object.entries({ model: 'a/b', ...over }).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])));

const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...IDENTITY } }).trim();

/** Commits the whole working tree with plumbing only (no hook and no signing involved). */
function commitAll(cwd, message) {
  g(cwd, 'add', '-A');
  let parent = '';
  try { parent = g(cwd, 'rev-parse', '--verify', '-q', 'HEAD'); } catch {}
  const sha = g(cwd, 'commit-tree', g(cwd, 'write-tree'), ...(parent ? ['-p', parent] : []), '-m', message);
  g(cwd, 'update-ref', 'HEAD', sha);
  return sha;
}

/** A repository with one commit: README.md and packages/app/a.txt. */
function makeRepo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-git-')));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(repo, 'packages', 'app', 'a.txt'), 'a\n');
  return { tmp, repo, base: commitAll(repo, 'init') };
}

/** The GitHub client `commitChanges` needs, recording what it is asked to do. */
function fakeGitHub({ onRef = () => {} } = {}) {
  const calls = { refs: [], commits: [], deleted: [] };
  return {
    calls,
    post: async (p, body) => { if (p.endsWith('/git/refs')) { calls.refs.push(body.ref); onRef(body, calls); } return {}; },
    request: async (method, p) => { if (method === 'DELETE') calls.deleted.push(p); return null; },
    graphql: async (_query, { input }) => { calls.commits.push(input); return { createCommitOnBranch: { commit: { oid: 'c0ffee0000000000000000000000000000000001', url: 'https://example/commit' } } }; },
  };
}

const contextFor = (base, over = {}) => ({
  harness: 'pi', model: 'a/b', commitMode: 'new-branch', baseHead: base, branchName: 'main', request: '@harness fix it',
  ctx: { owner: 'acme', repo: 'demo', number: 7, isPR: false, actor: 'alice', actorId: 1, runUrl: 'https://example/run', serverUrl: 'https://github.com', defaultBranch: 'main', title: 'Fix it', sha: base },
  ...over,
});

const decode = (addition) => Buffer.from(addition.contents, 'base64').toString('utf8');

async function commit(repo, base, { workDir = repo, context = {}, github = fakeGitHub(), over = {} } = {}) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-report-'));
  const result = await commitChanges({ github, inputs: inputs(over), context: contextFor(base, context), workDir, reportDir });
  const patchFile = path.join(reportDir, 'changes.patch');
  return { ...result, github, patch: fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '' };
}

test('working_directory in a sub-directory: files are read from the repository root', async () => {
  const { repo, base } = makeRepo();
  const app = path.join(repo, 'packages', 'app');
  fs.writeFileSync(path.join(app, 'a.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(app, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n\nmore\n');
  fs.mkdirSync(path.join(app, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(app, '.codex', 'sessions', 's.jsonl'), '{}\n'); // harness state, not a change
  const { branch, github, patch } = await commit(repo, base, { workDir: app });
  assert.match(branch.name, /^harness\/issue-7-/);
  const additions = github.calls.commits[0].fileChanges.additions;
  assert.deepEqual(additions.map((a) => a.path).sort(), ['README.md', 'packages/app/a.txt', 'packages/app/new.txt']);
  assert.equal(decode(additions.find((a) => a.path === 'packages/app/a.txt')), 'a\nb\n');
  assert.match(patch, /README\.md/); // the patch covers the whole repository too
  assert.doesNotMatch(patch, /\.codex/);
});
