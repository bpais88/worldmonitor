import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { approvalCard, isCardSubmit } from './cards.mjs';

test('approvalCard: Adaptive Card 1.5 with Approve/Reject submits carrying the pending id', () => {
  const card = approvalCard('act_123', 'save_freight_report', { filename: 'genoa' });
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.version, '1.5');
  assert.match(card.body[0].text, /save_freight_report/);
  const [approve, reject] = card.actions;
  assert.equal(approve.type, 'Action.Submit');
  assert.deepEqual(approve.data, { kind: 'approval', decision: 'approve', actionId: 'act_123' });
  assert.deepEqual(reject.data, { kind: 'approval', decision: 'reject', actionId: 'act_123' });
});

test('isCardSubmit: true only for our object-data submit (value + kind + no text)', () => {
  assert.equal(isCardSubmit({ type: 'message', value: { kind: 'approval', actionId: 'a', decision: 'approve' } }), true);
  assert.equal(isCardSubmit({ type: 'message', value: { kind: 'approval' }, text: '' }), true);
  assert.equal(isCardSubmit({ type: 'message', value: { kind: 'other' } }), false);        // not our card
  assert.equal(isCardSubmit({ type: 'message', text: 'hello' }), false);                    // a typed message
  assert.equal(isCardSubmit({ type: 'message', value: { kind: 'approval' }, text: 'hi' }), false); // text present
  assert.equal(isCardSubmit({ type: 'conversationUpdate', value: { kind: 'approval' } }), false);  // not a message
});
