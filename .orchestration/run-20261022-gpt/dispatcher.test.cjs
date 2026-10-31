'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, eligible } = require('./dispatcher.cjs');
const row = (patch = {}) => ({ id: 'unit_msg', type: 'assistant', time: { created: 100, completed: 101 }, finish: 'stop', content: [{ type: 'text', text: 'QUEUE_TASK: unit\nSUPERVISOR_STATE: COMPLETE' }], ...patch });

test('owner COMPLETE is unaccepted evidence, never automatic acceptance', () => {
  assert.equal(classify([row()], 99).phase, 'reported_complete_unaccepted');
});
test('old COMPLETE cannot finish new work', () => {
  assert.equal(classify([row()], 200).phase, 'idle_without_report');
});
test('provider failure wins over flattering text', () => {
  assert.equal(classify([row({ error: { status: 429, type: 'provider.quota' } }), row()], 99).phase, 'blocked');
});
test('unfinished and tool-only turns do not imply a final answer', () => {
  assert.equal(classify([row({ time: { created: 100 } })], 99).phase, 'idle_without_report');
  assert.equal(classify([row({ finish: 'tool-calls' })], 99).phase, 'idle_without_report');
});
test('embedded or quoted completion markers are not terminal completion', () => {
  assert.equal(classify([row({ content: [{ type: 'text', text: 'SUPERVISOR_STATE: COMPLETE\nStill waiting for review' }] })], 99).phase, 'reported_pending');
  assert.equal(classify([row({ content: [{ type: 'text', text: 'Example:\n`SUPERVISOR_STATE: COMPLETE`' }] })], 99).phase, 'reported_pending');
});
test('deadline, cap and safety halt prevent admission', () => {
  assert.equal(eligible({ admissions: 0 }, Date.parse('2026-10-22T10:25:29Z')), true);
  assert.equal(eligible({ admissions: 0 }, Date.parse('2026-10-22T10:25:30Z')), false);
  assert.equal(eligible({ admissions: 13 }, Date.parse('2026-10-22T06:00:00Z')), false);
  assert.equal(eligible({ admissions: 0, halted: 'quota' }, Date.parse('2026-10-22T06:00:00Z')), false);
});
