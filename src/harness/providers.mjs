// Known providers, for harnesses that need an explicit endpoint (Codex, claw) or a custom one.
export const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', protocol: 'openai' },
  anthropic: { baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', protocol: 'anthropic' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', protocol: 'openai' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', protocol: 'openai' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', protocol: 'openai' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', protocol: 'openai' },
  xai: { baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', protocol: 'openai' },
  together: { baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', protocol: 'openai' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', protocol: 'openai' },
  ollama: { baseUrl: 'http://localhost:11434/v1', keyEnv: '', protocol: 'openai' },
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
