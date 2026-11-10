// Outbox replay, findings normalisation and a small JSON-schema validator.
import fs from 'node:fs';
import path from 'node:path';

const SEV_RANK = { notice: 1, warning: 2, error: 3 };

export function readOutbox(stateDir) {
  const file = path.join(stateDir, 'outbox.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function normalizeFinding(f) {
  const severity = ['error', 'warning', 'notice'].includes(f.severity) ? f.severity : 'warning';
  const line = Number.isInteger(Number(f.line)) && Number(f.line) > 0 ? Number(f.line) : undefined;
  // (an end line only means something after a start line; `null` must not become line 0)
  const endLine = line && Number.isInteger(Number(f.end_line)) && Number(f.end_line) >= line ? Number(f.end_line) : undefined;
  return {
    file: String(f.file ?? f.path ?? '').replace(/^\.\//, ''),
    line,
    endLine,
    severity,
    title: f.title ? String(f.title) : undefined,
    message: String(f.message ?? ''),
    rule: f.rule ? String(f.rule) : undefined,
  };
}

export function collect(stateDir) {
  const outbox = readOutbox(stateDir);
  const findings = outbox.filter((e) => e.kind === 'finding').map((e) => normalizeFinding(e.finding ?? {})).filter((f) => f.message);
  const inline = outbox.filter((e) => e.kind === 'inline').map((e) => e.comment).filter((c) => c?.path && c?.body && c?.line);
  const progress = outbox.filter((e) => e.kind === 'progress').at(-1)?.markdown ?? '';
  let structured = null;
  const so = path.join(stateDir, 'structured_output.json');
  if (fs.existsSync(so)) { try { structured = JSON.parse(fs.readFileSync(so, 'utf8')); } catch {} }
  return { findings, inline, progress, structured };
}

export function failsGate(findings, failOn) {
  if (!failOn) return [];
  return findings.filter((f) => SEV_RANK[f.severity] >= SEV_RANK[failOn]);
}

// ---------------------------------------------------------------------------------------------
// JSON Schema. The keywords tool schemas use, validated without a dependency. A keyword that is
// not in `CHECKED` is reported by `uncheckedKeywords`, so a schema is never half-applied silently.
// ---------------------------------------------------------------------------------------------
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const FORMATS = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s.replace(' ', 'T'))),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  time: (s) => /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
};

/** Keywords that say nothing about validity. */
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', '$defs', 'definitions', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
/** Keywords `validate` applies. */
const CHECKED = new Set([
  '$ref', 'type', 'enum', 'const',
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'items', 'prefixItems',
  'required', 'properties', 'additionalProperties', 'patternProperties', 'minProperties', 'maxProperties',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);

/** `#`, `#/$defs/name`, `#/definitions/name`… inside the schema itself. Anything else is not resolved. */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let node = root;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/**
 * Validates `value` against `schema`. Returns a list of errors (empty when valid).
 * @param {object|boolean} schema
 * @param {string} [at] where the value is, for the messages
 * @param {object} [root] the whole schema, for `$ref`
 */
export function validate(schema, value, at = '$', root = schema, refs = new Set()) {
  const errors = [];
  if (schema === false) return [`${at}: nothing is allowed here`];
  if (!schema || typeof schema !== 'object') return errors;
  const sub = (s, v, where = at) => validate(s, v, where, root, refs);
  const valid = (s) => !sub(s, value).length;

  if (schema.$ref !== undefined) {
    const key = `${schema.$ref}@${at}`;
    const target = resolveRef(root, schema.$ref);
    if (target === undefined) errors.push(`${at}: the schema's $ref ${schema.$ref} cannot be resolved (only references inside the schema are supported)`);
    else if (!refs.has(key)) errors.push(...validate(target, value, at, root, new Set([...refs, key]))); // (a reference to itself at the same place adds nothing)
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${t}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => same(e, value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.const !== undefined && !same(schema.const, value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern) {
      let re = null;
      // a pattern that is not a JavaScript regular expression is the schema's mistake: say so
      // instead of throwing in the middle of the publish step
      try { re = new RegExp(schema.pattern); } catch { errors.push(`${at}: the schema's pattern ${schema.pattern} is not a valid regular expression`); }
      if (re && !re.test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    }
    if (FORMATS[schema.format] && !FORMATS[schema.format](value)) errors.push(`${at}: is not a valid ${schema.format}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${at}: must be greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(`${at}: must be less than ${schema.exclusiveMaximum}`);
    if (schema.multipleOf > 0 && Math.abs(Math.round(value / schema.multipleOf) - value / schema.multipleOf) > 1e-9) errors.push(`${at}: not a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${at}: items must be unique`);
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    value.forEach((v, i) => {
      if (i < prefix.length) errors.push(...sub(prefix[i], v, `${at}[${i}]`));
      else if (schema.items !== undefined) errors.push(...sub(schema.items, v, `${at}[${i}]`));
    });
  }
  if (typeOf(value) === 'object') {
    const keys = Object.keys(value);
    for (const req of schema.required ?? []) if (!(req in value)) errors.push(`${at}: missing required property "${req}"`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${at}: fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${at}: more than ${schema.maxProperties} properties`);
    const props = schema.properties ?? {};
    const patterns = Object.entries(schema.patternProperties ?? {}).map(([p, s]) => { try { return [new RegExp(p), s]; } catch { return null; } }).filter(Boolean);
    for (const [k, v] of Object.entries(value)) {
      const matched = patterns.filter(([re]) => re.test(k));
      if (k in props) errors.push(...sub(props[k], v, `${at}.${k}`));
      for (const [, s] of matched) errors.push(...sub(s, v, `${at}.${k}`));
      if (k in props || matched.length) continue;
      if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...sub(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  for (const s of schema.allOf ?? []) errors.push(...sub(s, value));
  if (schema.anyOf && !schema.anyOf.some(valid)) errors.push(`${at}: matches none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter(valid).length !== 1) errors.push(`${at}: must match exactly one of oneOf`);
  if (schema.not !== undefined && valid(schema.not)) errors.push(`${at}: must not match the schema under "not"`);
  if (schema.if !== undefined) {
    const branch = valid(schema.if) ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...sub(branch, value));
  }
  return errors;
}

/**
 * The keywords of `schema` that `validate` does not apply (and the `format` values it does not
 * know), each once. They do not make the schema unusable; they are just not checked.
 */
export function uncheckedKeywords(schema) {
  const found = new Set();
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'format') { if (typeof value === 'string' && !FORMATS[value]) found.add(`format: ${value}`); continue; }
      if (key === '$ref') { if (typeof value !== 'string' || !value.startsWith('#')) found.add(`$ref: ${value}`); continue; }
      if (key === 'enum' || key === 'const' || key === 'default' || key === 'examples' || key === 'required') continue; // data, not schemas
      if (key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions') { Object.values(value ?? {}).forEach(walk); continue; } // names → schemas
      if (!CHECKED.has(key) && !ANNOTATIONS.has(key)) { found.add(key); continue; }
      walk(value);
    }
  };
  walk(schema);
  return [...found];
}
