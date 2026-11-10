// Git helpers: working-tree changes, credential hygiene, signed commits through the API.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * Files changed in the working tree (tracked + untracked), as { additions: [path], deletions: [path] }.
 * Paths are relative to the repository root: pass `repoRoot(dir)` as `cwd` to read them back.
 */
export function workingTreeChanges(cwd) {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], cwd);
  const additions = [];
  const deletions = [];
  for (const entry of out.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (isArtifact(file)) continue;
    if (code.includes('D')) deletions.push(file);
    else additions.push(file);
  }
  return { additions, deletions, any: additions.length + deletions.length > 0 };
}

export function diffPatch(cwd) {
  // Include untracked files without touching the index permanently.
  const tmpIndex = path.join(git(['rev-parse', '--git-dir'], cwd).trim(), 'harness-index');
  const env = { ...process.env, GIT_INDEX_FILE: path.isAbsolute(tmpIndex) ? tmpIndex : path.join(cwd, tmpIndex) };
  try {
    git(['read-tree', 'HEAD'], cwd, { env });
    git(['add', '-A', '--', '.', ...ARTIFACT_PATHSPECS], cwd, { env });
    return git(['diff', '--cached', '--binary', 'HEAD'], cwd, { env });
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

export async function commitViaApi({ github, owner, repo, branch, expectedHeadOid, cwd, changes, headline, body }) {
  const additions = changes.additions.map((p) => ({ path: p, contents: fs.readFileSync(path.join(cwd, p)).toString('base64') }));
  const deletions = changes.deletions.map((p) => ({ path: p }));
  const data = await github.graphql(CREATE_COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
      message: { headline, body },
      fileChanges: { additions, deletions },
      expectedHeadOid,
    },
  });
  return data.createCommitOnBranch.commit;
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
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '');
      current = p === '/dev/null' ? null : p;
      if (current && !files.has(current)) files.set(current, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { line = Number(h[1]); continue; }
    if (!current || raw.startsWith('diff --git') || raw.startsWith('--- ') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+') || raw.startsWith(' ')) { files.get(current).add(line); line++; }
  }
  return files;
}
