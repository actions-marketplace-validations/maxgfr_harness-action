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

/** Build a Rust harness from a pinned commit. Cached by SHA. */
export function cargoBuild({ repo, version, bin, toolsDir, subdir = 'rust', log = () => {} }) {
  const dir = path.join(toolsDir, `${bin}-${version}`);
  const binPath = path.join(dir, 'bin', bin);
  if (fs.existsSync(binPath)) {
    log(`${bin}@${version.slice(0, 12)} restored from ${dir}`);
    return binPath;
  }
  const src = path.join(dir, 'src');
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  log(`Building ${bin} from ${repo}@${version.slice(0, 12)} (cargo, release)`);
  run('git', ['init', '-q', src]);
  run('git', ['-C', src, 'fetch', '-q', '--depth', '1', repo, version]);
  run('git', ['-C', src, 'checkout', '-q', 'FETCH_HEAD']);
  run('cargo', ['build', '--release', '--locked', '--bin', bin], { cwd: path.join(src, subdir), stdio: ['ignore', 'pipe', 'inherit'] });
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.copyFileSync(path.join(src, subdir, 'target', 'release', bin), binPath);
  fs.chmodSync(binPath, 0o755);
  fs.rmSync(src, { recursive: true, force: true }); // keep only the binary in the cache
  return binPath;
}
