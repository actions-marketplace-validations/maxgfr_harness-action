// claw-code adapter (experimental) — `claw --output-format json prompt` (prompt on stdin).
// claw prints ONE JSON object when the run ends, so it is not streamed: budget and step limits
// are only checked afterwards; the timeout still applies.
import fs from 'node:fs';
import path from 'node:path';
import { cargoBuild } from './install.mjs';
import { deepMerge, isPlainObject } from '../util.mjs';

// claw's own read-only mode refuses every MCP tool (they "require workspace-write"), so the
// read-only level is workspace-write restricted to read tools + the harness MCP tools.
const PERMISSION = { 'read-only': 'workspace-write', edit: 'workspace-write', full: 'danger-full-access' };
const READ_TOOLS = ['read_file', 'glob_search', 'grep_search', 'Skill', 'ToolSearch', 'TodoWrite'];

/** claw routes on model-name prefixes; translate provider/model into that + env.
 *  Keys are `$env:NAME` references, resolved by the run step (plan.json never stores a key). */
export function modelRouting({ model, endpoint }) {
  const env = {};
  if (endpoint.custom || (endpoint.protocol === 'openai' && endpoint.provider !== 'openai')) {
    if (endpoint.protocol === 'anthropic') {
      env.ANTHROPIC_BASE_URL = endpoint.baseUrl;
      if (endpoint.keyEnv) env.ANTHROPIC_API_KEY = `$env:${endpoint.keyEnv}`;
      return { modelArg: model.id, env };
    }
    env.OPENAI_BASE_URL = endpoint.baseUrl;
    env.OPENAI_API_KEY = endpoint.keyEnv ? `$env:${endpoint.keyEnv}` : '$env:OPENAI_API_KEY';
    return { modelArg: `openai/${model.id}`, env };
  }
  if (model.provider === 'openai') return { modelArg: `openai/${model.id}`, env };
  if (model.provider === 'qwen' || model.provider === 'dashscope') return { modelArg: `qwen/${model.id}`, env };
  if (model.provider === 'kimi') return { modelArg: `kimi/${model.id}`, env };
  return { modelArg: model.id, env }; // anthropic/*, xai/* (grok-*) and aliases route by name
}

export default {
  id: 'claw',
  streaming: false,
  install({ version, toolsDir, log, meta }) {
    if (version.startsWith('/') && fs.existsSync(version)) return version; // prebuilt binary path
    return cargoBuild({ repo: meta.repo, bin: meta.bin, version, toolsDir, log });
  },

  prepare({ home, model, endpoint, perms, mcpServers, mcpToolNames = [], harnessConfig, warn }) {
    const mcp = {};
    for (const [name, s] of Object.entries(mcpServers)) {
      mcp[name] = s.url ? { type: 'http', url: s.url, headers: s.headers ?? {} } : { command: s.command, args: s.args ?? [], env: s.env ?? {} };
    }
    let config = { mcpServers: mcp };
    if (isPlainObject(harnessConfig)) config = deepMerge(config, harnessConfig);
    fs.writeFileSync(path.join(home, '.claw.json'), JSON.stringify(config, null, 2));
    if (perms.bash === 'allowlist') warn?.('claw cannot restrict bash to allow_bash patterns; shell commands need tools: full.');
    const routing = modelRouting({ model, endpoint });
    const allowed = perms.level === 'read-only' ? ['--allowedTools', [...READ_TOOLS, ...mcpToolNames.map((t) => `mcp__harness__${t}`)].join(',')] : [];
    return {
      env: routing.env,
      args: ['--model', routing.modelArg, '--output-format', 'json', '--permission-mode', PERMISSION[perms.level], ...allowed],
      files: { 'claw.json': JSON.stringify(config, null, 2) },
    };
  },

  command({ prepared, prompt, extraArgs }) {
    return { args: [...prepared.args, ...extraArgs, 'prompt', '--stdin'], stdin: prompt };
  },

  /** The whole stdout is one JSON document (or an error envelope). */
  parseAll(text) {
    let obj;
    const trimmed = text.trim();
    try { obj = JSON.parse(trimmed); } catch {
      const last = trimmed.split('\n').reverse().find((l) => l.trim().startsWith('{'));
      try { obj = JSON.parse(last ?? ''); } catch { return trimmed ? [{ t: 'error', message: trimmed.slice(-2000) }] : []; }
    }
    if (obj.error || obj.action === 'abort') return [{ t: 'error', message: `${obj.error ?? 'claw aborted'}${obj.hint ? ` (${obj.hint})` : ''}` }];
    const out = [];
    if (obj.session_id) out.push({ t: 'session', id: obj.session_id });
    const results = obj.tool_results ?? [];
    for (const r of results) {
      out.push({ t: 'tool', name: r.tool_name, input: (obj.tool_uses ?? []).find((u) => u.id === r.tool_use_id)?.input });
      out.push({ t: 'tool_result', name: r.tool_name, output: r.output, error: r.is_error ? String(r.output).slice(0, 500) : null });
    }
    const u = obj.usage ?? {};
    const cost = typeof obj.estimated_cost === 'string' ? Number(obj.estimated_cost.replace(/[^0-9.]/g, '')) : undefined;
    out.push({ t: 'usage', input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0, cost: Number.isFinite(cost) ? cost : undefined });
    if (obj.message) out.push({ t: 'text', text: obj.message });
    return out;
  },
};
