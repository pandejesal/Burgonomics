'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, isQuota, isFreeModel, buildPrompt } = require('./dispatcher.cjs');

const row = (patch = {}) => ({
  id: 'msg_unit',
  type: 'assistant',
  time: { created: 100, completed: 101 },
  finish: 'stop',
  model: { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' },
  content: [{ type: 'text', text: 'QUEUE_TASK: unit\nSUPERVISOR_STATE: COMPLETE' }],
  ...patch,
});

test('owner completion is unaccepted evidence, never automatic acceptance', () => {
  assert.equal(classify([row()], 99).phase, 'reported_complete_unaccepted');
});
test('an old completion cannot finish a newly admitted packet', () => {
  assert.equal(classify([row()], 200).phase, 'idle_without_report');
});
test('a provider failure wins over flattering text', () => {
  const result = classify([row({ error: { status: 429, type: 'provider.free-limit' } }), row()], 99);
  assert.equal(result.phase, 'blocked');
  assert.equal(isQuota(result.error), true);
});
test('a later successful final answer outranks an earlier transient error', () => {
  const failed = row({ id: 'msg_failed', time: { created: 100, completed: 101 }, error: { status: 429, type: 'provider.free-limit' } });
  const success = row({ id: 'msg_success', time: { created: 200, completed: 201 } });
  assert.equal(classify([failed, success], 99).phase, 'reported_complete_unaccepted');
});
test('invalid request is blocked but is not treated as free quota', () => {
  const result = classify([row({ error: { status: 400, type: 'provider.invalid-request' } })], 99);
  assert.equal(result.phase, 'blocked');
  assert.equal(isQuota(result.error), false);
});
test('unfinished and tool-only turns are not final answers', () => {
  assert.equal(classify([row({ time: { created: 100 } })], 99).phase, 'idle_without_report');
  assert.equal(classify([row({ finish: 'tool-calls' })], 99).phase, 'idle_without_report');
});
test('embedded completion markers do not count as terminal completion', () => {
  const quoted = row({ content: [{ type: 'text', text: 'Example:\n`SUPERVISOR_STATE: COMPLETE`\nStill waiting for review' }] });
  assert.equal(classify([quoted], 99).phase, 'reported_pending');
});
test('only free OpenCode models are accepted as actual execution', () => {
  assert.equal(isFreeModel({ providerID: 'opencode', id: 'deepseek-v4.1-flash-free' }), true);
  assert.equal(isFreeModel({ providerID: 'opencode', id: 'glm-5.3-flash-free' }), true);
  assert.equal(isFreeModel({ providerID: 'opencode', id: 'big-pickle' }), true);
  assert.equal(isFreeModel({ providerID: 'openrouter', id: 'cohere/north-mini-code:free' }), true);
  assert.equal(isFreeModel({ providerID: 'openrouter', id: 'cohere/north-mini-code' }), false);
  assert.equal(isFreeModel({ providerID: 'google', id: 'antigravity-gemini-3.8-flash-high' }), true);
  assert.equal(isFreeModel({ providerID: 'google', id: 'antigravity-gemini-3.8-flash' }), true);
  assert.equal(isFreeModel({ providerID: 'google', id: 'gemini-3.8-flash' }), false);
  assert.equal(isFreeModel({ providerID: 'openai', id: 'gpt-6.1-sol' }), false);
  assert.equal(isFreeModel({ providerID: 'opencode', id: 'claude-sonnet' }), false);
  assert.equal(isFreeModel(null), false);
});
test('the prompt pins the free primary, fallback and exact task', () => {
  const text = buildPrompt({
    id: 'unit-task',
    lane: 99,
    brief: null,
    repos: ['root'],
    review: 'one',
    note: 'Unit note.',
  });
  assert.match(text, /opencode\/deepseek-v4\.1-flash-free/);
  assert.match(text, /opencode\/glm-5\.3-flash-free/);
  assert.match(text, /google\/antigravity-gemini-3\.8-flash-high/);
  assert.match(text, /opencode\/big-pickle/);
  assert.match(text, /opencode\/mimo-v2\.6-flash-free/);
  assert.match(text, /QUEUE_TASK: unit-task/);
  assert.match(text, /Never call GPT, OpenAI, or any paid model/);
  assert.match(text, /Unit note\./);
});
