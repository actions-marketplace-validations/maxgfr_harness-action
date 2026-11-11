import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInputs } from '../../src/inputs.mjs';
import { tmpDir, runPublish, makeRepo } from './helpers.mjs';

test('a loop that ran out of turns without being declared done is a failed run', async () => {
  const loop = (loopResult, loopUntil = '') => runPublish({ run: { iterations: [{ n: 1 }, { n: 2 }, { n: 3 }], loopResult, loopUntil } });
  const undeclared = await loop('exhausted');
  assert.equal(undeclared.outputs.conclusion, 'failure');
  assert.match(undeclared.summary, /did not call task_complete within 3 iteration/);
  assert.equal((await loop('complete')).outputs.conclusion, 'success');
  assert.equal((await loop('exhausted', 'npm test')).outputs.conclusion, 'failure');
  assert.equal((await loop('passed', 'npm test')).outputs.conclusion, 'success');
  assert.equal((await runPublish()).outputs.conclusion, 'success'); // no loop
});

test('changes that could not be committed make the run a failure', async () => {
  const { repo, base } = makeRepo();
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  const context = { workDir: repo, commitMode: 'new-branch', baseHead: base, branchName: 'main', request: 'fix it', ctx: { owner: 'acme', repo: 'demo', number: 7, isPR: false, actor: 'alice', actorId: 1, runUrl: 'https://example/run', serverUrl: 'https://github.com', defaultBranch: 'main', sha: base } };
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = 'http://127.0.0.1:9'; // nothing listens there: the branch cannot be created
  try {
    const warn = await runPublish({ context });
    assert.equal(warn.outputs.conclusion, 'failure');
    assert.equal(warn.outputs.branch_name, '');
    assert.equal(warn.exitCode, 0); // on_agent_error: warn
    assert.match(warn.summary, /Could not commit the changes/);
    assert.ok(fs.existsSync(path.join(warn.stateDir, 'report', 'changes.patch'))); // the work is not lost
    assert.equal((await runPublish({ context, inputs: { on_agent_error: 'fail' } })).exitCode, 1);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL; else process.env.GITHUB_API_URL = saved;
  }
});

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
