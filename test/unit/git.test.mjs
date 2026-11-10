import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitChanges } from '../../src/stages/publish.mjs';
import { finalBody } from '../../src/publish/render.mjs';
import { inputs, g, commitAll, makeRepo, runPublish } from './helpers.mjs';

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

test('work the agent committed locally is still published, on top of the commit the run started from', async () => {
  const { repo, base } = makeRepo();
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed by the agent\n');
  fs.rmSync(path.join(repo, 'README.md'));
  commitAll(repo, 'agent commit'); // the tree is clean now
  fs.writeFileSync(path.join(repo, 'later.txt'), 'left uncommitted\n');
  const { github, patch } = await commit(repo, base);
  const { fileChanges, expectedHeadOid } = github.calls.commits[0];
  assert.deepEqual(fileChanges.additions.map((a) => a.path).sort(), ['committed.txt', 'later.txt']);
  assert.deepEqual(fileChanges.deletions, [{ path: 'README.md' }]);
  assert.equal(expectedHeadOid, base);
  assert.match(patch, /committed by the agent/);
});

test('a symbolic link is never followed: its target is not read, the link is reported', async () => {
  const { tmp, repo, base } = makeRepo();
  fs.writeFileSync(path.join(tmp, 'outside-secret.txt'), 'TOKEN=ghs_not_for_the_branch\n');
  fs.symlinkSync(path.join(tmp, 'outside-secret.txt'), path.join(repo, 'leak.txt'));
  fs.rmSync(path.join(repo, 'README.md'));
  fs.symlinkSync(path.join(tmp, 'outside-secret.txt'), path.join(repo, 'README.md')); // a tracked file turned into a link
  fs.writeFileSync(path.join(repo, 'real.txt'), 'real\n');
  const { branch, github } = await commit(repo, base);
  const { additions } = github.calls.commits[0].fileChanges;
  assert.deepEqual(additions.map((a) => a.path), ['real.txt']);
  assert.ok(!additions.some((a) => decode(a).includes('ghs_not_for_the_branch')));
  assert.deepEqual(branch.skipped.sort(), ['README.md', 'leak.txt']);
  assert.match(finalBody({ harness: 'pi', model: 'm', runUrl: 'u', status: 'success', finalText: 'ok', branch }), /Not committed[^\n]*`leak\.txt`/);

  // only links: nothing to commit, no empty branch
  const second = makeRepo();
  fs.symlinkSync('/etc/hosts', path.join(second.repo, 'hosts'));
  const only = await commit(second.repo, second.base);
  assert.equal(only.branch, null);
  assert.equal(only.github.calls.refs.length, 0);
  assert.match(only.patch, /hosts/);
});

test('git configuration written by the agent runs nothing in the publish step', async () => {
  const { tmp, repo, base } = makeRepo();
  const ran = (name) => fs.existsSync(path.join(tmp, `ran-${name}`));
  const script = (name) => {
    const file = path.join(tmp, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\ntouch "${path.join(tmp, `ran-${name}`)}"\ncat 2>/dev/null\nexit 0\n`, { mode: 0o755 });
    return file;
  };
  g(repo, 'config', 'core.fsmonitor', script('fsmonitor'));
  g(repo, 'config', 'diff.external', script('extdiff'));
  g(repo, 'config', 'filter.evil.clean', script('filter'));
  g(repo, 'config', 'filter.evil.required', 'true');
  fs.copyFileSync(script('hook'), path.join(repo, '.git', 'hooks', 'post-index-change'));
  fs.chmodSync(path.join(repo, '.git', 'hooks', 'post-index-change'), 0o755);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n\nchanged\n');
  const { github, patch } = await commit(repo, base);
  assert.deepEqual(['fsmonitor', 'extdiff', 'filter', 'hook'].filter(ran), []);
  assert.deepEqual(github.calls.commits[0].fileChanges.additions.map((a) => a.path).sort(), ['.gitattributes', 'README.md']);
  assert.match(patch, /\+changed/);
});

test('a detached checkout does not make "HEAD" the base branch of the pull request', async () => {
  const { repo, base } = makeRepo();
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  const { branch } = await commit(repo, base, { context: { branchName: 'HEAD' } });
  assert.equal(branch.base, 'main');
  assert.match(branch.prUrl, /\/compare\/main\.\.\.harness/);
  const onBranch = await commit(repo, base, { context: { branchName: 'develop' } });
  assert.equal(onBranch.branch.base, 'develop');
});

test('a branch name that is already taken gets a suffix instead of losing the commit', async () => {
  const { repo, base } = makeRepo();
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  const taken = () => Object.assign(new Error('POST /git/refs → 422: Reference already exists'), { status: 422 });
  const github = fakeGitHub({ onRef: (_body, calls) => { if (calls.refs.length === 1) throw taken(); } });
  const { branch } = await commit(repo, base, { github });
  assert.equal(github.calls.refs.length, 2);
  assert.match(branch.name, /^harness\/issue-7-\d{8}-\d{4}-[0-9a-f]{4}$/);
  assert.equal(github.calls.commits[0].branch.branchName, branch.name);
  // any other refusal is still an error
  const denied = fakeGitHub({ onRef: () => { throw Object.assign(new Error('403: Resource not accessible'), { status: 403 }); } });
  await assert.rejects(commit(repo, base, { github: denied }), /not accessible/);
});

test('an unchanged tree commits nothing', async () => {
  const { repo, base } = makeRepo();
  const { branch, github, patch } = await commit(repo, base);
  assert.equal(branch, null);
  assert.equal(github.calls.commits.length, 0);
  assert.equal(patch, '');
});
