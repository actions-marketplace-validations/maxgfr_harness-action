// Harness installation into a versioned tools directory (cacheable with actions/cache).
//
// The version of each harness is pinned (versions.json), and so is every package it depends on:
// `locks/<harness>-<version>.json` is the npm lockfile of that version, with the integrity hash of
// each package, and it is installed with `npm ci`. A version without a lockfile (a
// `harness_version` other than the pinned one) is installed with `npm install`, resolved at run time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sanitizedEnv } from '../util.mjs';

const LOCKS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locks');

// Install scripts are third-party code: they get no token.
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: sanitizedEnv(), ...opts });

export const lockFile = (id, version) => path.join(LOCKS, `${id}-${version}.json`);

/** The package.json a lockfile was made for (npm ci refuses one that does not match it). */
export function manifestOf(lock) {
  const root = lock.packages?.[''] ?? {};
  return { name: root.name ?? lock.name, private: true, dependencies: root.dependencies ?? {} };
}

export function npmInstall({ id, pkg, version, bin, toolsDir, log = () => {} }) {
  const dir = path.join(toolsDir, `${bin}-${version}`);
  const binPath = path.join(dir, 'node_modules', '.bin', bin);
  if (fs.existsSync(binPath)) {
    log(`${pkg}@${version} restored from ${dir}`);
    return binPath;
  }
  fs.mkdirSync(dir, { recursive: true });
  const locked = id && fs.existsSync(lockFile(id, version));
  if (locked) {
    const lock = JSON.parse(fs.readFileSync(lockFile(id, version), 'utf8'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifestOf(lock), null, 2));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
    log(`Installing ${pkg}@${version} and its locked dependencies`);
    run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', dir]);
  } else {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `harness-tools-${bin}`, private: true }));
    log(`Installing ${pkg}@${version} (not the pinned version: its dependencies are resolved now, not locked)`);
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', dir, `${pkg}@${version}`]);
  }
  if (!fs.existsSync(binPath)) throw new Error(`${pkg}@${version} installed but ${binPath} is missing`);
  return binPath;
}

/** Resolves `pkg@version` and its whole dependency tree into a lockfile (no install). */
export function writeLock({ id, pkg, version, tmpDir }) {
  const dir = fs.mkdtempSync(path.join(tmpDir, `lock-${id}-`));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'harness-tools', private: true }));
    run('npm', ['install', '--package-lock-only', '--save-exact', '--no-audit', '--no-fund', '--loglevel=error', `${pkg}@${version}`], { cwd: dir });
    fs.mkdirSync(LOCKS, { recursive: true });
    fs.copyFileSync(path.join(dir, 'package-lock.json'), lockFile(id, version));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return lockFile(id, version);
}
