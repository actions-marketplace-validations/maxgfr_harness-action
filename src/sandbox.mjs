// The agent's own user.
//
// Prepare and Publish hold the GitHub token; Run does not. Without more, the three run as the
// same user, so an agent that can run commands (a shell, or the code `loop_until` executes)
// could still reach the token-holding steps: rewrite the action's files or the state they read,
// read their environment through /proc, or leave a process behind that waits for Publish to
// restore the checkout credentials. So when the agent can run code, the whole Run step runs as
// a system user created for this run only (`ha-agent-<random>`):
//
//   - it can write the working tree, its own home and the directories Run writes to, nothing
//     else of the runner's; the files Prepare wrote are the runner's, in sticky directories,
//     so it can read them but never replace them;
//   - when Run ends, every one of its processes is killed (Run's own wrapper, then Publish
//     again), its cron jobs are removed, everything it wrote becomes the runner's again, the
//     modes of the working tree are put back, the checkout's git configuration and hooks are
//     restored, and symbolic links are removed from the directories Publish reads or uploads;
//   - Publish deletes the user.
//
// It needs Linux and passwordless sudo, which GitHub-hosted runners have.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { restoreGit } from './git.mjs';

const sudo = (args, opts = {}) => execFileSync('sudo', ['-n', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
const trySudo = (args, opts) => { try { sudo(args, opts); return true; } catch { return false; } };

/** Can this runner give the agent its own user? */
export function sandboxSupport() {
  if (process.platform !== 'linux') return { ok: false, reason: `${process.platform} runner` };
  if (typeof process.getuid === 'function' && process.getuid() === 0) return { ok: false, reason: 'the job already runs as root' };
  if (!trySudo(['true'])) return { ok: false, reason: 'no passwordless sudo' };
  if (!trySudo(['sh', '-c', 'command -v useradd && command -v userdel && command -v pgrep && command -v pkill && command -v find'])) return { ok: false, reason: 'useradd / userdel / pgrep / pkill / find not available' };
  return { ok: true, reason: '' };
}

/**
 * Whether this run gets its own user: `on` always (and fails if the runner cannot), `off`
 * never, `auto` when the agent can execute code and the runner supports it.
 * @returns {{ enabled: boolean, reason: string, warn?: boolean }}
 */
export function sandboxDecision({ mode, perms, loopUntil, support = sandboxSupport }) {
  if (mode === 'off') return { enabled: false, reason: 'sandbox: off' };
  const runsCode = perms.bash !== 'none' || Boolean(loopUntil);
  if (mode === 'auto' && !runsCode) return { enabled: false, reason: 'the agent cannot run commands' };
  const s = support();
  if (s.ok) return { enabled: true, reason: runsCode ? 'the agent can run commands' : 'sandbox: on' };
  if (mode === 'on') throw new Error(`sandbox: on, but this runner cannot run the agent as its own user (${s.reason}). It needs Linux and passwordless sudo.`);
  return { enabled: false, reason: `this runner cannot (${s.reason})`, warn: true };
}

/** Every directory from `/` down to `p` (included). */
function ancestors(p) {
  const out = [];
  for (let d = path.resolve(p); ; d = path.dirname(d)) { out.unshift(d); if (d === path.dirname(d)) break; }
  return out;
}

export const isInside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** `PATH` without the directories the agent could write to: a program it planted there must not be what the job's user runs. */
export function safePath(pathValue, writable) {
  return String(pathValue ?? '').split(path.delimiter).filter((d) => d && !writable.some((w) => isInside(path.resolve(d), w))).join(path.delimiter);
}

/**
 * Creates the user and gives it what it needs. Any failure undoes what was done and throws.
 * @param {object} p
 * @param {string[]} p.writable  directories the agent writes to (recursively)
 * @param {string[]} p.sticky    directories it may add files to, where it cannot replace the runner's
 * @param {string[]} p.readable  files / directories it must be able to read (recursively)
 * @param {string}   p.home      its home directory (one of `writable`)
 * @param {string}   p.privateDir a directory of the runner's only, for what is needed to undo all this
 * @param {string|null} p.gitSnapshot the manifest written by `snapshotGit`, if there is a checkout
 */
export function setupSandbox({ writable, sticky, readable, home, privateDir, gitSnapshot = null, log = () => {} }) {
  const user = `ha-agent-${crypto.randomBytes(4).toString('hex')}`;
  // A real shell (harnesses run their shell tool with the user's login shell) and a real home;
  // the account has no password, nobody can log in with it.
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  sudo(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', home, '--shell', shell, user]);
  for (const d of writable) fs.mkdirSync(d, { recursive: true });
  const sandbox = { user, owner: `${process.getuid()}:${process.getgid()}`, home, shell, writable, sticky, modes: path.join(privateDir, 'modes'), gitSnapshot };
  try {
    if (!trySudo(['-u', user, 'true'])) throw new Error(`sudo cannot run commands as ${user}`);
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    // the modes the working tree had, to put them back afterwards (octal, NUL-separated)
    const listed = writable.map((d) => execFileSync('find', [d, '!', '-type', 'l', '-printf', '%m %p\\0'], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] }));
    fs.writeFileSync(sandbox.modes, listed.join(''), { mode: 0o600 });
    // the way in: every directory above what it uses must be traversable (o+x)
    const traverse = new Set();
    for (const p of [...writable, ...sticky, ...readable]) {
      for (const d of ancestors(fs.existsSync(p) && !fs.statSync(p).isDirectory() ? path.dirname(p) : p)) traverse.add(d);
    }
    const closed = [...traverse].filter((d) => { try { return !(fs.statSync(d).mode & 0o001); } catch { return false; } });
    if (closed.length) sudo(['chmod', 'o+x', ...closed]);
    for (const p of readable) if (fs.existsSync(p)) sudo(['chmod', '-R', 'o+rX', p]);
    for (const d of sticky) { fs.mkdirSync(d, { recursive: true }); sudo(['chmod', '1777', d]); }
    for (const d of writable) sudo(['chmod', '-R', 'a+rwX', d]);
    log(`Created the system user ${user} for the agent.`);
    return sandbox;
  } catch (err) {
    reclaim(sandbox, { removeUser: true });
    throw err;
  }
}

/**
 * The command that runs `argv` as the agent's user. Its environment goes through `envFile`, a file
 * only that user can read: not on the command line, where every user of the machine could read
 * it, and not through `sudo -E`, which many sudoers policies (GitHub-hosted runners' included)
 * refuse. The process it starts reads the file, removes it, and takes the variables (`takeEnv`).
 */
export function asAgent(sandbox, argv, { home, env, envFile }) {
  fs.writeFileSync(envFile, JSON.stringify(env), { mode: 0o600 });
  sudo(['chown', sandbox.user, envFile]);
  return ['sudo', ['-n', '-u', sandbox.user, '--', 'env', `PATH=${env.PATH ?? ''}`, `HOME=${home}`, `SHELL=${sandbox.shell}`, `USER=${sandbox.user}`, `LOGNAME=${sandbox.user}`, `HARNESS_ENV_FILE=${envFile}`, ...argv]];
}

/** In the process `asAgent` started: the environment it was given, once (the file goes). */
export function takeEnv(target = process.env) {
  const file = target.HARNESS_ENV_FILE;
  if (!file) return;
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file, { force: true });
  // (what sudo set for the agent's user wins: its PATH, HOME, SHELL, USER, LOGNAME)
  const own = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME'];
  for (const k of Object.keys(target)) if (!own.includes(k)) delete target[k];
  for (const [k, v] of Object.entries(env)) if (!own.includes(k) || target[k] === undefined) target[k] = v;
}

/** What still runs as `user`, as `pgrep -a` prints it. */
function remaining(user) {
  const r = spawnSync('pgrep', ['-u', user, '-a'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/**
 * Ends every process of the agent's user, and its cron jobs. Two ways, because a runner may
 * refuse either: `pkill` by uid as root, and `kill -1` sent as that user through a shell (its
 * built-in, so no command-line parsing of `-1` is involved), which reaches all of its processes
 * at once, so one that keeps forking cannot slip between a listing and a kill.
 * @returns {{ clean: boolean, left: string[] }}
 */
export function killAgent(sandbox) {
  if (!sandbox?.user) return { clean: true, left: [] };
  trySudo(['crontab', '-r', '-u', sandbox.user]);
  let left = remaining(sandbox.user);
  for (let i = 0; i < 10 && left.length; i++) {
    trySudo(['pkill', '-KILL', '-u', sandbox.user]);
    trySudo(['-u', sandbox.user, 'sh', '-c', 'kill -KILL -1 2>/dev/null; exit 0']);
    left = remaining(sandbox.user);
    if (left.length) spawnSync('sleep', ['0.5']);
  }
  return { clean: left.length === 0, left };
}

/** Removes every symbolic link under `dir`: what is read or uploaded from it stays inside it. */
export function dropLinks(dir) {
  const removed = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { fs.rmSync(p, { force: true }); removed.push(p); } else if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return removed;
}

/** Puts back the modes `setupSandbox` recorded (a path that is gone is skipped). */
function restoreModes(file) {
  let listed = '';
  try { listed = fs.readFileSync(file, 'utf8'); } catch { return; }
  const byMode = new Map();
  for (const entry of listed.split('\0')) {
    const space = entry.indexOf(' ');
    if (space < 0) continue;
    const mode = entry.slice(0, space);
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode).push(entry.slice(space + 1));
  }
  for (const [mode, paths] of byMode) trySudo(['xargs', '-0', '-r', 'chmod', '-f', mode], { input: paths.join('\0'), stdio: ['pipe', 'ignore', 'ignore'] });
}

/**
 * Takes the files back. Safe to call more than once (Run's wrapper, then Publish). The order
 * matters: no process of the agent is left when its files change hands, and the links are gone
 * before any mode is set.
 * @returns {{ clean: boolean, undone: string[] }} clean: no process of the agent is left
 */
export function reclaim(sandbox, { uploads = [], removeUser = false, log = () => {} } = {}) {
  if (!sandbox?.user) return { clean: true, undone: [] };
  const { clean, left } = killAgent(sandbox);
  if (!clean) log(`Some processes of ${sandbox.user} could not be stopped: ${left.slice(0, 5).join(' | ')}`);
  const dirs = [...sandbox.writable, ...sandbox.sticky].filter((d) => fs.existsSync(d));
  if (dirs.length) trySudo(['chown', '-R', '--no-dereference', '--preserve-root', sandbox.owner, ...dirs]);
  for (const d of [...new Set([...sandbox.sticky, ...uploads])]) {
    const removed = d ? dropLinks(d) : [];
    if (removed.length) log(`Removed ${removed.length} symbolic link(s) the agent left in ${d}.`);
  }
  for (const d of sandbox.sticky) if (fs.existsSync(d)) fs.chmodSync(d, 0o755);
  restoreModes(sandbox.modes);
  const undone = sandbox.gitSnapshot && fs.existsSync(sandbox.gitSnapshot) ? restoreGit(sandbox.gitSnapshot) : [];
  if (undone.length) log(`Undid what the agent changed in the checkout's git directory: ${undone.join(', ')}.`);
  if (removeUser && clean) trySudo(['userdel', sandbox.user]);
  return { clean, undone };
}
