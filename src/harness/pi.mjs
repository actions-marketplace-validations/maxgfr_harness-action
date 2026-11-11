// Pi adapter — `pi --mode json --session-dir <dir>` with a private PI_CODING_AGENT_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { npmInstall } from './install.mjs';
import { deepMerge, isPlainObject } from '../util.mjs';

export function toolList(perms) {
  const tools = ['read', 'grep', 'find', 'ls'];
  if (perms.edit) tools.push('edit', 'write');
  if (perms.bash !== 'none') tools.push('bash'); // pi cannot restrict bash to patterns
  tools.push('mcp__*'); // an explicit allow-list drops MCP tools otherwise
  return tools;
}

export default {
  id: 'pi',
  streaming: true,
  install: ({ version, toolsDir, log, meta }) => npmInstall({ pkg: meta.package, bin: meta.bin, version, toolsDir, log }),

  prepare({ stateDir, model, endpoint, perms, mcpServers, harnessConfig, warn }) {
    const agentDir = path.join(stateDir, 'pi-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const files = {};
    const mcp = { mcpServers: {} };
    for (const [name, s] of Object.entries(mcpServers)) {
      mcp.mcpServers[name] = s.url
        ? { url: s.url, headers: s.headers ?? {}, exposure: 'direct' }
        : { command: s.command, args: s.args ?? [], env: s.env ?? {}, exposure: 'direct' };
    }
    files['mcp.json'] = mcp;
    let provider = model.provider;
    if (endpoint.custom) {
      provider = endpoint.provider;
      files['models.json'] = {
        providers: {
          [provider]: {
            baseUrl: endpoint.baseUrl,
            api: endpoint.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
            apiKey: endpoint.keyEnv ? `$${endpoint.keyEnv}` : 'none',
            models: [{ id: model.id }],
          },
        },
      };
    }
    if (isPlainObject(harnessConfig)) {
      for (const [file, content] of Object.entries(harnessConfig)) {
        files[file] = isPlainObject(files[file]) && isPlainObject(content) ? deepMerge(files[file], content) : content;
      }
    }
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(agentDir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    if (perms.bash === 'allowlist') warn?.('pi cannot restrict bash to allow_bash patterns: the bash tool is enabled as a whole.');
    const modelArgs = provider ? ['--provider', provider, '--model', model.id] : ['--model', model.id];
    const sessionDir = path.join(stateDir, 'pi-sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    return {
      env: { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: '1' },
      args: [...modelArgs, '--tools', toolList(perms).join(',')],
      sessionDir,
      files: Object.fromEntries(Object.entries(files).map(([k, v]) => [`pi-${k}`, typeof v === 'string' ? v : JSON.stringify(v, null, 2)])),
    };
  },

  // Sessions live in a private --session-dir, so a loop iteration or a later run can reopen
  // the same session by id.
  command({ prepared, prompt, extraArgs, sessionId }) {
    return { args: ['--mode', 'json', '--session-dir', prepared.sessionDir, ...(sessionId ? ['--session', sessionId] : []), ...prepared.args, ...extraArgs, prompt], stdin: null };
  },


  async importSession({ dir, prepared }) {
    const saved = path.join(dir, 'pi-sessions');
    const meta = path.join(dir, 'meta.json');
    if (!fs.existsSync(saved) || !fs.existsSync(meta)) return null;
    fs.cpSync(saved, prepared.sessionDir, { recursive: true });
    return JSON.parse(fs.readFileSync(meta, 'utf8')).sessionId ?? null;
  },

  async exportSession({ dir, prepared }) {
    if (!fs.existsSync(prepared.sessionDir)) return false;
    fs.rmSync(path.join(dir, 'pi-sessions'), { recursive: true, force: true });
    fs.cpSync(prepared.sessionDir, path.join(dir, 'pi-sessions'), { recursive: true });
    return true;
  },

  parse(obj) {
    switch (obj.type) {
      case 'session':
        return [{ t: 'session', id: obj.id }];
      case 'tool_execution_start':
        return [{ t: 'tool', name: obj.toolName, input: obj.args }];
      case 'tool_execution_end': {
        const text = (obj.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        return [{ t: 'tool_result', name: obj.toolName, output: text, error: obj.isError ? text || 'error' : null }];
      }
      case 'message_end': {
        const m = obj.message ?? {};
        if (m.role !== 'assistant') return [];
        const out = [];
        const text = (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (text) out.push({ t: 'text', text });
        const u = m.usage;
        if (u) out.push({ t: 'usage', input: (u.input ?? 0) + (u.cacheRead ?? 0), output: u.output ?? 0, cost: typeof u.cost?.total === 'number' ? u.cost.total : undefined });
        if (m.stopReason === 'error' || m.errorMessage) out.push({ t: 'error', message: m.errorMessage ?? 'pi: model call failed' });
        return out;
      }
      default:
        return [];
    }
  },
};
