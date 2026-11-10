import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../../src/stages/publish.mjs';
import { readInputs } from '../../src/inputs.mjs';

const tmpDir = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ha-${name}-`)));

/**
 * Runs the publish stage offline: the working directory is not a git checkout and there is no
 * tracking comment or pull request, so it never calls the GitHub API.
 * @returns {{ exitCode: number, outputs: Record<string, string>, summary: string, stateDir: string }}
 */
async function runPublish({ context = {}, run = {}, inputs = {}, files = {} } = {}) {
  const stateDir = tmpDir('publish');
  const write = (name, data) => {
    fs.mkdirSync(path.dirname(path.join(stateDir, name)), { recursive: true });
    fs.writeFileSync(path.join(stateDir, name), typeof data === 'string' ? data : JSON.stringify(data));
  };
  write('context.json', {
    run: true, mode: 'automation', harness: 'pi', model: 'a/b', workDir: tmpDir('work'), version: '1', commitMode: 'none',
    ctx: { owner: 'acme', repo: 'demo', number: null, isPR: false, actor: 'alice', runUrl: 'https://example/run', serverUrl: 'https://github.com', sha: 'abc' },
    ...context,
  });
  write('run.json', { status: 'success', exitCode: 0, durationMs: 1000, finalText: 'done', tools: 1, inputTokens: 1, outputTokens: 1, cost: 0, costKnown: false, errors: [], iterations: [{ n: 1 }], loopResult: 'single', loopUntil: '', ...run });
  for (const [name, data] of Object.entries(files)) write(name, data);
  const env = Object.fromEntries(Object.entries({ model: 'a/b', harness: 'pi', ...inputs }).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]));
  const outputFile = path.join(stateDir, 'outputs.txt');
  const summaryFile = path.join(stateDir, 'summary.md');
  const saved = { GITHUB_OUTPUT: process.env.GITHUB_OUTPUT, GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY };
  Object.assign(process.env, { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile });
  try {
    const { exitCode } = await publish({ env, stateDir });
    const outputs = {};
    for (const m of fs.readFileSync(outputFile, 'utf8').matchAll(/^([\w-]+)<<(ghadelim_[\w-]+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
    return { exitCode, outputs, summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '', stateDir };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('a truncated execution log does not stop the publish step', async () => {
  const log = `${JSON.stringify({ t: 'text', text: 'TRANSCRIPT_LINE' })}\n${JSON.stringify({ t: 'tool', name: 'read', input: {} })}\n{"t":"text","text":"cut sho`;
  const shown = await runPublish({ inputs: { display_report: 'true' }, files: { 'report/execution.jsonl': log } });
  assert.equal(shown.outputs.conclusion, 'success');
  assert.match(shown.summary, /TRANSCRIPT_LINE/);
  // without display_report the log is not even read
  const hidden = await runPublish({ files: { 'report/execution.jsonl': log } });
  assert.equal(hidden.outputs.conclusion, 'success');
  assert.doesNotMatch(hidden.summary, /TRANSCRIPT_LINE/);
});

test('the structured output is checked against the schema prepare parsed, not the file as the agent left it', async () => {
  const work = tmpDir('schema');
  const schemaFile = path.join(work, 'schema.json');
  const schema = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } };
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  assert.deepEqual(readInputs({ INPUT_MODEL: 'a/b', INPUT_JSON_SCHEMA: schemaFile }).jsonSchema, schema); // prepare reads the file

  // the agent rewrote the file so that anything validates
  fs.writeFileSync(schemaFile, '{}');
  const loose = await runPublish({ inputs: { json_schema: schemaFile }, context: { jsonSchema: schema }, files: { 'structured_output.json': { other: 1 } } });
  assert.equal(loose.outputs.conclusion, 'failure');
  assert.equal(loose.outputs.structured_output, '');
  assert.match(loose.summary, /missing required property "verdict"/);

  // … or broke it: publish must still run to the end
  fs.writeFileSync(schemaFile, 'not json');
  const broken = await runPublish({ inputs: { json_schema: schemaFile }, context: { jsonSchema: schema }, files: { 'structured_output.json': { verdict: 'pass' } } });
  assert.equal(broken.outputs.conclusion, 'success');
  assert.equal(broken.outputs.structured_output, '{"verdict":"pass"}');
});
