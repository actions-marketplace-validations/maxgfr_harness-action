// Harness installation into a versioned tools directory (cacheable with actions/cache).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizedEnv } from '../util.mjs';

// Install scripts are third-party code: they get no token.
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: sanitizedEnv(), ...opts });

export function npmInstall({ pkg, version, bin, toolsDir, log = () => {} }) {
  const dir = path.join(toolsDir, `${bin}-${version}`);
  const binPath = path.join(dir, 'node_modules', '.bin', bin);
  if (fs.existsSync(binPath)) {
    log(`${pkg}@${version} restored from ${dir}`);
    return binPath;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `harness-tools-${bin}`, private: true }));
  log(`Installing ${pkg}@${version}`);
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', dir, `${pkg}@${version}`]);
  if (!fs.existsSync(binPath)) throw new Error(`${pkg}@${version} installed but ${binPath} is missing`);
  return binPath;
}
