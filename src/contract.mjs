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

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** Validates the subset of JSON Schema that tool schemas use. Returns a list of errors. */
export function validate(schema, value, at = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${t}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
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
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required ?? []) if (!(req in value)) errors.push(`${at}: missing required property "${req}"`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validate(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  for (const sub of schema.allOf ?? []) errors.push(...validate(sub, value, at));
  if (schema.anyOf && !schema.anyOf.some((s) => !validate(s, value, at).length)) errors.push(`${at}: matches none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter((s) => !validate(s, value, at).length).length !== 1) errors.push(`${at}: must match exactly one of oneOf`);
  return errors;
}
