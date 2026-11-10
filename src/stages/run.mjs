// Stage 2 (NO GitHub token in this process): run the harness from the token-free plan.
//
// One run = one or more ITERATIONS in the same harness session:
//   - loop mode (`max_iterations` > 1): after each turn, `loop_until` is checked (or, without
//     it, whether the agent called `task_complete`); if not done, the agent is re-prompted in
//     the same session with the check's output;
//   - conversation mode (`session`): the session is imported from, and exported to, a
//     directory the action caches per issue / pull request, so the next mention resumes it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as core from '../core/action.mjs';
import { getAdapter } from '../harness/index.mjs';
import { runHarness, sanitizedEnv } from '../runner.mjs';
import { readOutbox } from '../contract.mjs';
import { truncate } from '../util.mjs';

const MAX_ARGV_PROMPT = 100_000; // Linux caps one argv string at 128 KiB
export const TURN_MARKER = '<!-- harness-turn -->';

/** A harness session / thread id as the four harnesses write them (`ses_…`, a UUID). */
export const isSessionId = (id) => typeof id === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/.test(id);

/** Runs the completion check. Never throws. */
export function runCheck(command, { cwd, env, timeoutMinutes = 15 }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (c) => { out = (out + c).slice(-64_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMinutes * 60_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, output: err.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 124 : 1), output: out }); });
  });
}

export function feedbackPrompt({ check, iteration, max, resumable, original, previousText }) {
  const L = [TURN_MARKER];
  if (!resumable) {
    // a harness that cannot resume a session: restate the task and what happened.
    L.push(original, '', '## Previous attempt', '', previousText?.trim() || '_(no final message)_', '');
  }
  if (check) {
    L.push(`The completion check \`${check.command}\` failed (exit code ${check.code}) after your last turn. Its output (last 8000 characters):`, '', '```', truncate(check.output.slice(-8000), 8000), '```', '', 'Find the cause, fix it, and verify before you finish.');
  } else {
    L.push('You have not called the `task_complete` tool yet. Continue the task. When it is completely done and verified, call `task_complete` with a short summary.');
  }
  L.push('', `(iteration ${iteration} of ${max})`);
  return L.join('\n');
}

export async function run({ stateDir, env = process.env }) {
  const plan = JSON.parse(fs.readFileSync(path.join(stateDir, 'plan.json'), 'utf8'));
  const adapter = getAdapter(plan.adapterId ?? plan.harness);
  const promptFile = path.join(stateDir, 'prompt.md');
  let firstPrompt = `${TURN_MARKER}\n${fs.readFileSync(promptFile, 'utf8')}`;
  if (firstPrompt.length > MAX_ARGV_PROMPT) firstPrompt = `${TURN_MARKER}\nYour complete instructions are in the file ${promptFile}. Read the whole file first, then follow it.`;
  const outDir = path.join(stateDir, 'out');
  const reportDir = path.join(stateDir, 'report');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });

  // `$env:NAME` values are references to the job environment, resolved only now.
  const planEnv = Object.fromEntries(Object.entries(plan.env ?? {}).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('$env:') ? env[v.slice(5)] ?? '' : v]));
  const childEnv = sanitizedEnv(env, {
    ...planEnv,
    HOME: plan.home,
    PWD: plan.workDir, // opencode resolves its project from $PWD, not from the process cwd
    XDG_CONFIG_HOME: path.join(plan.home, '.config'),
    XDG_DATA_HOME: path.join(plan.home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(plan.home, '.cache'),
    XDG_STATE_HOME: path.join(plan.home, '.local', 'state'),
    HARNESS_OUT: outDir,
    CI: 'true',
    NO_COLOR: '1',
  });
  const helper = { bin: plan.bin, env: childEnv, cwd: plan.workDir, prepared: plan.prepared };

  const loop = plan.loop ?? { maxIterations: 1 };
  const session = plan.session ?? { enabled: false };
  const resumable = Boolean(adapter.resumable);
  let sessionId = null;
  let resumed = false;

  if (adapter.beforeRun) await adapter.beforeRun({ ...helper, log: core.info }).catch((err) => core.info(`beforeRun: ${err.message}`));

  if (session.enabled && resumable && session.dir) {
    const meta = path.join(session.dir, 'meta.json');
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch {}
    if (saved && saved.harness === (plan.adapterId ?? plan.harness)) {
      sessionId = await adapter.importSession({ ...helper, dir: session.dir }).catch(() => null);
      // The id comes from the saved conversation and goes on the harness command line: an id,
      // never something a CLI would read as an option.
      if (!isSessionId(sessionId)) sessionId = null;
      resumed = Boolean(sessionId);
      core.info(resumed ? `↺ Resuming the conversation (session ${sessionId}, ${saved.turns ?? '?'} earlier turn(s)).` : 'A saved conversation was found but could not be restored: starting a new session.');
    } else if (saved) {
      core.info(`The saved conversation belongs to ${saved.harness}: starting a new ${plan.harness} session.`);
    }
  }
  const followupFile = path.join(stateDir, 'followup.md');
  if (resumed && fs.existsSync(followupFile)) firstPrompt = `${TURN_MARKER}\n${fs.readFileSync(followupFile, 'utf8')}`;

  const started = Date.now();
  const total = { tools: 0, inputTokens: 0, outputTokens: 0, cost: 0, costKnown: false, errors: [] };
  const iterations = [];
  let last = null;
  let loopResult = loop.maxIterations > 1 ? 'exhausted' : 'single';
  let prompt = firstPrompt;

  try {
    for (let i = 1; i <= loop.maxIterations; i++) {
      const elapsedMin = (Date.now() - started) / 60_000;
      const limits = {
        maxSteps: Math.max(1, plan.limits.maxSteps - total.tools),
        timeoutMinutes: Math.max(0.5, plan.limits.timeoutMinutes - elapsedMin),
        budgetUsd: plan.limits.budgetUsd ? Math.max(0.000001, plan.limits.budgetUsd - total.cost) : 0,
      };
      const completesBefore = readOutbox(stateDir).filter((e) => e.kind === 'complete').length;
      const { args, stdin, sessionId: chosen } = adapter.command({ prepared: plan.prepared, prompt, extraArgs: plan.extraArgs, workDir: plan.workDir, sessionId: resumable ? sessionId : null, timeoutMinutes: limits.timeoutMinutes });
      if (chosen) sessionId = chosen; // harnesses where the action picks the session id (OpenClaw)
      if (loop.maxIterations > 1) core.info(`\n━━ iteration ${i}/${loop.maxIterations} ━━`);
      core.info(`▶ ${plan.harness} ${args.filter((a) => a !== prompt && a !== '-').join(' ').slice(0, 300)} …`);
      fs.appendFileSync(path.join(reportDir, 'execution.jsonl'), JSON.stringify({ t: 'iteration', n: i, resumed: Boolean(sessionId) }) + '\n');
      const result = await runHarness({
        adapter,
        bin: plan.bin,
        args,
        stdin,
        cwd: plan.workDir,
        env: childEnv,
        executionFile: path.join(reportDir, 'execution.jsonl'),
        rawFile: path.join(reportDir, 'raw-output.log'),
        limits,
        showFullOutput: plan.showFullOutput,
      });
      last = result;
      const { acc } = result;
      if (acc.sessionId) sessionId = acc.sessionId;
      total.tools += acc.tools;
      total.inputTokens += acc.inputTokens;
      total.outputTokens += acc.outputTokens;
      total.cost += acc.cost;
      total.costKnown ||= acc.costKnown;
      total.errors.push(...acc.errors);
      const it = { n: i, status: result.status, tools: acc.tools, durationMs: result.durationMs };
      iterations.push(it);
      if (result.status !== 'success') { loopResult = loop.maxIterations > 1 ? 'stopped' : 'single'; break; }
      if (loop.maxIterations <= 1) break;

      let check = null;
      if (loop.until) {
        core.info(`✓? completion check: ${loop.until}`);
        const r = await runCheck(loop.until, { cwd: plan.workDir, env: sanitizedEnv(env), timeoutMinutes: loop.untilTimeoutMinutes ?? 15 });
        it.check = { code: r.code };
        core.info(r.code === 0 ? '   passed' : `   failed (exit ${r.code})`);
        if (r.code === 0) { loopResult = 'passed'; break; }
        check = { command: loop.until, code: r.code, output: r.output };
      } else {
        const done = readOutbox(stateDir).filter((e) => e.kind === 'complete').length > completesBefore;
        if (done) { loopResult = 'complete'; break; }
      }
      if (i === loop.maxIterations) break;
      prompt = feedbackPrompt({ check, iteration: i + 1, max: loop.maxIterations, resumable, original: firstPrompt, previousText: acc.finalText });
    }
  } finally {
    if (session.enabled && resumable && sessionId && session.dir && last?.status !== undefined) {
      fs.mkdirSync(session.dir, { recursive: true });
      const ok = await adapter.exportSession({ ...helper, dir: session.dir, sessionId }).catch(() => false);
      if (ok) {
        let prev = {};
        try { prev = JSON.parse(fs.readFileSync(path.join(session.dir, 'meta.json'), 'utf8')); } catch {}
        // (`branch` belongs to the conversation, not to the harness session: it is kept)
        fs.writeFileSync(path.join(session.dir, 'meta.json'), JSON.stringify({ ...(prev.branch ? { branch: prev.branch } : {}), harness: plan.adapterId ?? plan.harness, sessionId, turns: (resumed ? prev.turns ?? 0 : 0) + 1, updatedAt: new Date().toISOString() }, null, 2));
        core.info(`Conversation saved (session ${sessionId}).`);
      }
    }
    await adapter.cleanup?.(helper)?.catch?.(() => {});
  }

  const acc = last?.acc;
  const summary = {
    status: last?.status ?? 'error',
    exitCode: last?.exitCode ?? 1,
    durationMs: Date.now() - started,
    killedReason: last?.killedReason ?? null,
    sessionId: sessionId ?? '',
    resumed,
    finalText: acc?.finalText ?? '',
    tools: total.tools,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cost: total.cost,
    costKnown: total.costKnown,
    errors: total.errors.slice(-5),
    iterations,
    loopResult,
    loopUntil: loop.until ?? '',
  };
  fs.writeFileSync(path.join(stateDir, 'run.json'), JSON.stringify(summary, null, 2));
  core.info(`■ ${plan.harness}: ${summary.status}${iterations.length > 1 ? ` after ${iterations.length} iterations (${loopResult})` : ''} in ${Math.round(summary.durationMs / 1000)}s, ${total.tools} tool calls${total.costKnown ? `, $${total.cost.toFixed(4)}` : ''}`);
  return summary;
}
