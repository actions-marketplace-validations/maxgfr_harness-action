// Codex adapter — `codex exec --json` with a private CODEX_HOME/config.toml.
import fs from 'node:fs';
import path from 'node:path';
import { npmInstall } from './install.mjs';
import { deepMerge, isPlainObject, toToml } from '../util.mjs';

const SANDBOX = { 'read-only': 'read-only', edit: 'workspace-write', full: 'danger-full-access' };

export function buildConfig({ model, endpoint, perms, mcpServers, harnessConfig, workDir }) {
  const cfg = {
    model: model.id,
    approval_policy: 'never',
    sandbox_mode: SANDBOX[perms.level],
    check_for_update_on_startup: false,
  };
  if (perms.level === 'edit') cfg.sandbox_workspace_write = { network_access: false };
  if (endpoint.provider && endpoint.provider !== 'openai' || endpoint.custom) {
    if (endpoint.protocol === 'anthropic') {
      throw new Error('codex only speaks OpenAI-compatible APIs. Use an OpenAI-compatible endpoint (e.g. openrouter/anthropic/<model>) or another harness for Anthropic models.');
    }
    if (!endpoint.baseUrl) throw new Error(`codex does not know provider "${endpoint.provider}". Set base_url (and api_key_env) for it.`);
    const id = endpoint.custom ? 'custom' : endpoint.provider;
    cfg.model_provider = id;
    cfg.model_providers = { [id]: { name: endpoint.provider, base_url: endpoint.baseUrl, wire_api: 'responses', ...(endpoint.keyEnv ? { env_key: endpoint.keyEnv } : {}) } };
  }
  cfg.mcp_servers = {};
  for (const [name, s] of Object.entries(mcpServers)) {
    cfg.mcp_servers[name] = s.url
      ? { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}), default_tools_approval_mode: 'approve' }
      : { command: s.command, args: s.args ?? [], env: s.env ?? {}, default_tools_approval_mode: 'approve' };
  }
  cfg.projects = { [workDir]: { trust_level: 'trusted' } };
  return isPlainObject(harnessConfig) ? deepMerge(cfg, harnessConfig) : cfg;
}

const TABLE_HEADER = /^[ \t]*\[\[?[^[\]\n]+\]\]?[ \t]*(?:#[^\n]*)?$/m;

/**
 * `harness_config` given as TOML, merged with the generated configuration without a TOML parser.
 * In TOML a key belongs to the last table header above it, so the user's top-level keys must come
 * before the first generated table: appended at the end they would silently become keys of
 * `[projects."<dir>"]`. They win over a generated key of the same name; the user's tables go last.
 */
export function withUserToml(generated, user) {
  const split = (text) => { const m = TABLE_HEADER.exec(text); const i = m ? m.index : text.length; return [text.slice(0, i).trim(), text.slice(i).trim()]; };
  const [head, tables] = split(generated);
  const [userHead, userTables] = split(user);
  const overridden = new Set([...userHead.matchAll(/^[ \t]*([A-Za-z0-9_-]+)[ \t]*=/gm)].map((m) => m[1]));
  const kept = head.split('\n').filter((line) => !overridden.has(/^([A-Za-z0-9_-]+) = /.exec(line)?.[1])).join('\n');
  return `${[kept, userHead, tables, userTables].filter(Boolean).join('\n\n')}\n`;
}

export default {
  id: 'codex',
  streaming: true,
  install: ({ version, toolsDir, log, meta }) => npmInstall({ pkg: meta.package, bin: meta.bin, version, toolsDir, log }),

  prepare(opts) {
    const cfg = buildConfig(opts);
    let toml = toToml(cfg, { inline: [/^mcp_servers\.[^.]+\.(env|http_headers)$/] });
    if (typeof opts.harnessConfig === 'string') toml = withUserToml(toml, opts.harnessConfig);
    const codexHome = path.join(opts.stateDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), toml);
    const env = { CODEX_HOME: codexHome };
    // `codex exec` authenticates with CODEX_API_KEY when no login is stored.
    // (a `$env:NAME` reference, resolved by the run step: plan.json never stores a key)
    if (!opts.endpoint.custom && (!opts.endpoint.provider || opts.endpoint.provider === 'openai') && !process.env.CODEX_API_KEY && process.env.OPENAI_API_KEY) {
      env.CODEX_API_KEY = '$env:OPENAI_API_KEY';
    }
    return { env, codexHome, files: { 'codex-config.toml': toml } };
  },

  // Sessions are kept (no --ephemeral) in the private CODEX_HOME, so a loop iteration or a
  // later run can `exec resume` the same thread.
  command({ prompt, extraArgs, workDir, sessionId }) {
    const base = ['exec', '--json', '--skip-git-repo-check', '-C', workDir, ...extraArgs];
    return { args: sessionId ? [...base, 'resume', sessionId, '-'] : [...base, '-'], stdin: prompt };
  },

  resumable: true,

  async importSession({ dir, prepared }) {
    const saved = path.join(dir, 'codex-sessions');
    const meta = path.join(dir, 'meta.json');
    if (!fs.existsSync(saved) || !fs.existsSync(meta)) return null;
    fs.cpSync(saved, path.join(prepared.codexHome, 'sessions'), { recursive: true });
    return JSON.parse(fs.readFileSync(meta, 'utf8')).sessionId ?? null;
  },

  async exportSession({ dir, prepared }) {
    const sessions = path.join(prepared.codexHome, 'sessions');
    if (!fs.existsSync(sessions)) return false;
    fs.rmSync(path.join(dir, 'codex-sessions'), { recursive: true, force: true });
    fs.cpSync(sessions, path.join(dir, 'codex-sessions'), { recursive: true });
    return true;
  },

  parse(obj) {
    const item = obj.item ?? {};
    switch (obj.type) {
      case 'thread.started':
        return [{ t: 'session', id: obj.thread_id }];
      case 'item.started':
        if (item.type === 'command_execution') return [{ t: 'tool', name: 'shell', input: { command: item.command } }];
        if (item.type === 'mcp_tool_call') return [{ t: 'tool', name: `${item.server}.${item.tool}`, input: item.arguments }];
        if (item.type === 'web_search') return [{ t: 'tool', name: 'web_search', input: { query: item.query } }];
        return [];
      case 'item.completed':
        switch (item.type) {
          case 'agent_message': return item.text ? [{ t: 'text', text: item.text }] : [];
          case 'command_execution': return [{ t: 'tool_result', name: 'shell', output: item.aggregated_output ?? '', error: item.exit_code && item.exit_code !== 0 ? `exit ${item.exit_code}` : null }];
          case 'mcp_tool_call': return [{ t: 'tool_result', name: `${item.server}.${item.tool}`, output: item.result, error: item.error?.message ?? null }];
          case 'file_change': return [{ t: 'tool', name: 'apply_patch', input: { changes: item.changes } }, { t: 'tool_result', name: 'apply_patch', output: item.status, error: item.status === 'failed' ? 'patch failed' : null }];
          case 'error': return [{ t: 'warning', message: item.message }];
          default: return [];
        }
      case 'turn.completed': {
        const u = obj.usage ?? {};
        return [{ t: 'usage', input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) }];
      }
      case 'turn.failed':
        return [{ t: 'error', message: obj.error?.message ?? 'turn failed' }];
      case 'error':
        // "Reconnecting... n/5" is transient; turn.failed carries the fatal one.
        return [{ t: 'warning', message: obj.message }];
      default:
        return [];
    }
  },
};
