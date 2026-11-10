// Git helpers: working-tree changes, credential hygiene, signed commits through the API.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizedEnv } from './util.mjs';

export const git = (args, cwd, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts });

const tryGit = (args, cwd) => { try { return git(args, cwd); } catch { return null; } };

export function isRepo(cwd) {
  return tryGit(['rev-parse', '--is-inside-work-tree'], cwd)?.trim() === 'true';
}

export function headSha(cwd) {
  return tryGit(['rev-parse', 'HEAD'], cwd)?.trim() ?? '';
}

/**
 * Top of the working tree. `git status` reports paths relative to it, whatever the directory it
 * runs in, so files must be read from here and not from `working_directory`.
 */
export function repoRoot(cwd) {
  return tryGit(['rev-parse', '--show-toplevel'], cwd)?.trim() || cwd;
}

/**
 * Files harnesses write into their working directory for themselves: never part of the agent's
 * changes. That directory can be anywhere in the repository (`working_directory`).
 */
const ARTIFACT_DIRS = ['.codex/sessions', '.pi/sessions', '.openclaw'];
export const HARNESS_ARTIFACTS = ARTIFACT_DIRS.map((d) => new RegExp(`(?:^|/)${d.replace(/\./g, '\\.')}/`));
const ARTIFACT_PATHSPECS = ARTIFACT_DIRS.map((d) => `:(exclude,glob)**/${d}/**`);
const isArtifact = (file) => HARNESS_ARTIFACTS.some((re) => re.test(file));

// ---------------------------------------------------------------------------------------------
// git in a checkout the agent had its hands on. The repository's own configuration can make
// plain `git add` / `git diff` run programs: `core.fsmonitor`, a `post-index-change` hook,
// clean / smudge filters, `diff.external`, textconv. They would run in the publish step, which
// holds the GitHub token, so they are all switched off for these calls, and the calls get the
// scrubbed environment.
// ---------------------------------------------------------------------------------------------
const NO_HOOKS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const NO_DIFF_PROGRAMS = ['--no-ext-diff', '--no-textconv'];

/** `-c` overrides that turn hooks, the fsmonitor and every configured filter driver into no-ops. */
function inertConfig(cwd) {
  const drivers = new Set();
  for (const key of (tryGit([...NO_HOOKS, 'config', '--name-only', '--get-regexp', '^filter\\.'], cwd) ?? '').split('\n')) {
    const m = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (m) drivers.add(m[1]);
  }
  // (an empty command is a pass-through; `required` would turn that into an error)
  const off = [...drivers].flatMap((d) => ['clean=', 'smudge=', 'process=', 'required=false'].flatMap((kv) => ['-c', `filter.${d}.${kv}`]));
  return [...NO_HOOKS, ...off];
}

/**
 * Only regular files can be committed: the API takes a path and its contents. A symbolic link is
 * never followed (its target may be any file of the runner: the environment of this process,
 * the checkout credentials…), and a directory is a nested repository.
 */
function isRegularFile(file) {
  try { return fs.lstatSync(file).isFile(); } catch { return false; }
}

/**
 * What the working tree changes compared with the commit `base` (untracked files included), as
 * { additions: [path], deletions: [path], skipped: [path], any, patch }. `skipped` lists what
 * cannot be committed through the API (symbolic links, nested repositories); it is in the patch.
 *
 * `base` is the commit the run started from, not the current HEAD: an agent that ran `git commit`
 * leaves a clean tree, and its work would otherwise be lost. The comparison goes through a
 * scratch index, so neither the index nor HEAD of the checkout is touched.
 *
 * Paths are relative to the repository root: pass `repoRoot(dir)` as `cwd` to read them back.
 */
export function treeChanges(cwd, base = 'HEAD') {
  const tmpIndex = path.join(git(['rev-parse', '--git-dir'], cwd).trim(), 'harness-index');
  const env = sanitizedEnv(process.env, { GIT_INDEX_FILE: path.isAbsolute(tmpIndex) ? tmpIndex : path.join(cwd, tmpIndex) });
  const inert = inertConfig(cwd);
  const run = (args) => git([...inert, ...args], cwd, { env });
  try {
    run(['read-tree', base]);
    run(['add', '-A', '--', '.', ...ARTIFACT_PATHSPECS]);
    const additions = [];
    const deletions = [];
    const skipped = [];
    // `-z --name-status`: status NUL path NUL …
    const fields = run(['diff', '--cached', '--name-status', '-z', '--no-renames', ...NO_DIFF_PROGRAMS, base]).split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const file = fields[i + 1];
      if (isArtifact(file)) continue;
      if (fields[i] === 'D') deletions.push(file);
      else (isRegularFile(path.join(cwd, file)) ? additions : skipped).push(file);
    }
    const any = additions.length + deletions.length + skipped.length > 0;
    return { additions, deletions, skipped, any, patch: any ? run(['diff', '--cached', '--binary', ...NO_DIFF_PROGRAMS, base]) : '' };
  } finally {
    fs.rmSync(env.GIT_INDEX_FILE, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Credentials. actions/checkout persists the job token in the local git config (or, in newer
// versions, in a file pulled in with includeIf). The agent must not be able to read it, so it is
// removed for the run and re-created afterwards with the action's own token.
// ---------------------------------------------------------------------------------------------
const HEADER_KEY_RE = /^http\.(.+)\.extraheader$/i;

export function stripCredentials(cwd) {
  const removed = { headers: [], includes: [] };
  const list = tryGit(['config', '--local', '--list', '--name-only'], cwd) ?? '';
  for (const key of new Set(list.split('\n').filter(Boolean))) {
    if (HEADER_KEY_RE.test(key)) {
      removed.headers.push(key.toLowerCase());
      tryGit(['config', '--local', '--unset-all', key], cwd);
    } else if (/^includeif\..*\.path$/i.test(key)) {
      for (const p of (tryGit(['config', '--local', '--get-all', key], cwd) ?? '').split('\n').filter(Boolean)) {
        const file = path.isAbsolute(p) ? p : path.join(cwd, '.git', p);
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch {}
        if (/extraheader/i.test(text)) {
          removed.includes.push({ key, file });
          fs.writeFileSync(file, '# credentials removed by harness-action for the agent run\n');
        }
      }
    }
  }
  return removed;
}

export function restoreCredentials(cwd, removed, token, serverUrl = 'https://github.com') {
  if (!removed || !token) return;
  const value = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  for (const key of removed.headers ?? []) tryGit(['config', '--local', key, value], cwd);
  for (const { file } of removed.includes ?? []) {
    fs.writeFileSync(file, `[http "${serverUrl.replace(/\/$/, '')}/"]\n\textraheader = ${value}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Signed commits: createCommitOnBranch commits as the token's identity and GitHub signs it.
// ---------------------------------------------------------------------------------------------
const CREATE_COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

export async function commitViaApi({ github, owner, repo, branch, expectedHeadOid, cwd, changes, headline, body, retries = 2, retryDelayMs = 2000 }) {
  const additions = changes.additions.map((p) => ({ path: p, contents: fs.readFileSync(path.join(cwd, p)).toString('base64') }));
  const deletions = changes.deletions.map((p) => ({ path: p }));
  const input = {
    branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
    message: { headline, body },
    fileChanges: { additions, deletions },
    expectedHeadOid,
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return (await github.graphql(CREATE_COMMIT, { input })).createCommitOnBranch.commit;
    } catch (err) {
      // No answer at all, or a server-side failure: the only cases worth another try. A refusal
      // (an error GitHub answered with) is final.
      const transient = !err.status || err.status >= 500 || err.status === 429;
      if (!transient || attempt >= retries) throw err;
      // The commit may have been made all the same. Sending it again would then fail on
      // `expectedHeadOid` and report a commit that exists as lost: look at the branch first.
      const landed = await landedCommit({ github, owner, repo, branch, expectedHeadOid, headline }).catch(() => null);
      if (landed) return landed;
      await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** attempt));
    }
  }
}

/** The commit this run was creating, if the branch already carries it: our headline, on top of the expected head. */
async function landedCommit({ github, owner, repo, branch, expectedHeadOid, headline }) {
  const head = (await github.get(`/repos/${owner}/${repo}/git/ref/heads/${branch}`))?.object?.sha;
  if (!head || head === expectedHeadOid) return null;
  const commit = await github.get(`/repos/${owner}/${repo}/git/commits/${head}`);
  const ours = commit?.parents?.[0]?.sha === expectedHeadOid && String(commit.message ?? '').split('\n')[0] === headline;
  return ours ? { oid: head, url: commit.html_url } : null;
}

export async function createBranch({ github, owner, repo, branch, sha }) {
  await github.post(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
}

// ---------------------------------------------------------------------------------------------
// Unified diff → commentable lines (RIGHT side) per file.
// ---------------------------------------------------------------------------------------------
export function commentableLines(diff) {
  const files = new Map();
  let current = null;
  let line = 0;
  // Lines the current hunk still has to give, from its header. Inside a hunk every line is
  // content, whatever it looks like: an added line `++ x` reads `+++ x`, like a file header.
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
      if (raw.startsWith('-')) { oldLeft--; continue; }
      if (!raw.startsWith('+')) oldLeft--; // context
      newLeft--;
      files.get(current)?.add(line);
      line++;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '');
      current = p === '/dev/null' ? null : p;
      if (current && !files.has(current)) files.set(current, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      line = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
  return files;
}
