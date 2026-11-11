import fs from 'node:fs';
// Small shared helpers.
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, everything else (arrays included) is replaced. */
export function deepMerge(base, extra) {
  if (!isPlainObject(base) || !isPlainObject(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function tomlValue(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (isPlainObject(v)) return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(', ')} }`;
  throw new Error(`Cannot encode ${typeof v} as TOML`);
}

/**
 * Serialise a JSON object to TOML. Nested objects become [tables] unless `inline` lists their
 * dotted path (e.g. "mcp_servers.harness.env"), in which case they stay inline tables.
 */
export function toToml(obj, { inline = [] } = {}) {
  const lines = [];
  const emit = (table, keys) => {
    const scalars = [];
    const tables = [];
    for (const [k, v] of Object.entries(table)) {
      if (v === undefined || v === null) continue;
      const pathKeys = [...keys, k];
      const dotted = pathKeys.join('.');
      if (isPlainObject(v) && !inline.some((re) => (re instanceof RegExp ? re.test(dotted) : re === dotted))) tables.push([v, pathKeys]);
      else scalars.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    }
    if (keys.length && (scalars.length || !tables.length)) lines.push('', `[${keys.map(tomlKey).join('.')}]`);
    lines.push(...scalars);
    for (const [v, pathKeys] of tables) emit(v, pathKeys);
  };
  emit(obj, []);
  return lines.join('\n').trim() + '\n';
}

/**
 * The content of `file` if it is a regular file, else null. What the agent leaves in the state
 * directory is read this way: a symbolic link there must not make the job's user read, and then
 * publish, whatever it points to.
 */
export function readRegular(file) {
  try { return fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null; } catch { return null; }
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

/** Variables the agent (and third-party install scripts) must never see. */
const SECRET_ENV = /^(INPUT_.*|GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|ACTIONS_RESULTS_URL|ACTIONS_CACHE_URL|ACTIONS_RUNTIME_URL|GITHUB_OUTPUT|GITHUB_ENV|GITHUB_PATH|GITHUB_STATE|GITHUB_STEP_SUMMARY|HARNESS_INPUTS)$/;

export function sanitizedEnv(base = process.env, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!SECRET_ENV.test(k)) env[k] = v;
  return { ...env, ...extra };
}
