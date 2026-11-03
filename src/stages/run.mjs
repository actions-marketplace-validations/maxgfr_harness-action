// Stage 2 (NO GitHub token in this process): run the harness from the token-free plan.
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../core/action.mjs';
import { getAdapter } from '../harness/index.mjs';
import { runHarness, sanitizedEnv } from '../runner.mjs';

const MAX_ARGV_PROMPT = 100_000; // Linux caps one argv string at 128 KiB

export async function run({ stateDir, env = process.env }) {
  const plan = JSON.parse(fs.readFileSync(path.join(stateDir, 'plan.json'), 'utf8'));
  const adapter = getAdapter(plan.harness);
  let prompt = fs.readFileSync(path.join(stateDir, 'prompt.md'), 'utf8');
  const promptFile = path.join(stateDir, 'prompt.md');
  if (prompt.length > MAX_ARGV_PROMPT) {
    prompt = `Your complete instructions are in the file ${promptFile}. Read the whole file first, then follow it.`;
  }
  const outDir = path.join(stateDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const reportDir = path.join(stateDir, 'report');
  fs.mkdirSync(reportDir, { recursive: true });

  const { args, stdin } = adapter.command({ prepared: plan.prepared, prompt, extraArgs: plan.extraArgs, workDir: plan.workDir });
  // `$env:NAME` values are references to the job environment, resolved only now.
  const planEnv = Object.fromEntries(Object.entries(plan.env ?? {}).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('$env:') ? env[v.slice(5)] ?? '' : v]));
  const childEnv = sanitizedEnv(env, {
    ...planEnv,
    HOME: plan.home,
    PWD: plan.workDir, // opencode resolves its project from $PWD, not from the process cwd
    XDG_CONFIG_HOME: path.join(plan.home, '.config'),
    XDG_DATA_HOME: path.join(plan.home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(plan.home, '.cache'),
    HARNESS_OUT: outDir,
    CI: 'true',
    NO_COLOR: '1',
  });
  core.info(`▶ ${plan.harness} ${args.slice(0, -1).filter((a) => a !== prompt).join(' ')} …`);
  const result = await runHarness({
    adapter,
    bin: plan.bin,
    args,
    stdin,
    cwd: plan.workDir,
    env: childEnv,
    executionFile: path.join(reportDir, 'execution.jsonl'),
    rawFile: path.join(reportDir, 'raw-output.log'),
    limits: plan.limits,
    showFullOutput: plan.showFullOutput,
  });
  const { acc } = result;
  const summary = {
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    killedReason: result.killedReason,
    sessionId: acc.sessionId,
    finalText: acc.finalText,
    tools: acc.tools,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cost: acc.cost,
    costKnown: acc.costKnown,
    errors: acc.errors.slice(-5),
  };
  fs.writeFileSync(path.join(stateDir, 'run.json'), JSON.stringify(summary, null, 2));
  core.info(`■ ${plan.harness}: ${result.status} in ${Math.round(result.durationMs / 1000)}s, ${acc.tools} tool calls${acc.costKnown ? `, $${acc.cost.toFixed(4)}` : ''}`);
  return summary;
}
