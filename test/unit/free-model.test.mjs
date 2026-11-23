import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFreeModel } from '../../scripts/free-model.mjs';

// a catalog entry shaped like https://opencode.ai/inference/v1/models, free and eligible by default
const model = (id, { input = 0, output = 0, tools = true, api = 'chat-completions', type = 'chat', context = 200_000, cost } = {}) => ({
  id,
  type,
  capabilities: { tools: { supported: tools } },
  cost: cost !== undefined ? cost : { text: { input: { price: input, cache: { read: 0 } }, output: { price: output } } },
  api: api ? { [api]: { url: 'https://opencode.ai/inference/v1/chat/completions' } } : undefined,
  recommended_api: api,
  limit: { context },
});
const pick = (data, opts) => pickFreeModel({ data }, opts);

test('pickFreeModel keeps only models free on input AND output', () => {
  const data = [model('free'), model('paid-in', { input: 0.5 }), model('paid-out', { output: 2 }), model('paid', { input: 1, output: 3 })];
  assert.deepEqual(pick(data), ['free']);
});

test('pickFreeModel treats a missing or non-numeric price as not free', () => {
  const data = [
    model('no-cost', { cost: null }),
    model('no-text', { cost: {} }),
    model('no-input', { cost: { text: { output: { price: 0 } } } }),
    model('no-output', { cost: { text: { input: { price: 0 } } } }),
    model('string-zero', { input: '0' }),
    model('ok'),
  ];
  assert.deepEqual(pick(data), ['ok']);
});

test('pickFreeModel needs tool calling, a chat type and the chat-completions api', () => {
  const data = [
    model('no-tools', { tools: false }),
    { ...model('tools-unknown'), capabilities: {} },
    model('decision', { type: 'decision' }),
    model('systemone', { api: 'systemone' }),
    model('no-api', { api: null }),
    model('ok'),
  ];
  assert.deepEqual(pick(data), ['ok']);
});

test('pickFreeModel puts the preferred ids first, in the given order, skipping absent ones', () => {
  const data = [model('a', { context: 1e6 }), model('big-pickle'), model('deepseek-v4.1-flash-free'), model('paid', { input: 1 })];
  assert.deepEqual(pick(data, { prefer: ['deepseek-v4.1-flash-free', 'gone-free', 'paid', 'big-pickle'] }), ['deepseek-v4.1-flash-free', 'big-pickle', 'a']);
  assert.deepEqual(pick(data, { prefer: ['big-pickle', 'big-pickle'] }), ['big-pickle', 'a', 'deepseek-v4.1-flash-free']);
});

test('pickFreeModel orders the rest by context size desc, then id', () => {
  const data = [model('m', { context: 200_000 }), model('z', { context: 1_048_576 }), model('b', { context: 200_000 }), model('a', { context: 1_048_576 }), { ...model('no-limit'), limit: undefined }];
  assert.deepEqual(pick(data), ['a', 'z', 'b', 'm', 'no-limit']);
  assert.deepEqual(pick(data, { prefer: ['m'] }), ['m', 'a', 'z', 'b', 'no-limit']);
});

test('pickFreeModel returns an empty list for an empty or malformed catalog', () => {
  assert.deepEqual(pickFreeModel({ data: [] }), []);
  assert.deepEqual(pickFreeModel({}), []);
  assert.deepEqual(pickFreeModel(null), []);
  assert.deepEqual(pickFreeModel({ data: [null, { id: 42 }] }, { prefer: ['big-pickle'] }), []);
});
