// OpenCode adapter — `opencode run --format json`.
// Config is injected with OPENCODE_CONFIG_CONTENT (merged on top of the repository's own).
import { npmInstall } from './install.mjs';
import { deepMerge, isPlainObject } from '../util.mjs';

function bashPermission(perms) {
  if (perms.bash === 'all') return 'allow';
  if (perms.bash === 'none') return 'deny';
  return Object.fromEntries([['*', 'deny'], ...perms.allowBash.map((g) => [g, 'allow'])]);
}

export function buildConfig({ model, endpoint, perms, mcpServers, harnessConfig }) {
  const mcp = {};
  for (const [name, s] of Object.entries(mcpServers)) {
    mcp[name] = s.url
      ? { type: 'remote', url: s.url, headers: s.headers ?? {}, enabled: true }
      : { type: 'local', command: [s.command, ...(s.args ?? [])], environment: s.env ?? {}, enabled: true };
  }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    permission: {
      edit: perms.edit ? 'allow' : 'deny',
      bash: bashPermission(perms),
      webfetch: perms.web ? 'allow' : 'deny',
      external_directory: 'allow', // installed skills live outside the workspace
      doom_loop: 'deny',
    },
    mcp,
  };
  if (endpoint.custom) {
    config.provider = {
      [endpoint.provider]: {
        npm: endpoint.protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
        name: endpoint.provider,
        options: { baseURL: endpoint.baseUrl, ...(endpoint.keyEnv ? { apiKey: `{env:${endpoint.keyEnv}}` } : { apiKey: 'none' }) },
        models: { [model.id]: { name: model.id } },
      },
    };
  }
  return isPlainObject(harnessConfig) ? deepMerge(config, harnessConfig) : config;
}

export default {
  id: 'opencode',
  streaming: true,
  install: ({ version, toolsDir, log, meta }) => npmInstall({ pkg: meta.package, bin: meta.bin, version, toolsDir, log }),

  prepare(opts) {
    const { model, endpoint } = opts;
    if (!model.provider && !endpoint.custom) throw new Error('opencode needs `model` as provider/model, e.g. anthropic/claude-sonnet-5-5');
    const config = buildConfig(opts);
    return {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true' },
      modelArg: `${endpoint.custom ? endpoint.provider : model.provider}/${model.id}`,
      files: { 'opencode.json': JSON.stringify(config, null, 2) },
    };
  },

  command({ prepared, prompt, extraArgs }) {
    return { args: ['run', '--format', 'json', '-m', prepared.modelArg, ...extraArgs, prompt], stdin: null };
  },

  parse(obj) {
    const p = obj.part ?? {};
    switch (obj.type) {
      case 'step_start':
        return obj.sessionID ? [{ t: 'session', id: obj.sessionID }] : [];
      case 'text':
        return p.text ? [{ t: 'text', text: p.text }] : [];
      case 'tool_use': {
        const st = p.state ?? {};
        const out = [{ t: 'tool', name: p.tool, input: st.input }];
        if (st.status === 'completed' || st.status === 'error') out.push({ t: 'tool_result', name: p.tool, output: st.output ?? '', error: st.status === 'error' ? st.error ?? 'error' : null });
        return out;
      }
      case 'step_finish': {
        const tk = p.tokens ?? {};
        return [{ t: 'usage', input: (tk.input ?? 0) + (tk.cache?.read ?? 0), output: (tk.output ?? 0) + (tk.reasoning ?? 0), cost: typeof p.cost === 'number' ? p.cost : undefined }];
      }
      case 'error':
        return [{ t: 'error', message: obj.error?.data?.message ?? obj.error?.message ?? obj.error?.name ?? 'opencode error' }];
      default:
        return [];
    }
  },
};
