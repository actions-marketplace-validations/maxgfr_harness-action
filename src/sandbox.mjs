// The agent's own user.
//
// Prepare and Publish hold the GitHub token; Run does not. Without more, the three run as the
// same user, so an agent that can run commands (a shell, or the code `loop_until` executes)
// could still reach the token-holding steps: rewrite the action's files or the state they read,
// read their environment through /proc, or leave a process behind that waits for Publish to
// restore the checkout credentials. So when the agent can run code, the whole Run step runs as
// a dedicated system user, `harness-agent`:
//
//   - it can write only the working tree, its own home and the directories Run writes to;
//   - the files Prepare wrote (plan, context, prompts) are the runner's, in a sticky directory:
//     the agent can read them, never replace them;
//   - every one of its processes is killed before Publish restores credentials, and Publish
//     takes the files back (owner, no symbolic link) before it uses them.
//
// It needs Linux and passwordless sudo, which GitHub-hosted runners have.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const AGENT_USER = 'harness-agent';

const sudo = (args, opts = {}) => execFileSync('sudo', ['-n', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
const trySudo = (args) => { try { sudo(args); return true; } catch { return false; } };

/** Can this runner give the agent its own user? */
export function sandboxSupport() {
  if (process.platform !== 'linux') return { ok: false, reason: `${process.platform} runner` };
  if (typeof process.getuid === 'function' && process.getuid() === 0) return { ok: false, reason: 'the job already runs as root' };
  if (!trySudo(['true'])) return { ok: false, reason: 'no passwordless sudo' };
  if (!trySudo(['sh', '-c', 'command -v useradd && command -v pkill'])) return { ok: false, reason: 'useradd / pkill not available' };
  return { ok: true, reason: '' };
}

/**
 * Whether this run gets its own user: `on` always (and fails if the runner cannot), `off`
 * never, `auto` when the agent can execute code and the runner supports it.
 * @returns {{ enabled: boolean, reason: string }}
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

/** Every directory from `/` down to `p` (included when it is one). */
function ancestors(p) {
  const out = [];
  for (let d = path.resolve(p); ; d = path.dirname(d)) { out.unshift(d); if (d === path.dirname(d)) break; }
  return out;
}

/**
 * Creates the user (once per machine) and gives it what it needs.
 * @param {object} p
 * @param {string[]} p.writable    directories the agent writes to (recursively)
 * @param {string[]} p.sticky      directories it may add files to, but where it cannot replace the runner's
 * @param {string[]} p.readable    files / directories it must be able to read (recursively)
 * @returns {{ user: string, uid: number, gid: number, owner: string }}
 */
export function setupSandbox({ writable, sticky, readable, log = () => {} }) {
  // A real shell: harnesses run their shell tool with the user's login shell. The account has no
  // password, so nobody can log in with it.
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  if (spawnSync('id', ['-u', AGENT_USER]).status !== 0) {
    sudo(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', shell, AGENT_USER]);
    log(`Created the system user ${AGENT_USER} for the agent.`);
  } else {
    trySudo(['usermod', '--shell', shell, AGENT_USER]);
  }
  const uid = Number(execFileSync('id', ['-u', AGENT_USER], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', AGENT_USER], { encoding: 'utf8' }).trim());
  const owner = `${process.getuid()}:${process.getgid()}`;
  // the way in: every directory above what it uses must be traversable (o+x)
  const traverse = new Set();
  for (const p of [...writable, ...sticky, ...readable]) {
    for (const d of ancestors(fs.existsSync(p) && !fs.statSync(p).isDirectory() ? path.dirname(p) : p)) traverse.add(d);
  }
  const closed = [...traverse].filter((d) => { try { return !(fs.statSync(d).mode & 0o001); } catch { return false; } });
  if (closed.length) sudo(['chmod', 'o+x', ...closed]);
  for (const p of readable) if (fs.existsSync(p)) sudo(['chmod', '-R', 'o+rX', p]);
  for (const d of sticky) { fs.mkdirSync(d, { recursive: true }); sudo(['chmod', '1777', d]); }
  for (const d of writable) { fs.mkdirSync(d, { recursive: true }); sudo(['chmod', '-R', 'a+rwX', d]); }
  return { user: AGENT_USER, uid, gid, owner };
}

/**
 * The command that runs `argv` as the agent's user, with `env` (passed through sudo, never on
 * the command line, where every user of the machine could read it).
 */
export function asAgent(sandbox, argv, { home }) {
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return ['sudo', ['-n', '-E', '-u', sandbox.user, '--', 'env', `PATH=${process.env.PATH ?? ''}`, `HOME=${home}`, `SHELL=${shell}`, `USER=${sandbox.user}`, `LOGNAME=${sandbox.user}`, ...argv]];
}

/** Ends every process of the agent's user: nothing it started outlives the Run step. */
export function killAgent(sandbox) {
  if (!sandbox?.user) return;
  for (const signal of ['TERM', 'KILL']) {
    trySudo(['pkill', `-${signal}`, '-u', sandbox.user]);
    if (spawnSync('pgrep', ['-u', sandbox.user]).status !== 0) return;
    spawnSync('sleep', ['1']);
  }
}

/** Removes every symbolic link under `dir`: an upload of it must not reach files outside it. */
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

/**
 * Publish takes the files back: the agent's processes are gone, everything it wrote is the
 * runner's again, and the directories that are uploaded hold no symbolic link.
 */
export function reclaim(sandbox, { dirs, uploads, log = () => {} }) {
  if (!sandbox?.user) return;
  killAgent(sandbox);
  const present = dirs.filter((d) => d && fs.existsSync(d));
  if (present.length) sudo(['chown', '-R', '--no-dereference', sandbox.owner, ...present]);
  for (const d of uploads) {
    const removed = d ? dropLinks(d) : [];
    if (removed.length) log(`Removed ${removed.length} symbolic link(s) the agent left in ${d}.`);
  }
}
