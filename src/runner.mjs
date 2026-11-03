// Spawns the harness, normalises its output, enforces the limits of an unattended run.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createAccumulator } from './harness/index.mjs';
import { truncate, sanitizedEnv } from './util.mjs';

export { sanitizedEnv };

/** Split a byte stream on LF only (pi's JSONL may contain U+2028 inside strings). */
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    },
    end() { if (buf) onLine(buf); buf = ''; },
  };
}

function describe(ev) {
  switch (ev.t) {
    case 'text': return `💬 ${truncate(ev.text.replace(/\s+/g, ' '), 300)}`;
    case 'tool': return `🔧 ${ev.name} ${truncate(JSON.stringify(ev.input ?? {}), 200)}`;
    case 'tool_result': return ev.error ? `   ✗ ${ev.name}: ${truncate(ev.error, 200)}` : null;
    case 'error': return `❌ ${ev.message}`;
    case 'warning': return `⚠️  ${ev.message}`;
    default: return null;
  }
}

/**
 * @returns {Promise<{status, exitCode, durationMs, acc, killedReason}>}
 *   status: success | error | timeout | budget | max_steps
 */
export function runHarness({ adapter, bin, args, stdin, cwd, env, executionFile, rawFile, limits, log = (l) => process.stdout.write(l + '\n'), showFullOutput = false }) {
  return new Promise((resolve) => {
    const acc = createAccumulator();
    const started = Date.now();
    const exec = fs.openSync(executionFile, 'a');
    const raw = rawFile ? fs.openSync(rawFile, 'a') : null;
    let killedReason = null;
    let lastErrorIndex = -1;
    let eventIndex = 0;
    let lastTextIndex = -1;

    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

    const kill = (reason) => {
      if (killedReason) return;
      killedReason = reason;
      log(`⛔ stopping the harness: ${reason}`);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10_000).unref();
    };

    const emit = (ev) => {
      fs.writeSync(exec, JSON.stringify({ ...ev, at: Date.now() - started }) + '\n');
      acc.push(ev);
      eventIndex++;
      if (ev.t === 'error') lastErrorIndex = eventIndex;
      if (ev.t === 'text') lastTextIndex = eventIndex;
      if (!showFullOutput) { const d = describe(ev); if (d) log(d); }
      if (limits.maxSteps && acc.tools > limits.maxSteps) kill(`more than ${limits.maxSteps} tool calls (max_steps)`);
      if (limits.budgetUsd && acc.costKnown && acc.cost > limits.budgetUsd) kill(`cost $${acc.cost.toFixed(4)} exceeds budget_usd $${limits.budgetUsd}`);
    };

    let stdoutAll = '';
    const lines = lineSplitter((line) => {
      if (raw) fs.writeSync(raw, line + '\n');
      if (showFullOutput) log(line);
      if (!adapter.streaming) { stdoutAll += line + '\n'; return; }
      if (!line.trim().startsWith('{')) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      for (const ev of adapter.parse(obj)) emit(ev);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => lines.push(c));
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderrTail = (stderrTail + c).slice(-8000);
      if (showFullOutput) process.stderr.write(c);
    });

    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();

    const timer = setTimeout(() => kill(`timeout after ${limits.timeoutMinutes} min (timeout_minutes)`), limits.timeoutMinutes * 60_000);
    timer.unref();

    child.on('error', (err) => {
      emit({ t: 'error', message: `cannot start ${bin}: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      lines.end();
      if (!adapter.streaming) {
        for (const ev of adapter.parseAll(stdoutAll)) emit(ev);
        if (limits.budgetUsd && acc.costKnown && acc.cost > limits.budgetUsd && !killedReason) killedReason = `cost $${acc.cost.toFixed(4)} exceeds budget_usd $${limits.budgetUsd}`;
      }
      const exitCode = code ?? (signal ? 128 : 1);
      if (exitCode !== 0 && !acc.errors.length && !killedReason) {
        emit({ t: 'error', message: `${adapter.id} exited with code ${exitCode}${stderrTail ? `: ${truncate(stderrTail.trim().split('\n').slice(-5).join(' | '), 600)}` : ''}` });
      }
      // A provider error the harness recovered from (a retry that produced an answer) is not fatal.
      const fatalError = lastErrorIndex > lastTextIndex;
      let status = 'success';
      if (killedReason) status = /timeout/.test(killedReason) ? 'timeout' : /budget/.test(killedReason) ? 'budget' : 'max_steps';
      else if (exitCode !== 0 || fatalError || (!acc.finalText && acc.errors.length)) status = 'error';
      fs.closeSync(exec);
      if (raw) fs.closeSync(raw);
      resolve({ status, exitCode, durationMs: Date.now() - started, acc, killedReason, stderrTail });
    });
  });
}
