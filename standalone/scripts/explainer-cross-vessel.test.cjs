'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');

const { assessCrossVessel } = require('./explainer-cross-vessel.cjs');

const SUBJECT = { mmsi: 'self', lat: 40.7, lon: 14.2 };
// A ferry near the subject (Bay of Naples); delayed flag overridable.
function near(mmsi, delayed, over = {}) {
  return { mmsi, lat: 40.72, lon: 14.22, delayed, ...over };
}

test('flags systemic when several nearby ferries are also delayed', () => {
  const ferries = [
    SUBJECT_AS_FERRY(),
    near('a', true), near('b', true), near('c', true),
  ];
  const r = assessCrossVessel(SUBJECT, ferries);
  assert.ok(r);
  assert.equal(r.source, 'fleet');
  assert.equal(r.kind, 'systemic_delay');
  assert.match(r.summary, /3/);
  assert.match(r.summary, /area-wide/i);
});

function SUBJECT_AS_FERRY() {
  return { mmsi: 'self', lat: 40.7, lon: 14.2, delayed: true };
}

test('flags isolated when nearby ferries are present but none delayed', () => {
  const ferries = [
    SUBJECT_AS_FERRY(),
    near('a', false), near('b', false), near('c', false),
  ];
  const r = assessCrossVessel(SUBJECT, ferries);
  assert.ok(r);
  assert.equal(r.kind, 'isolated_delay');
  assert.match(r.summary, /vessel-specific/i);
});

test('returns null when too few nearby ferries to judge', () => {
  const ferries = [SUBJECT_AS_FERRY(), near('a', false)]; // only 1 peer
  assert.equal(assessCrossVessel(SUBJECT, ferries), null);
});

test('returns null with one delayed peer (ambiguous, below systemic threshold)', () => {
  const ferries = [SUBJECT_AS_FERRY(), near('a', true), near('b', false)];
  // 1 delayed peer (<2) and only 2 peers (<3 observed) -> null
  assert.equal(assessCrossVessel(SUBJECT, ferries), null);
});

test('ignores delayed ferries outside the radius', () => {
  const far = [
    SUBJECT_AS_FERRY(),
    { mmsi: 'x', lat: 38.1, lon: 13.4, delayed: true },
    { mmsi: 'y', lat: 38.2, lon: 13.5, delayed: true },
    { mmsi: 'z', lat: 38.0, lon: 13.3, delayed: true },
  ];
  assert.equal(assessCrossVessel(SUBJECT, far), null);
});

test('excludes the subject itself from peers', () => {
  // subject marked delayed; only itself + 2 non-delayed peers -> not systemic
  const ferries = [SUBJECT_AS_FERRY(), near('a', false), near('b', false)];
  // 2 peers, 0 delayed, but <3 observed -> null (not enough to call isolated)
  assert.equal(assessCrossVessel(SUBJECT, ferries), null);
});
