// Every input of action.yml, parsed and validated once.
import fs from 'node:fs';
import { getInput, getBool, getList } from './core/action.mjs';

export const HARNESSES = ['opencode', 'codex', 'pi', 'claw'];
const TOOLS = ['auto', 'read-only', 'edit', 'full'];
const SEVERITIES = ['error', 'warning', 'notice'];

function parseJsonInput(name, raw) {
  if (!raw) return null;
  const text = raw.startsWith('{') || raw.startsWith('[') ? raw : fs.readFileSync(raw, 'utf8');
  try { return JSON.parse(text); } catch (err) { throw new Error(`Input ${name} is not valid JSON: ${err.message}`); }
}

function positiveNumber(name, raw, dflt) {
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Input ${name} must be a positive number, got "${raw}"`);
  return n;
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`Input ${name} must be one of ${allowed.join(', ')}; got "${value}"`);
  return value;
}

export function readInputs(env = process.env) {
  const o = { env };
  const harness = oneOf('harness', getInput('harness', o) || 'opencode', HARNESSES);
  const model = getInput('model', o);
  const failOn = getInput('fail_on', o);
  const harnessConfigRaw = getInput('harness_config', o);
  return {
    // what to run
    prompt: getInput('prompt', { ...o, trim: false }).trim(),
    harness,
    harnessVersion: getInput('harness_version', o),
    model,
    baseUrl: getInput('base_url', o),
    apiKeyEnv: getInput('api_key_env', o),
    harnessArgs: getInput('harness_args', o),
    harnessConfig: harnessConfigRaw
      ? harnessConfigRaw.startsWith('{') || harnessConfigRaw.startsWith('[') || /\.json$/i.test(harnessConfigRaw)
        ? parseJsonInput('harness_config', harnessConfigRaw)
        : harnessConfigRaw // TOML for codex, kept verbatim
      : null,
    mcpConfig: parseJsonInput('mcp_config', getInput('mcp_config', o)),
    skills: getList('skills', o),
    skillsToken: getInput('skills_token', o),
    skill: getInput('skill', o),
    tools: oneOf('tools', getInput('tools', o) || 'auto', TOOLS),
    allowBash: getList('allow_bash', o),
    maxSteps: positiveNumber('max_steps', getInput('max_steps', o), 200),
    timeoutMinutes: positiveNumber('timeout_minutes', getInput('timeout_minutes', o), 30),
    budgetUsd: positiveNumber('budget_usd', getInput('budget_usd', o), 0),
    jsonSchema: parseJsonInput('json_schema', getInput('json_schema', o)),

    // triggers (tag mode)
    triggerPhrase: getInput('trigger_phrase', o) || '@harness',
    labelTrigger: getInput('label_trigger', o) || 'harness',
    assigneeTrigger: getInput('assignee_trigger', o).replace(/^@/, ''),
    trackProgress: getBool('track_progress', false, o),
    useStickyComment: getBool('use_sticky_comment', false, o),
    postComment: getBool('post_comment', false, o),

    // access control
    allowedBots: getList('allowed_bots', o),
    allowedNonWriteUsers: getList('allowed_non_write_users', o),
    includeCommentsByActor: getList('include_comments_by_actor', o),
    excludeCommentsByActor: getList('exclude_comments_by_actor', o),

    // git
    githubToken: getInput('github_token', o),
    baseBranch: getInput('base_branch', o),
    branchPrefix: getInput('branch_prefix', o) || 'harness/',
    branchNameTemplate: getInput('branch_name_template', o),
    commitMode: oneOf('commit_mode', getInput('commit_mode', o) || 'auto', ['auto', 'pr-branch', 'new-branch', 'none']),
    additionalPermissions: getInput('additional_permissions', o),

    // reporting
    failOn: failOn ? oneOf('fail_on', failOn, SEVERITIES) : '',
    onAgentError: oneOf('on_agent_error', getInput('on_agent_error', o) || 'warn', ['warn', 'fail']),
    annotations: getBool('annotations', true, o),
    sarif: getBool('sarif', false, o),
    displayReport: getBool('display_report', false, o),
    showFullOutput: getBool('show_full_output', false, o),
    workingDirectory: getInput('working_directory', o) || '.',
  };
}

/** `tools: auto` resolves per mode: a conversation may change code, an automation only reads. */
export function effectiveTools(tools, mode) {
  if (tools !== 'auto') return tools;
  return mode === 'tag' ? 'edit' : 'read-only';
}

/** "provider/model" → { provider, id }. A bare id keeps the harness default provider. */
export function splitModel(model) {
  if (!model) return { provider: '', id: '' };
  const i = model.indexOf('/');
  return i < 0 ? { provider: '', id: model } : { provider: model.slice(0, i), id: model.slice(i + 1) };
}
