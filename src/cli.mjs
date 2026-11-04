#!/usr/bin/env node
// Entry point of every action step:  node src/cli.mjs <resolve|prepare|run|publish>
//
// Inputs reach the token-holding steps as HARNESS_INPUTS=${{ toJSON(inputs) }}; the run step
// never receives them (it reads the token-free plan written by prepare).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as core from './core/action.mjs';
import { readInputs } from './inputs.mjs';
import { resolveHarness } from './harness/index.mjs';

function loadInputs(env) {
  if (!env.HARNESS_INPUTS) return env;
  const inputs = JSON.parse(env.HARNESS_INPUTS);
  const out = { ...env };
  for (const [k, v] of Object.entries(inputs)) out[`INPUT_${k.replace(/ /g, '_').toUpperCase()}`] = v == null ? '' : String(v);
  delete out.HARNESS_INPUTS;
  return out;
}

async function main() {
  const cmd = process.argv[2];
  const env = loadInputs(process.env);
  // Real path, like the working directory (see prepare): no symlink in any path a harness sees.
  const tmpRaw = env.RUNNER_TEMP || os.tmpdir();
  const tmp = fs.existsSync(tmpRaw) ? fs.realpathSync(tmpRaw) : tmpRaw;

  if (cmd === 'resolve') {
    const inputs = readInputs(env);
    for (const secret of [inputs.githubToken, inputs.skillsToken]) core.mask(secret);
    const { version, meta, adapterId } = resolveHarness(inputs.harness, inputs.harnessVersion);
    const id = `${env.GITHUB_RUN_ID || 'local'}-${env.GITHUB_RUN_ATTEMPT || '1'}-${crypto.randomBytes(3).toString('hex')}`;
    const stateDir = path.join(tmp, 'harness-action', id);
    const toolsDir = path.join(tmp, 'harness-action-tools');
    fs.mkdirSync(stateDir, { recursive: true });
    const bin = meta.bin;
    core.setOutput('state_dir', stateDir);
    core.setOutput('tools_dir', toolsDir);
    core.setOutput('harness', inputs.harness);
    core.setOutput('version', version);
    core.setOutput('cache_path', path.join(toolsDir, `${bin}-${version}`));
    core.setOutput('cache_key', `harness-action-v1-${env.RUNNER_OS || process.platform}-${env.RUNNER_ARCH || process.arch}-${adapterId}-${version}`);
    core.setOutput('artifact_name', `harness-${(env.GITHUB_JOB || 'job').replace(/[^\w-]/g, '-')}-${inputs.harness}-${id.split('-').pop()}`);
    return 0;
  }

  const stateDir = env.HARNESS_STATE_DIR;
  if (!stateDir) throw new Error('HARNESS_STATE_DIR is not set (run the resolve step first)');

  if (cmd === 'prepare') {
    const { prepare } = await import('./stages/prepare.mjs');
    const res = await prepare({ env, stateDir, toolsDir: env.HARNESS_TOOLS_DIR || path.join(tmp, 'harness-action-tools') });
    core.setOutput('run', String(res.run));
    core.setOutput('mode', res.mode);
    core.setOutput('session_dir', res.sessionDir ?? '');
    core.setOutput('session_restore_prefix', res.sessionRestorePrefix ?? '');
    return 0;
  }
  if (cmd === 'run') {
    const { run } = await import('./stages/run.mjs');
    await run({ env, stateDir });
    return 0; // the outcome is judged by publish
  }
  if (cmd === 'publish') {
    const { publish } = await import('./stages/publish.mjs');
    const { exitCode } = await publish({ env, stateDir });
    return exitCode;
  }
  throw new Error(`Unknown command "${cmd}" (expected resolve | prepare | run | publish)`);
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    core.error(err?.stack && process.env.RUNNER_DEBUG ? err.stack : err?.message ?? String(err));
    process.exit(1);
  },
);
