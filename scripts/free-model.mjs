#!/usr/bin/env node
// Picks an OpenCode free model for the keyless live e2e (e2e-free.yml). The live catalog is the
// authority: models.dev still lists free models OpenCode has withdrawn. Free models only answer
// through the opencode CLI, so the workflow runs them as `harness: opencode`, `model: opencode/<id>`.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const CATALOG = 'https://opencode.ai/inference/v1/models';
const FALLBACK = 'big-pickle';
const DEFAULT_PREFER = 'big-pickle,deepseek-v4.1-flash-free';

const free = (price) => price === 0; // a missing price is unknown, not free

/**
 * Ids of the catalog's free chat models that can call tools over chat-completions: the `prefer`
 * ids first (in that order, those present only), then the rest by context size desc, then id.
 */
export function pickFreeModel(catalog, { prefer = [] } = {}) {
  const eligible = (catalog?.data ?? []).filter((m) =>
    m?.type === 'chat' &&
    typeof m.id === 'string' &&
    free(m.cost?.text?.input?.price) &&
    free(m.cost?.text?.output?.price) &&
    m.capabilities?.tools?.supported === true &&
    m.api?.['chat-completions'] != null);
  const ids = new Set(eligible.map((m) => m.id));
  const first = [...new Set(prefer)].filter((id) => ids.has(id));
  const rest = eligible
    .filter((m) => !first.includes(m.id))
    .sort((a, b) => (b.limit?.context ?? 0) - (a.limit?.context ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => m.id);
  return [...first, ...new Set(rest)];
}

async function fetchCatalog({ attempts = 2, timeoutMs = 15_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(CATALOG, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const prefer = (process.env.FREE_MODEL_PREFER || DEFAULT_PREFER).split(',').map((s) => s.trim()).filter(Boolean);
  let ids = [];
  try {
    ids = pickFreeModel(await fetchCatalog(), { prefer });
    if (!ids.length) console.log(`::warning::No eligible free model in ${CATALOG}; falling back to opencode/${FALLBACK}`);
  } catch (err) {
    console.log(`::warning::Could not read ${CATALOG} (${err.message}); falling back to opencode/${FALLBACK}`);
  }
  if (!ids.length) ids = [FALLBACK];
  const candidates = ids.slice(0, 3).map((id) => `opencode/${id}`);
  // fallback: the model e2e-free.yml retries with when the first one fails (empty = none)
  const out = `model=${candidates[0]}\ncandidates=${JSON.stringify(candidates)}\nfallback=${candidates[1] ?? ''}\n`;
  process.stdout.write(out);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
}

// entry guard: importing this module (the unit test) runs nothing
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
