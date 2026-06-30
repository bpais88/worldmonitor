import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeFreshness, agoLabel, clockAmsterdam } from '../src/services/logistics/freshness.ts';

describe('describeFreshness', () => {
  it('shows "as of HH:MM" in Amsterdam time when live', () => {
    const gen = Date.parse('2026-06-23T13:25:07Z'); // 13:25 UTC = 15:25 Amsterdam (CEST, summer)
    const b = describeFreshness({ generatedAt: gen, warming: false, stale: false, ageSec: 8 });
    assert.equal(b.state, 'live');
    assert.equal(b.detail, 'as of 15:25 CEST');
  });

  it('flags warming up (amber) when the relay has not finished its first sweep', () => {
    const b = describeFreshness({ warming: true, stale: false, generatedAt: Date.now() });
    assert.equal(b.state, 'cached');
    assert.equal(b.detail, 'warming up — vessel count still filling');
  });

  it('flags stale (amber) with the data age when ingest has stalled', () => {
    const b = describeFreshness({ warming: false, stale: true, ageSec: 320 });
    assert.equal(b.state, 'cached');
    assert.match(b.detail, /^stale · last update 5m ago$/);
  });

  it('warming takes precedence over stale', () => {
    assert.equal(describeFreshness({ warming: true, stale: true }).detail, 'warming up — vessel count still filling');
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

describe('clockAmsterdam', () => {
  it('renders HH:MM in Amsterdam time (summer = CEST, UTC+2)', () => {
    assert.equal(clockAmsterdam(Date.parse('2026-06-23T09:04:01Z')), '11:04 CEST');
  });
  it('uses CET in winter (UTC+1)', () => {
    assert.equal(clockAmsterdam(Date.parse('2026-01-15T09:04:01Z')), '10:04 CET');
  });
});
