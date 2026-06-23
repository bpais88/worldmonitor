import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeFreshness, agoLabel, clockUtc } from '../src/services/logistics/freshness.ts';

describe('describeFreshness', () => {
  it('shows "as of HH:MM:SS UTC" when live', () => {
    const gen = Date.parse('2026-06-23T13:25:07Z');
    const b = describeFreshness({ generatedAt: gen, warming: false, stale: false, ageSec: 8 });
    assert.equal(b.state, 'live');
    assert.equal(b.detail, 'as of 13:25:07 UTC');
  });

  it('flags warming up (amber) when the relay has not finished its first sweep', () => {
    const b = describeFreshness({ warming: true, stale: false, generatedAt: Date.now() });
    assert.equal(b.state, 'cached');
    assert.equal(b.detail, 'warming up…');
  });

  it('flags stale (amber) with the data age when ingest has stalled', () => {
    const b = describeFreshness({ warming: false, stale: true, ageSec: 320 });
    assert.equal(b.state, 'cached');
    assert.match(b.detail, /^stale · last update 5m ago$/);
  });

  it('warming takes precedence over stale', () => {
    assert.equal(describeFreshness({ warming: true, stale: true }).detail, 'warming up…');
  });

  it('no meta → plain live badge', () => {
    assert.deepEqual(describeFreshness(undefined), { state: 'live', detail: '' });
  });
});

describe('agoLabel', () => {
  it('formats seconds, minutes, hours', () => {
    assert.equal(agoLabel(8), '8s ago');
    assert.equal(agoLabel(150), '3m ago');
    assert.equal(agoLabel(7200), '2h ago');
    assert.equal(agoLabel(undefined), 'just now');
  });
});

describe('clockUtc', () => {
  it('renders HH:MM:SS UTC', () => {
    assert.equal(clockUtc(Date.parse('2026-06-23T09:04:01Z')), '09:04:01 UTC');
  });
});
