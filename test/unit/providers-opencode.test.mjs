import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEndpoint } from '../../src/harness/providers.mjs';
import { permissionProfile } from '../../src/harness/index.mjs';
import { buildConfig as opencodeConfig } from '../../src/harness/opencode.mjs';
import { buildConfig as codexConfig } from '../../src/harness/codex.mjs';
import { buildConfig as openclawConfig } from '../../src/harness/openclaw.mjs';

const base = { perms: permissionProfile('read-only'), mcpServers: {}, harnessConfig: null, workDir: '/w', skillsDir: '/s' };

test('resolveEndpoint knows the OpenCode Console providers', () => {
  assert.deepEqual(resolveEndpoint({ provider: 'opencode' }), {
    provider: 'opencode', baseUrl: 'https://opencode.ai/inference/openai/v1', keyEnv: 'OPENCODE_API_KEY', protocol: 'openai', responses: true, custom: false,
  });
  assert.deepEqual(resolveEndpoint({ provider: 'opencode-go' }), {
    provider: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', keyEnv: 'OPENCODE_API_KEY', protocol: 'openai', responses: true, custom: false,
  });
});

test('api_key_env overrides the OpenCode key', () => {
  assert.equal(resolveEndpoint({ provider: 'opencode', apiKeyEnv: 'ZEN_KEY' }).keyEnv, 'ZEN_KEY');
  assert.equal(resolveEndpoint({ provider: 'opencode-go', apiKeyEnv: 'GO_KEY' }).keyEnv, 'GO_KEY');
});

test('the opencode harness uses its native provider for opencode/<model>', () => {
  for (const provider of ['opencode', 'opencode-go']) {
    const cfg = opencodeConfig({ ...base, model: { provider, id: 'x' }, endpoint: resolveEndpoint({ provider }) });
    assert.equal(cfg.providers, undefined);
  }
});

test('codex talks to the OpenCode Responses endpoint; openclaw to its native provider', () => {
  const cfg = codexConfig({ ...base, model: { provider: 'opencode-go', id: 'x' }, endpoint: resolveEndpoint({ provider: 'opencode-go' }) });
  assert.equal(cfg.model_provider, 'opencode-go');
  assert.deepEqual(cfg.model_providers['opencode-go'], { name: 'opencode-go', base_url: 'https://opencode.ai/inference/go/openai/v1', wire_api: 'responses', env_key: 'OPENCODE_API_KEY' });
  const claw = openclawConfig({ ...base, model: { provider: 'opencode', id: 'x' }, endpoint: resolveEndpoint({ provider: 'opencode' }) });
  assert.equal(claw.agents.defaults.model, 'opencode/x');
  assert.equal(claw.models, undefined);
});
