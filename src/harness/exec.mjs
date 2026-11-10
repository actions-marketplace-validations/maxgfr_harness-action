// Run a short helper command of a harness (session import/export, service stop…).
import { spawn } from 'node:child_process';

export function capture(bin, args, { env, cwd, timeoutMs = 120_000, stdin = null } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 127, stdout, stderr: err.message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => {}); // the command exited without reading it: its exit code tells
    child.stdin.end(stdin ?? undefined);
  });
}
