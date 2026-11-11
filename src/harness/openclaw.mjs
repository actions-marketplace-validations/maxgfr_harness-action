// OpenClaw adapter (npm `openclaw`) — `openclaw agent --local --session-id <id> --json`.
//
// - `agent exec` cannot resume a session, `agent --local --session-id` can: the action picks the
//   session id itself (a UUID) for the first turn and passes it again for every later turn.
// - Config lives in the isolated HOME (~/.openclaw/openclaw.json); sessions in ~/.openclaw/state
//   (SQLite) and ~/.openclaw/agents, which export/import copy.
// - `tools.toolSearch: false`: otherwise MCP tools hide behind tool_search/tool_describe.
// - MCP tools are named `<server>__<tool>`; the shell tool is `exec`.
// - It prints ONE JSON document when the turn ends (not streamed) and exits 1 on failure, with
//   the reason on stderr.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { npmInstall } from './install.mjs';
import { deepMerge, isPlainObject } from '../util.mjs';

const WRITE_TOOLS = ['write', 'edit', 'apply_patch'];
const SHELL_TOOLS = ['exec', 'process'];
const WEB_TOOLS = ['web_fetch', 'web_search', 'browser'];
// Assistant features that make no sense in a CI job (messaging, automations, other sessions…).
const UNUSED_TOOLS = ['ask_user', 'automations', 'conversations_send', 'conversations_turn', 'sessions_send', 'sessions_spawn', 'message', 'gateway', 'portal', 'presence', 'dashboard', 'secrets', 'plugins'];

const STATE_PARTS = ['state', 'agents'];

export function buildConfig({ model, endpoint, perms, mcpServers, harnessConfig, workDir, skillsDir }) {
  const deny = [...UNUSED_TOOLS];
  if (!perms.edit) deny.push(...WRITE_TOOLS);
  if (perms.bash === 'none') deny.push(...SHELL_TOOLS);
  if (!perms.web) deny.push(...WEB_TOOLS);
  const servers = {};
  for (const [name, s] of Object.entries(mcpServers)) {
    servers[name] = s.url
      ? { url: s.url, transport: 'streamable-http', headers: s.headers ?? {} }
      : { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  }
  const providerId = endpoint.custom ? endpoint.provider : model.provider;
  const config = {
    // `skipBootstrap`: the workspace is the repository checkout. Without it OpenClaw seeds the
    // workspace with its assistant files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md), which then
    // look like changes made by the agent and get committed.
    agents: { defaults: { model: `${providerId}/${model.id}`, workspace: workDir, skipBootstrap: true } },
    mcp: { servers },
    skills: { load: { extraDirs: [skillsDir] } },
    tools: {
      profile: 'coding',
      toolSearch: false,
      deny,
      exec: { mode: perms.bash === 'none' ? 'deny' : 'full' }, // (`mode` excludes `security` / `ask`)
    },
  };
  if (endpoint.custom) {
    config.models = {
      providers: {
        [endpoint.provider]: {
          baseUrl: endpoint.baseUrl,
          api: endpoint.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
          // a reference to the job environment: the key itself is never written to the config
          apiKey: endpoint.keyEnv ? { source: 'env', provider: 'env', id: endpoint.keyEnv } : 'none',
          models: [{ id: model.id, name: model.id }],
        },
      },
    };
    if (endpoint.keyEnv) config.secrets = { providers: { env: { source: 'env' } } };
  }
  return isPlainObject(harnessConfig) ? deepMerge(config, harnessConfig) : config;
}

export default {
  id: 'openclaw',
  validate({ model, endpoint }) {
    if (!model.provider && !endpoint.custom) throw new Error('openclaw needs `model` as provider/model, e.g. anthropic/claude-sonnet-5-5');
  },
  streaming: false,
  resumable: true,
  install: ({ version, toolsDir, log, meta }) => npmInstall({ pkg: meta.package, bin: meta.bin, version, toolsDir, log }),

  prepare({ home, workDir, model, endpoint, perms, mcpServers, harnessConfig, warn }) {
    this.validate({ model, endpoint });
    const dir = path.join(home, '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    const config = buildConfig({ model, endpoint, perms, mcpServers, harnessConfig, workDir, skillsDir: path.join(home, '.agents', 'skills') });
    fs.writeFileSync(path.join(dir, 'openclaw.json'), JSON.stringify(config, null, 2));
    if (perms.bash === 'allowlist') warn?.('openclaw cannot restrict its exec tool to allow_bash patterns: shell commands are enabled as a whole.');
    return {
      env: { OPENCLAW_NO_UPDATE_CHECK: '1' },
      openclawDir: dir,
      newSessionId: crypto.randomUUID(),
      files: { 'openclaw.json': JSON.stringify(config, null, 2) },
    };
  },

  command({ prepared, prompt, extraArgs, sessionId, timeoutMinutes }) {
    const id = sessionId || prepared.newSessionId;
    const timeout = String(Math.max(30, Math.round((timeoutMinutes ?? 30) * 60)));
    return { args: ['agent', '--local', '--session-id', id, '--json', '--timeout', timeout, ...extraArgs, '--message', prompt], stdin: null, sessionId: id };
  },

  parseAll(text) {
    const trimmed = text.trim();
    let obj;
    try { obj = JSON.parse(trimmed); } catch {
      const start = trimmed.indexOf('{');
      try { obj = JSON.parse(trimmed.slice(start)); } catch { return trimmed ? [{ t: 'error', message: trimmed.slice(-2000) }] : []; }
    }
    // valid JSON that is not the result document (`null`, a number, a string)
    if (obj === null || typeof obj !== 'object') return [{ t: 'error', message: `openclaw printed no result: ${trimmed.slice(-2000)}` }];
    if (obj.ok === false || obj.error) {
      const issues = (obj.issues ?? []).map((i) => `${i.path}: ${i.message}`).join('; ');
      return [{ t: 'error', message: `${obj.error?.message ?? 'openclaw failed'}${issues ? ` (${issues})` : ''}` }];
    }
    const meta = obj.meta ?? {};
    const am = meta.agentMeta ?? {};
    const out = [];
    if (am.sessionId) out.push({ t: 'session', id: am.sessionId });
    const ts = meta.toolSummary;
    for (const name of ts?.tools ?? []) {
      out.push({ t: 'tool', name, input: undefined });
      out.push({ t: 'tool_result', name, output: '', error: null });
    }
    // toolSummary lists distinct names; account for repeated calls
    for (let i = ts?.tools?.length ?? 0; i < (ts?.calls ?? 0); i++) out.push({ t: 'tool', name: '(repeated)', input: undefined });
    const u = am.usage ?? {};
    out.push({ t: 'usage', input: (u.input ?? 0) + (u.cacheRead ?? 0), output: u.output ?? 0, cost: typeof u.cost?.total === 'number' ? u.cost.total : undefined });
    const text2 = (obj.payloads ?? []).map((p) => p.text).filter(Boolean).join('\n\n');
    if (text2) out.push({ t: 'text', text: text2 });
    if (meta.error) out.push({ t: 'error', message: typeof meta.error === 'string' ? meta.error : meta.error.message ?? 'openclaw error' });
    else if (meta.aborted) out.push({ t: 'error', message: `openclaw aborted (${meta.stopReason ?? 'unknown'})` });
    return out;
  },

  async importSession({ dir, prepared }) {
    const saved = path.join(dir, 'openclaw');
    const meta = path.join(dir, 'meta.json');
    if (!fs.existsSync(saved) || !fs.existsSync(meta)) return null;
    for (const part of STATE_PARTS) {
      if (fs.existsSync(path.join(saved, part))) fs.cpSync(path.join(saved, part), path.join(prepared.openclawDir, part), { recursive: true });
    }
    return JSON.parse(fs.readFileSync(meta, 'utf8')).sessionId ?? null;
  },

  async exportSession({ dir, prepared }) {
    const saved = path.join(dir, 'openclaw');
    fs.rmSync(saved, { recursive: true, force: true });
    let any = false;
    for (const part of STATE_PARTS) {
      const src = path.join(prepared.openclawDir, part);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(saved, part), { recursive: true });
      any = true;
    }
    return any;
  },
};
