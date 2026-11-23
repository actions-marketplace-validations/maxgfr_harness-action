import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, containsTrigger, findTrigger, stripTriggers, classifyIntent, intentFor } from '../../src/modes.mjs';
import { readInputs } from '../../src/inputs.mjs';

const inputs = (over = {}) => readInputs(Object.fromEntries(Object.entries({ model: 'a/b', ...over }).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])));
const comment = (body) => ({ eventName: 'issue_comment', action: 'created', payload: { comment: { body, user: { login: 'alice' } } } });

test('trigger_phrase: a comma or newline separated list, @harness by default', () => {
  assert.deepEqual(inputs().triggerPhrases, ['@harness']);
  assert.deepEqual(inputs({ trigger_phrase: '@harness, /h' }).triggerPhrases, ['@harness', '/h']);
  assert.deepEqual(inputs({ trigger_phrase: '@harness\n/h\n' }).triggerPhrases, ['@harness', '/h']);
  assert.deepEqual(inputs({ trigger_phrase: '@bot' }).triggerPhrases, ['@bot']);
});

test('every phrase of the list triggers', () => {
  const i = inputs({ trigger_phrase: '@harness,/h' });
  assert.equal(detectMode(comment('@harness fix it'), i).mode, 'tag');
  assert.equal(detectMode(comment('/h fix it'), i).mode, 'tag');
  assert.equal(detectMode(comment('/h fix it'), i).reason, 'comment mentions /h');
  assert.equal(detectMode(comment('see src/h and https://x.dev/h/1'), i).mode, 'skip');
  assert.match(detectMode(comment('thanks'), i).reason, /no @harness \/ \/h trigger/);
  assert.equal(findTrigger('ok /H and @harness', ['@harness', '/h']), '/H');
});

test('a single phrase matches as before', () => {
  for (const p of ['@harness', ['@harness']]) {
    assert.ok(containsTrigger('hey @harness fix it', p));
    assert.ok(containsTrigger('@Harness', p));
    assert.ok(containsTrigger('(@harness)', p));
    assert.ok(!containsTrigger('mail me@harness.dev', p));
    assert.ok(!containsTrigger('@harness-bot do', p));
    assert.ok(!containsTrigger('@harnessX do', p));
    assert.ok(!containsTrigger('', p));
  }
  assert.ok(!containsTrigger('@harness', []));
  // a phrase that prefixes another does not shadow it
  assert.equal(findTrigger('@harness-e2e go', ['@harness', '@harness-e2e']), '@harness-e2e');
});

test('every phrase is stripped from the request', () => {
  const phrases = ['@harness', '/h'];
  assert.equal(stripTriggers('@harness fix the bug', phrases).trim(), 'fix the bug');
  assert.equal(stripTriggers('/h fix the bug', phrases).trim(), 'fix the bug');
  assert.equal(stripTriggers('/H fix @Harness src/h.mjs', phrases).replace(/\s+/g, ' ').trim(), 'fix src/h.mjs');
  assert.equal(stripTriggers('mail me@harness.dev', ['@harness']), 'mail me@harness.dev');
  assert.equal(stripTriggers('@harness add a flag', '@harness').trim(), 'add a flag');
});

test('intent is read after whichever phrase comes first', () => {
  const phrases = ['@harness', '/h'];
  assert.equal(classifyIntent('/h fix the flaky test', phrases), 'do');
  assert.equal(classifyIntent('/h why is it slow?', phrases), 'ask');
  assert.equal(classifyIntent('@harness fix the flaky test', phrases), 'do');
  assert.equal(classifyIntent('@harness why is it slow?', phrases), 'ask');
  assert.equal(classifyIntent('/h do: the fix', phrases), 'do');
  assert.equal(classifyIntent('see src/h first. @harness add a test', phrases), 'do');
  assert.equal(classifyIntent('Create DONE.md /h create DONE.md', phrases), 'do');
  assert.equal(classifyIntent('/h', phrases), 'ask');
  // a single phrase, as a string or a list
  assert.equal(classifyIntent('@harness fix it', '@harness'), 'do');
  assert.equal(classifyIntent('@harness explain it', ['@harness']), 'ask');
  const i = inputs({ trigger_phrase: '@harness,/h' });
  assert.equal(intentFor(detectMode(comment('/h implement retries'), i), i), 'do');
  assert.equal(intentFor(detectMode(comment('/h what does this do?'), i), i), 'ask');
});
