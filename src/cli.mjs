#!/usr/bin/env node
// Entry point of every action step:  node src/cli.mjs <resolve|prepare|run|publish>
//
// Inputs reach the token-holding steps as HARNESS_INPUTS=${{ toJSON(inputs) }}; the run step
// never receives them (it reads the token-free plan written by prepare).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './core/action.mjs';
import { readInputs, sessionThread, sessionCachePrefix } from './inputs.mjs';
import { resolveHarness } from './harness/index.mjs';
import { readContext } from './github/context.mjs';
import { detectMode } from './modes.mjs';

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
  if (cmd === 'run-as-agent') (await import('./sandbox.mjs')).takeEnv();
  const env = loadInputs(process.env);
  // Real path, like the working directory (see prepare): no symlink in any path a harness sees.
  const tmpRaw = env.RUNNER_TEMP || os.tmpdir();
  const tmp = fs.existsSync(tmpRaw) ? fs.realpathSync(tmpRaw) : tmpRaw;

  if (cmd === 'resolve') {
    const inputs = readInputs(env);
    for (const secret of [inputs.githubToken, inputs.skillsToken]) core.mask(secret);
    const { version, meta, adapterId } = resolveHarness(inputs.harness, inputs.harnessVersion);
    // Whether there is anything to do is known from the event alone (no API call): say it now,
    // so a run that is going to be skipped does not restore the harness from the cache first.
    const ctx = readContext(env);
    const { mode } = detectMode(ctx, inputs);
    core.setOutput('skip', String(mode === 'skip'));
    // A conversation kept in the Actions cache is restored by a step of action.yml, and it has
    // to be there BEFORE prepare, which reads the branch of the conversation from it. Which
    // conversation this run belongs to is known from the event too: name the directory and the
    // cache prefix here, and hand over an empty directory.
    const thread = sessionThread(inputs, ctx, mode);
    const sessionDir = path.join(tmp, 'harness-action-session');
    const restorePrefix = thread && inputs.sessionStore === 'cache' ? sessionCachePrefix(adapterId, thread) : '';
    if (restorePrefix) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    core.setOutput('session_dir', sessionDir);
    core.setOutput('session_restore_prefix', restorePrefix);
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
    core.setOutput('cache_key', `harness-action-v2-${env.RUNNER_OS || process.platform}-${env.RUNNER_ARCH || process.arch}-${adapterId}-${version}`);
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
    return 0;
  }
  if (cmd === 'run') {
    // (the outcome is judged by publish: this step always succeeds)
    const plan = JSON.parse(fs.readFileSync(path.join(stateDir, 'plan.json'), 'utf8'));
    if (!plan.sandbox) {
      const { run } = await import('./stages/run.mjs');
      await run({ env, stateDir });
      return 0;
    }
    const { asAgent, reclaim, safePath } = await import('./sandbox.mjs');
    const { sanitizedEnv } = await import('./util.mjs');
    const envFile = path.join(stateDir, 'agent-env.json');
    try {
      const [bin, args] = asAgent(plan.sandbox, [process.execPath, fileURLToPath(import.meta.url), 'run-as-agent'], { home: plan.home, env: sanitizedEnv(env, { HARNESS_STATE_DIR: stateDir }), envFile });
      core.info(`Running the agent as the user ${plan.sandbox.user}.`);
      const r = spawnSync(bin, args, { stdio: 'inherit', env: { PATH: env.PATH ?? '' } });
      if (r.status !== 0) core.warning(`The run as ${plan.sandbox.user} ended with ${r.error?.message ?? `exit code ${r.status ?? r.signal}`}.`);
    } finally {
      // Nothing it started outlives this step, and its files are the runner's again even if
      // Publish never runs (a cancelled job). (From here on, no program the agent could have
      // planted in the working tree is looked up through PATH.)
      process.env.PATH = safePath(process.env.PATH, plan.sandbox.writable);
      fs.rmSync(envFile, { force: true });
      reclaim(plan.sandbox, { log: core.info });
    }
    return 0;
  }
  if (cmd === 'run-as-agent') {
    const { run } = await import('./stages/run.mjs');
    await run({ env, stateDir });
    return 0;
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
