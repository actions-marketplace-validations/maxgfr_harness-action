// Harness registry + the normalised event model every adapter emits.
//
// Normalised events (one JSON object per line in the execution file):
//   { t: 'session', id }
//   { t: 'text', text }                       assistant text (a whole message, not deltas)
//   { t: 'tool', name, input }                tool call started / requested
//   { t: 'tool_result', name, output, error } tool call finished
//   { t: 'usage', input, output, cost }       incremental token usage; cost in USD when known
//   { t: 'error', message }                   harness / provider error
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opencode1 from './opencode.mjs';
import opencode2 from './opencode2.mjs';
import codex from './codex.mjs';
import pi from './pi.mjs';
import claw from './claw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSIONS = JSON.parse(fs.readFileSync(path.join(HERE, 'versions.json'), 'utf8'));
export const MCP_SERVER = path.resolve(HERE, '..', 'mcp', 'server.mjs');

const ADAPTERS = { opencode: opencode2, 'opencode-v1': opencode1, codex, pi, claw };

export function getAdapter(id) {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`Unknown harness "${id}" (expected one of opencode, codex, pi, claw)`);
  return a;
}

/**
 * The harness the inputs ask for. `opencode` is OpenCode 2 (@opencode/cli); a 1.x version
 * (`harness_version: 1` or `1.19.5`) selects the OpenCode 1 adapter (opencode-ai).
 * @returns {{ id, adapterId, adapter, meta, version }}
 */
export function resolveHarness(id, requested = '') {
  let adapterId = id;
  let version = requested;
  if (id === 'opencode') {
    if (/^1(\.|$)/.test(requested)) adapterId = 'opencode-v1';
    if (requested === '1' || requested === '2') version = '';
  }
  const meta = VERSIONS[adapterId];
  if (!meta || adapterId === 'opencode-v1' && id !== 'opencode') throw new Error(`Unknown harness "${id}" (expected one of opencode, codex, pi, claw)`);
  return { id, adapterId, adapter: getAdapter(adapterId), meta, version: version || meta.version };
}

/**
 * Translate the action's portable permission level into what every adapter needs.
 *   read-only — read / search only
 *   edit      — + edit and write files in the workspace; shell limited to allow_bash
 *   full      — + any shell command, network fetches
 */
export function permissionProfile(tools, allowBash = []) {
  return {
    level: tools,
    edit: tools !== 'read-only',
    bash: tools === 'full' ? 'all' : allowBash.length ? 'allowlist' : 'none',
    allowBash,
    web: tools === 'full',
  };
}

/** Accumulates normalised events into the run summary. */
export function createAccumulator() {
  const acc = { sessionId: '', texts: [], tools: 0, toolCalls: [], inputTokens: 0, outputTokens: 0, cost: 0, costKnown: false, errors: [] };
  acc.push = (ev) => {
    switch (ev.t) {
      case 'session': if (ev.id) acc.sessionId = ev.id; break;
      case 'text': if (ev.text?.trim()) acc.texts.push(ev.text); break;
      case 'tool': acc.tools++; acc.toolCalls.push(ev.name); break;
      case 'usage':
        acc.inputTokens += ev.input || 0;
        acc.outputTokens += ev.output || 0;
        if (typeof ev.cost === 'number') { acc.cost += ev.cost; acc.costKnown = true; }
        break;
      case 'error': acc.errors.push(ev.message); break;
      default: break;
    }
  };
  Object.defineProperty(acc, 'finalText', { get: () => acc.texts.at(-1) ?? '' });
  return acc;
}

export function splitArgs(str) {
  if (!str) return [];
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of str) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
