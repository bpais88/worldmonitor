import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { botWasAdded, shouldGreet, teamsOnboardingText } from './onboarding.mjs';

test('botWasAdded: true only when the bot id is in membersAdded (verified, not text-parsed)', () => {
  const base = { recipient: { id: '28:bot' } };
  assert.equal(botWasAdded({ ...base, membersAdded: [{ id: '28:bot' }] }), true);
  assert.equal(botWasAdded({ ...base, membersAdded: [{ id: '29:someone' }] }), false);
  assert.equal(botWasAdded({ ...base }), false);               // no membersAdded
  assert.equal(botWasAdded({ membersAdded: [{ id: '28:bot' }] }), false); // no bot id
});

test('shouldGreet: only when the bot is added to a personal (1:1) chat', () => {
  const added = { recipient: { id: '28:bot' }, membersAdded: [{ id: '28:bot' }] };
  assert.equal(shouldGreet({ ...added, conversation: { conversationType: 'personal' } }), true);
  assert.equal(shouldGreet({ ...added, conversation: { conversationType: 'channel' } }), false); // channels: capture, don't greet
  assert.equal(shouldGreet({ ...added }), true);               // default conversationType is personal
  assert.equal(shouldGreet({ recipient: { id: '28:bot' }, membersAdded: [{ id: '29:x' }], conversation: { conversationType: 'personal' } }), false); // bot not added
});

test('teamsOnboardingText: personal vs channel call-to-action, standard Markdown', () => {
  const personal = teamsOnboardingText('personal');
  const channel = teamsOnboardingText('channel');
  assert.match(personal, /I.m \*\*Marco\*\*/);   // first-person, bold (Teams Markdown)
  assert.match(personal, /message me here/);      // 1:1 CTA
  assert.match(channel, /@mention me/);           // channel CTA
  assert.match(personal, /\n- \*/);               // "- " bullets, not Slack mrkdwn
});
