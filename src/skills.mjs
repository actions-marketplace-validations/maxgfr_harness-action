// Agent Skills (SKILL.md) resolution and installation.
//
// Skills land in an ISOLATED home ($HOME/.agents/skills), the one user-level directory OpenCode,
// Codex and Pi all read (OpenClaw is pointed at it with skills.load.extraDirs). The
// repository checkout is never written to, so a run never adds skills to the diff.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_SKILL_DIRS = ['.agents/skills', '.claude/skills', '.opencode/skills', '.codex/skills', '.pi/skills', '.openclaw/skills'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'target']);

export function parseSource(raw, { cwd = process.cwd() } = {}) {
  const s = raw.trim();
  if (s.startsWith('.') || s.startsWith('/') || s.startsWith('~')) {
    return { type: 'local', path: path.resolve(cwd, s.replace(/^~(?=\/)/, os.homedir())), raw: s };
  }
  let skill = null;
  let rest = s;
  const hash = rest.indexOf('#');
  if (hash >= 0) { skill = rest.slice(hash + 1) || null; rest = rest.slice(0, hash); }
  let ref = null;
  let url;
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([^@\s]+))?$/.exec(rest);
  if (m && !rest.includes('://') ) {
    url = `https://github.com/${m[1]}/${m[2]}.git`;
    ref = m[3] ?? null;
  } else if (/^https?:\/\//.test(rest)) {
    const at = rest.lastIndexOf('@');
    const slash = rest.lastIndexOf('/');
    if (at > slash) { ref = rest.slice(at + 1); rest = rest.slice(0, at); }
    url = rest.endsWith('.git') ? rest : `${rest}.git`;
  } else if (fs.existsSync(path.resolve(cwd, s))) {
    return { type: 'local', path: path.resolve(cwd, s), raw: s };
  } else {
    throw new Error(`Cannot parse skill source "${raw}" (expected owner/repo[@ref][#skill], a git URL or a local path)`);
  }
  return { type: 'git', url, ref, skill, raw: s };
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    } else {
      value = value.replace(/^(['"])(.*)\1$/, '$2');
    }
    out[kv[1]] = value;
  }
  return out;
}

/**
 * A skill is installed in a directory named after it. The name comes from the SKILL.md of a
 * repository we do not control, so it must be one path segment: `../../x` would otherwise make
 * the install delete and overwrite a directory outside the skills folder.
 */
const isPathSegment = (name) => typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);

export function discoverSkills(root, { maxDepth = 6 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const meta = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
      found.push({ name: isPathSegment(meta.name) ? meta.name : path.basename(dir), description: meta.description || '', dir });
      return; // a skill's own sub-folders are its resources, not more skills
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}

/**
 * The token reaches git through its environment (`GIT_CONFIG_*`), never through the command
 * line: Node puts the whole command line in the message of a failed command, and that message
 * ends up in the job log and in the tracking comment.
 */
export function authEnv(src, token) {
  if (!token || !/^https:\/\/github\.com\//.test(src.url)) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

export function cloneSource(src, dest, token) {
  const env = { ...process.env, ...authEnv(src, token) };
  const isSha = src.ref && /^[0-9a-f]{7,40}$/i.test(src.ref);
  try {
    if (src.ref && isSha) {
      git(['init', '-q', dest]);
      git(['-C', dest, 'fetch', '-q', '--depth', '1', src.url, src.ref], { env });
      git(['-C', dest, 'checkout', '-q', 'FETCH_HEAD']);
    } else {
      git(['clone', '-q', '--depth', '1', '--single-branch', ...(src.ref ? ['--branch', src.ref] : []), src.url, dest], { env });
    }
  } catch (err) {
    // git's own words only
    const why = String(err.stderr ?? '').trim().split('\n').slice(-3).join(' ') || `git exited with code ${err.status ?? '?'}`;
    throw new Error(`Cannot fetch skills from ${src.url}${src.ref ? `@${src.ref}` : ''}: ${why}`);
  }
}

function copySkill(skill, targets) {
  for (const base of targets) {
    const dest = path.join(base, skill.name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(skill.dir, dest, { recursive: true, filter: (p) => !p.split(path.sep).includes('.git') });
  }
  return path.join(targets[0], skill.name);
}

/**
 * @returns {{ name, description, dir, source }[]} installed skills, in precedence order
 */
export function installSkills({ sources = [], home, workDir, token, tmpDir = os.tmpdir(), log = () => {} }) {
  const targets = [path.join(home, '.agents', 'skills')];
  const installed = new Map();

  // 1. Skills committed to the repository, whatever harness they were written for.
  for (const rel of REPO_SKILL_DIRS) {
    const dir = path.join(workDir, rel);
    if (!fs.existsSync(dir)) continue;
    for (const skill of discoverSkills(dir, { maxDepth: 2 })) {
      if (installed.has(skill.name)) continue;
      installed.set(skill.name, { ...skill, dir: copySkill(skill, targets), source: rel });
    }
  }

  // 2. Explicit sources: they override a repository skill of the same name.
  for (const raw of sources) {
    const src = parseSource(raw, { cwd: workDir });
    let root;
    if (src.type === 'local') {
      root = src.path;
      if (!fs.existsSync(root)) throw new Error(`Skill source ${raw}: ${root} does not exist`);
    } else {
      root = fs.mkdtempSync(path.join(tmpDir, 'skill-src-'));
      log(`Fetching skills from ${src.url}${src.ref ? `@${src.ref}` : ''}`);
      cloneSource(src, root, token);
    }
    let skills = discoverSkills(root);
    if (src.skill) skills = skills.filter((s) => s.name === src.skill || path.basename(s.dir) === src.skill);
    if (!skills.length) throw new Error(`Skill source ${raw}: no SKILL.md found${src.skill ? ` for "${src.skill}"` : ''}`);
    for (const skill of skills) {
      if (installed.has(skill.name)) log(`Skill ${skill.name} from ${raw} overrides ${installed.get(skill.name).source}`);
      installed.set(skill.name, { ...skill, dir: copySkill(skill, targets), source: raw });
    }
  }
  return [...installed.values()];
}
