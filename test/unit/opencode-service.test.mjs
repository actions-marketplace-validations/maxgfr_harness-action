import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import opencode, { freePort } from '../../src/harness/opencode.mjs';

const bind = (port) => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});

test('freePort: a port of 127.0.0.1 that can be bound', async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, String(port));
  assert.equal(await bind(port), true);
});

/** A fake `opencode` that logs its arguments; `service start` reports the port in use `busy` times. */
function fakeBin(busy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fake-'));
  const log = path.join(dir, 'calls.log');
  const count = path.join(dir, 'starts');
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1 $2" = "service start" ]; then
  n=$(cat "${count}" 2>/dev/null || echo 0); echo $((n + 1)) > "${count}"
  if [ "$n" -lt ${busy} ]; then echo "Error: Managed service port 1 on 127.0.0.1 is already in use by PID 1" >&2; exit 1; fi
fi
exit 0
`, { mode: 0o755 });
  return { bin, dir, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

const before = (bin, dir) => opencode.beforeRun({ bin, env: { PATH: process.env.PATH }, cwd: dir, prepared: { mcpNames: [] } });

test('opencode: the service gets its own port before it starts', async () => {
  const { bin, dir, calls } = fakeBin(0);
  assert.equal(await before(bin, dir), true);
  const c = calls();
  assert.match(c[0], /^service set port \d+$/);
  assert.equal(c[1], 'service start');
  assert.equal(c[2], 'mcp list');
  assert.equal(c.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('opencode: a port taken before the service binds it is retried once on another', async () => {
  const { bin, dir, calls } = fakeBin(5);
  await before(bin, dir);
  const c = calls();
  assert.deepEqual(c.map((l) => l.replace(/\d+$/, 'N')), ['service set port N', 'service start', 'service set port N', 'service start', 'mcp list']);
  fs.rmSync(dir, { recursive: true, force: true });
});
