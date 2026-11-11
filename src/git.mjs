// Git helpers: working-tree changes, credential hygiene, signed commits through the API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sanitizedEnv } from './util.mjs';

// (git never gets the action's inputs, the token among them, through its environment: a program
// a repository's configuration names would inherit it)
export const git = (args, cwd, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, env: sanitizedEnv(process.env), ...opts });

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
const ARTIFACT_PATHSPECS = ARTIFACT_DIRS.map((d) => `:(exclude,glob)**/${d}/**`);
// (`.openclaw/skills` is one of the repository's skills directories, not OpenClaw's own state)
const OPENCLAW_SKILLS = ':(glob)**/.openclaw/skills/**';
export const HARNESS_ARTIFACTS = [/(?:^|\/)\.codex\/sessions\//, /(?:^|\/)\.pi\/sessions\//, /(?:^|\/)\.openclaw\/(?!skills\/)/];
const isArtifact = (file) => HARNESS_ARTIFACTS.some((re) => re.test(file));

// ---------------------------------------------------------------------------------------------
// git in a checkout the agent had its hands on. The repository's own configuration can make
// plain `git add` / `git diff` run programs: `core.fsmonitor`, a `post-index-change` hook,
// clean / smudge filters, `diff.external`, textconv. They would run in the publish step, which
// holds the GitHub token, so they are all switched off for these calls, and the calls get the
// scrubbed environment.
// ---------------------------------------------------------------------------------------------
const NO_HOOKS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never'];
const NO_DIFF_PROGRAMS = ['--no-ext-diff', '--no-textconv'];

/** `-c` overrides that turn hooks, the fsmonitor and every configured filter driver into no-ops. */
function inertConfig(cwd, gitArgs = []) {
  const drivers = new Set();
  for (const key of (tryGit([...gitArgs, ...NO_HOOKS, 'config', '--name-only', '--get-regexp', '^filter\\.'], cwd) ?? '').split('\n')) {
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
function lstat(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

/** The paths among `files` that `.gitattributes` hands to Git LFS (`filter=lfs`). */
function lfsTracked(run, files) {
  // `-z`: path NUL attribute NUL value NUL …
  const out = run(['check-attr', '-z', '--stdin', 'filter'], { input: files.join('\0'), stdio: ['pipe', 'pipe', 'pipe'] }).split('\0');
  const tracked = [];
  for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'lfs') tracked.push(out[i]);
  return tracked;
}

/**
 * A git directory of the runner's own, for Publish to compare the working tree with: the
 * checkout's `.git` is something the agent could rewrite (configuration that runs programs, a
 * partial-clone remote, hooks…). It borrows the checkout's objects (alternates) and copies its
 * shallow boundary and local excludes, as they were before the run.
 */
export function privateGitDir(root, dir) {
  const common = path.resolve(root, git(['rev-parse', '--git-common-dir'], root).trim());
  fs.rmSync(dir, { recursive: true, force: true });
  git(['init', '-q', '--bare', dir], root);
  git(['--git-dir', dir, 'config', 'core.bare', 'false'], root);
  fs.writeFileSync(path.join(dir, 'objects', 'info', 'alternates'), `${path.join(common, 'objects')}\n`);
  for (const f of ['shallow', path.join('info', 'exclude')]) {
    if (fs.existsSync(path.join(common, f))) fs.copyFileSync(path.join(common, f), path.join(dir, f));
  }
  return dir;
}

/** The sha256 of a file, read in chunks. */
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/**
 * What the working tree changes compared with the commit `base` (untracked files included), as
 * { additions, deletions, skipped, lfs, executable, any, patch } (lists of paths).
 *   skipped    — cannot be committed through the API (symbolic links, nested repositories);
 *   lfs        — tracked by Git LFS: not committed either (see below);
 *   executable — new files committed without their executable bit.
 * Everything is in the patch.
 *
 * `base` is the commit the run started from, not the current HEAD: an agent that ran `git commit`
 * leaves a clean tree, and its work would otherwise be lost. The comparison goes through a
 * scratch index, so neither the index nor HEAD of the checkout is touched.
 *
 * Paths are relative to the repository root: pass `repoRoot(dir)` as `cwd` to read them back.
 * `gitDir`: compare through that git directory (`privateGitDir`) instead of the checkout's.
 */
export function treeChanges(cwd, base = 'HEAD', { gitDir = null } = {}) {
  const gitArgs = gitDir ? ['--git-dir', gitDir, '--work-tree', cwd] : [];
  const tmpIndex = path.join(gitDir ?? git(['rev-parse', '--git-dir'], cwd).trim(), 'harness-index');
  // (no lazy fetch from a partial-clone remote: a missing object is an error, not a download)
  const env = sanitizedEnv(process.env, { GIT_INDEX_FILE: path.isAbsolute(tmpIndex) ? tmpIndex : path.join(cwd, tmpIndex), GIT_NO_LAZY_FETCH: '1' });
  const inert = inertConfig(cwd, gitArgs);
  const run = (args, opts = {}) => git([...gitArgs, ...inert, ...args], cwd, { env, ...opts });
  try {
    run(['read-tree', base]);
    run(['add', '-A', '--', '.', ...ARTIFACT_PATHSPECS]);
    if (run(['ls-files', '--others', '--modified', '--deleted', '--exclude-standard', '-z', '--', OPENCLAW_SKILLS])) run(['add', '-A', '--', OPENCLAW_SKILLS]);
    const additions = [];
    const deletions = [];
    const skipped = [];
    const executable = [];
    // `-z --name-status`: status NUL path NUL …
    const fields = run(['diff', '--cached', '--name-status', '-z', '--no-renames', ...NO_DIFF_PROGRAMS, base]).split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const file = fields[i + 1];
      if (isArtifact(file)) continue;
      if (fields[i] === 'D') { deletions.push(file); continue; }
      const stat = lstat(path.join(cwd, file));
      if (!stat?.isFile()) { skipped.push(file); continue; }
      additions.push(file);
      // (the API creates every new file as 100644)
      if (fields[i] === 'A' && stat.mode & 0o111) executable.push(file);
    }
    // A file tracked by Git LFS must be committed as a pointer, with its content uploaded to the
    // LFS store. The API would commit the content itself into the repository: left out instead.
    // Filters are off here, so a file Git LFS checked out reads as its content, not its pointer:
    // it is unchanged when that content is the object its pointer names.
    const lfsAll = additions.length ? lfsTracked(run, additions) : [];
    const unchanged = lfsAll.filter((f) => {
      let pointer = '';
      try { pointer = run(['cat-file', 'blob', `${base}:${f}`]); } catch { return false; }
      const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(pointer)?.[1];
      return Boolean(oid) && sha256(path.join(cwd, f)) === oid;
    });
    if (unchanged.length) run(['reset', '-q', base, '--', ...unchanged]);
    const lfs = lfsAll.filter((f) => !unchanged.includes(f));
    const kept = additions.filter((f) => !lfsAll.includes(f));
    const any = kept.length + deletions.length + skipped.length + lfs.length > 0;
    return { additions: kept, deletions, skipped, lfs, executable: executable.filter((f) => !lfsAll.includes(f)), any, patch: any ? run(['diff', '--cached', '--binary', ...NO_DIFF_PROGRAMS, base]) : '' };
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

/**
 * The configuration file of the repository and of every submodule under its git directory
 * (`.git/modules/…`, nested ones included): `actions/checkout` up to v5 writes the token into
 * each of them when it checks submodules out.
 */
export function configFiles(cwd) {
  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], cwd)?.trim();
  if (!gitDir) return [];
  // (a linked worktree's own git directory has no config: it is in the common one)
  const common = path.resolve(cwd, tryGit(['rev-parse', '--git-common-dir'], cwd)?.trim() || gitDir);
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const isGitDir = entries.some((e) => e.isFile() && e.name === 'HEAD');
    if (isGitDir && entries.some((e) => e.isFile() && e.name === 'config')) files.push(path.join(dir, 'config'));
    if (depth >= 8) return;
    // inside a git directory only `modules` holds more of them; above one (a submodule named
    // `libs/foo` lives in modules/libs/foo), any directory may
    for (const e of entries) if (e.isDirectory() && (!isGitDir || e.name === 'modules')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(gitDir, 0);
  if (common !== gitDir) walk(common, 0);
  return [...new Set(files)];
}

export function stripCredentials(cwd) {
  const removed = { headers: [], includes: [] };
  for (const config of configFiles(cwd)) {
    const cfg = (args) => tryGit(['config', '--file', config, ...args], cwd);
    for (const key of new Set((cfg(['--list', '--name-only']) ?? '').split('\n').filter(Boolean))) {
      if (HEADER_KEY_RE.test(key)) {
        removed.headers.push({ file: config, key: key.toLowerCase() });
        cfg(['--unset-all', key]);
      } else if (/^includeif\..*\.path$/i.test(key)) {
        for (const p of (cfg(['--get-all', key]) ?? '').split('\n').filter(Boolean)) {
          const file = path.isAbsolute(p) ? p : path.join(path.dirname(config), p);
          let text = '';
          try { text = fs.readFileSync(file, 'utf8'); } catch {}
          if (/extraheader/i.test(text)) {
            removed.includes.push({ key, file });
            fs.writeFileSync(file, '# credentials removed by harness-action for the agent run\n');
          }
        }
      }
    }
  }
  return removed;
}

export function restoreCredentials(cwd, removed, token, serverUrl = 'https://github.com') {
  if (!removed || !token) return;
  const value = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  // The agent had the checkout: a config file it replaced with a link would make the token land
  // wherever the link points. Only regular files get it back.
  const regular = (file) => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
  for (const { file, key } of removed.headers ?? []) if (regular(file)) tryGit(['config', '--file', file, key, value], cwd);
  for (const { file } of removed.includes ?? []) {
    if (fs.existsSync(file) && !regular(file)) continue;
    // (readable by the job's user only: nothing else on the machine needs the token)
    fs.writeFileSync(file, `[http "${serverUrl.replace(/\/$/, '')}/"]\n\textraheader = ${value}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
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

// ---------------------------------------------------------------------------------------------
// The checkout's git configuration and hooks, as they were before the agent ran. When the agent
// runs as its own user it can write the working tree, `.git` included: whatever it put there
// (configuration that runs programs, hooks, a `commondir` pointing elsewhere) is undone before
// any git command of the job's user runs there again, the next use of the action in the same
// job included.
// ---------------------------------------------------------------------------------------------
const REDIRECTS = ['commondir', 'gitdir', 'config.worktree'];

export function snapshotGit(root, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dotGit = path.join(root, '.git');
  const st = lstat(dotGit);
  const manifest = {
    root,
    dotGit: st ? { ino: st.ino, dir: st.isDirectory(), content: st.isFile() ? fs.readFileSync(dotGit, 'utf8') : null } : null,
    configs: [],
    gitDirs: [],
  };
  configFiles(root).forEach((file, i) => {
    const copy = path.join(dir, `config-${i}`);
    fs.copyFileSync(file, copy);
    manifest.configs.push({ file, copy, mode: fs.statSync(file).mode & 0o777 });
    const gitDir = path.dirname(file);
    const hooks = path.join(gitDir, 'hooks');
    const hooksCopy = path.join(dir, `hooks-${i}`);
    const hasHooks = lstat(hooks)?.isDirectory() ?? false;
    if (hasHooks) fs.cpSync(hooks, hooksCopy, { recursive: true, verbatimSymlinks: true });
    manifest.gitDirs.push({ gitDir, hooks: hasHooks ? hooksCopy : null, present: REDIRECTS.filter((f) => fs.existsSync(path.join(gitDir, f))) });
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return path.join(dir, 'manifest.json');
}

/** Puts back what `snapshotGit` saved. Returns what had to be undone, for the log. */
export function restoreGit(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const undone = [];
  const dotGit = path.join(m.root, '.git');
  const st = lstat(dotGit);
  if (m.dotGit && st && (st.ino !== m.dotGit.ino || st.isDirectory() !== m.dotGit.dir)) {
    // not the `.git` that was there: the agent's, which git must never read
    fs.rmSync(dotGit, { recursive: true, force: true });
    undone.push('.git was replaced: removed');
    if (m.dotGit.content !== null) fs.writeFileSync(dotGit, m.dotGit.content);
  } else if (m.dotGit && m.dotGit.content !== null && st?.isFile() && fs.readFileSync(dotGit, 'utf8') !== m.dotGit.content) {
    fs.writeFileSync(dotGit, m.dotGit.content);
    undone.push('.git (gitdir link) rewritten');
  }
  for (const { file, copy, mode } of m.configs) {
    const now = lstat(file);
    if (now && (!now.isFile() || fs.readFileSync(file, 'utf8') !== fs.readFileSync(copy, 'utf8'))) undone.push(path.relative(m.root, file));
    if (now && !now.isFile()) fs.rmSync(file, { recursive: true, force: true });
    if (!fs.existsSync(path.dirname(file))) continue; // (its git directory went with a replaced .git)
    fs.copyFileSync(copy, file);
    fs.chmodSync(file, mode);
  }
  for (const { gitDir, hooks, present } of m.gitDirs) {
    if (!fs.existsSync(gitDir)) continue;
    const dest = path.join(gitDir, 'hooks');
    fs.rmSync(dest, { recursive: true, force: true });
    if (hooks) fs.cpSync(hooks, dest, { recursive: true, verbatimSymlinks: true });
    for (const f of REDIRECTS) {
      if (!present.includes(f) && fs.existsSync(path.join(gitDir, f))) {
        fs.rmSync(path.join(gitDir, f), { recursive: true, force: true });
        undone.push(path.relative(m.root, path.join(gitDir, f)));
      }
    }
  }
  return undone;
}
