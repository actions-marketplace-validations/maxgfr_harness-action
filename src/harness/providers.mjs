// Known providers, for harnesses that need an explicit endpoint (Codex) or a custom one.
// `responses`: the provider serves the OpenAI Responses API (/responses), the only one Codex speaks.
export const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', protocol: 'openai', responses: true },
  anthropic: { baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', protocol: 'anthropic', responses: false },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', protocol: 'openai', responses: true },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', protocol: 'openai', responses: true },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', protocol: 'openai', responses: false },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', protocol: 'openai', responses: false },
  xai: { baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', protocol: 'openai', responses: true },
  together: { baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', protocol: 'openai', responses: false },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', protocol: 'openai', responses: false },
  // OpenCode Console: pay-as-you-go (Zen) and the Go subscription. Pi and OpenClaw know both
  // natively; OpenCode's free models are reachable only through the opencode harness.
  opencode: { baseUrl: 'https://opencode.ai/inference/openai/v1', keyEnv: 'OPENCODE_API_KEY', protocol: 'openai', responses: true },
  'opencode-go': { baseUrl: 'https://opencode.ai/inference/go/openai/v1', keyEnv: 'OPENCODE_API_KEY', protocol: 'openai', responses: true },
  ollama: { baseUrl: 'http://localhost:11434/v1', keyEnv: '', protocol: 'openai', responses: true },
};

/**
 * The endpoint to talk to: an explicit base_url wins, then a known provider.
 * `custom: true` means the harness must be told about a provider it does not know.
 */
export function resolveEndpoint({ provider, baseUrl, apiKeyEnv }) {
  if (baseUrl) {
    return { provider: provider || 'custom', baseUrl, keyEnv: apiKeyEnv || PROVIDERS[provider]?.keyEnv || 'OPENAI_API_KEY', protocol: PROVIDERS[provider]?.protocol ?? 'openai', custom: true };
  }
  const known = PROVIDERS[provider];
  if (!known) return { provider, baseUrl: '', keyEnv: apiKeyEnv || '', protocol: 'unknown', custom: false };
  return { provider, ...known, keyEnv: apiKeyEnv || known.keyEnv, custom: false };
}
