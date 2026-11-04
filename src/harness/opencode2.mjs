// OpenCode 2 adapter (@opencode/cli 2.x) — `opencode run --format json --auto`.
//
// Differences with OpenCode 1 that matter here:
// - config: `providers` (package/settings/env), ordered `permissions` rules (last match wins,
//   `shell` replaces `bash`), MCP servers under `mcp.servers` with `environment`;
// - MCP tools are only exposed through the background service: `run --standalone` connects
//   the servers but never offers their tools. So the run uses the service, inside the run's
//   isolated HOME/XDG tree, and stops it afterwards;
// - the service connects MCP servers ASYNCHRONOUSLY, and a session only gets the tools of the
//   servers connected when it is created: the service is started first, and the run waits for
//   `mcp list` to show every server connected;
// - the service is discovered through $TMPDIR, so the run gets its own TMPDIR (otherwise a
//   service started by another run, with another config, would be reused);
// - `codemode: false` puts the MCP tools in the model's tool list (`harness_<tool>`) instead
//   of behind the Code Mode `execute` tool.
// The JSON event stream is the same as OpenCode 1, so the parser is shared.
import fs from 'node:fs';
import path from 'node:path';
import { npmInstall } from './install.mjs';
import { deepMerge, isPlainObject } from '../util.mjs';
import v1 from './opencode.mjs';
import { capture } from './exec.mjs';

const rule = (action, resource, effect) => ({ action, resource, effect });

/** `opencode mcp list` shows every server in a final state (`✓ name  connected`, failed…). */
export function mcpReady(output, names) {
  return names.every((n) => new RegExp(`^\\s*\\S*\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(connected|failed|error|disabled|needs[_ ]auth)`, 'mi').test(output));
}

export function permissionRules(perms) {
  const rules = [
    rule('*', '*', 'allow'),
    rule('question', '*', 'deny'), // nobody is there to answer
    rule('read', '*.env', 'deny'),
    rule('read', '*.env.*', 'deny'),
    rule('read', '*.env.example', 'allow'),
  ];
  if (!perms.edit) rules.push(rule('edit', '*', 'deny'));
  if (perms.bash === 'none') rules.push(rule('shell', '*', 'deny'));
  if (perms.bash === 'allowlist') rules.push(rule('shell', '*', 'deny'), ...perms.allowBash.map((g) => rule('shell', g, 'allow')));
  if (!perms.web) rules.push(rule('webfetch', '*', 'deny'), rule('websearch', '*', 'deny'));
  return rules;
}

export function buildConfig({ model, endpoint, perms, mcpServers, harnessConfig }) {
  const servers = {};
  for (const [name, s] of Object.entries(mcpServers)) {
    servers[name] = s.url
      ? { type: 'remote', url: s.url, headers: s.headers ?? {}, codemode: false }
      : { type: 'local', command: [s.command, ...(s.args ?? [])], environment: s.env ?? {}, codemode: false };
  }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    update: 'disable',
    share: 'disabled',
    permissions: permissionRules(perms),
    mcp: { servers },
  };
  if (endpoint.custom) {
    config.providers = {
      [endpoint.provider]: {
        name: endpoint.provider,
        package: endpoint.protocol === 'anthropic' ? '@opencode/ai/providers/anthropic' : '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: endpoint.baseUrl },
        ...(endpoint.keyEnv ? { env: [endpoint.keyEnv] } : {}),
        models: { [model.id]: { name: model.id } },
      },
    };
  }
  return isPlainObject(harnessConfig) ? deepMerge(config, harnessConfig) : config;
}

export default {
  id: 'opencode',
  streaming: true,
  resumable: true,
  install: ({ version, toolsDir, log, meta }) => npmInstall({ pkg: meta.package, bin: meta.bin, version, toolsDir, log }),

  prepare(opts) {
    const { model, endpoint, home } = opts;
    if (!model.provider && !endpoint.custom) throw new Error('opencode needs `model` as provider/model, e.g. anthropic/claude-sonnet-5-5');
    const config = buildConfig(opts);
    const dir = path.join(home, '.config', 'opencode'); // XDG_CONFIG_HOME of the run
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(config, null, 2));
    const tmp = path.join(home, '.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    return {
      env: { TMPDIR: tmp },
      modelArg: `${endpoint.custom ? endpoint.provider : model.provider}/${model.id}`,
      mcpNames: Object.keys(config.mcp.servers),
      files: { 'opencode.json': JSON.stringify(config, null, 2) },
    };
  },

  /** Start the service and wait until every MCP server has connected (or failed). */
  async beforeRun({ bin, env, cwd, prepared, log = () => {} }) {
    await capture(bin, ['service', 'start'], { env, cwd, timeoutMs: 60_000 });
    const names = prepared.mcpNames ?? [];
    const deadline = Date.now() + 60_000;
    let last = '';
    while (Date.now() < deadline) {
      last = (await capture(bin, ['mcp', 'list'], { env, cwd, timeoutMs: 30_000 })).stdout;
      if (mcpReady(last, names)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    log(`OpenCode: MCP servers not all connected after 60s:\n${last.trim()}`);
    return false;
  },

  command({ prepared, prompt, extraArgs, sessionId }) {
    return { args: ['run', '--format', 'json', '--auto', '-m', prepared.modelArg, ...(sessionId ? ['-s', sessionId] : []), ...extraArgs, prompt], stdin: null };
  },

  parse: v1.parse,

  async importSession({ bin, env, cwd, dir }) {
    const file = path.join(dir, 'opencode-session.json');
    const meta = path.join(dir, 'meta.json');
    if (!fs.existsSync(file) || !fs.existsSync(meta)) return null;
    const { sessionId } = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const r = await capture(bin, ['session', 'import', file], { env, cwd });
    return r.code === 0 ? sessionId : null;
  },

  async exportSession({ bin, env, cwd, dir, sessionId }) {
    const r = await capture(bin, ['session', 'export', sessionId], { env, cwd });
    const start = r.stdout.indexOf('{');
    if (r.code !== 0 || start < 0) return false;
    fs.writeFileSync(path.join(dir, 'opencode-session.json'), r.stdout.slice(start));
    return true;
  },

  async cleanup({ bin, env, cwd }) {
    await capture(bin, ['service', 'stop'], { env, cwd, timeoutMs: 30_000 });
  },
};
