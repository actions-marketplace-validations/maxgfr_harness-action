// Minimal, dependency-free replacement for @actions/core.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';

export function getInput(name, { env = process.env, required = false, trim = true } = {}) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  let value = env[key] ?? '';
  if (trim) value = value.trim();
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
}

export function getBool(name, dflt = false, opts) {
  const v = getInput(name, opts).toLowerCase();
  if (!v) return dflt;
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`Input ${name} must be a boolean, got "${v}"`);
}

export function getList(name, opts) {
  return getInput(name, opts)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function appendKV(file, name, value) {
  const delim = `ghadelim_${crypto.randomUUID()}`;
  fs.appendFileSync(file, `${name}<<${delim}${os.EOL}${value}${os.EOL}${delim}${os.EOL}`);
}

export function setOutput(name, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (process.env.GITHUB_OUTPUT) appendKV(process.env.GITHUB_OUTPUT, name, v);
  else process.stdout.write(`[output] ${name}=${v.length > 200 ? v.slice(0, 200) + '…' : v}\n`);
}

export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  else if (process.env.HARNESS_SUMMARY_FILE) fs.appendFileSync(process.env.HARNESS_SUMMARY_FILE, markdown + '\n');
}

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function command(cmd, message, props = {}) {
  const p = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${escapeProp(v)}`)
    .join(',');
  process.stdout.write(`::${cmd}${p ? ' ' + p : ''}::${escapeData(message)}\n`);
}

export const info = (m) => process.stdout.write(`${m}\n`);
export const warning = (m, props) => command('warning', m, props);
export const error = (m, props) => command('error', m, props);
export const notice = (m, props) => command('notice', m, props);
export const mask = (secret) => { if (secret) command('add-mask', secret); };

export async function group(name, fn) {
  process.stdout.write(`::group::${name}\n`);
  try { return await fn(); } finally { process.stdout.write('::endgroup::\n'); }
}
