import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildOpsReport, buildUnreachableReport, isReportDue, nextCleanSince } from './ops-report.mjs';

// A healthy /health body, shaped exactly like the live relay's (captured 2026-07-14).
const healthy = () => ({
  status: 'ok',
  connected: true,
  trips: {
    enabled: true, openTripsTracked: 619, openTripsInGrace: 153, tripsResumed: 3314,
    oldestOpenTripAgeMin: 4000, tripPointsBuffered: 0, tripsOpened: 2246, tripsArrived: 1435,
    tripsAbandoned: 789, tripPointRows: 81162, tripPointsDropped: 0, lastTripWriteOk: true,
    lastTripError: null, degraded: false,
  },
  portHistory: {
    enabled: true, dbEnabled: true, degraded: false, zones: 39, snapshotRows: 9126, eventRows: 10862,
    lastWriteOk: true, lastError: null,
    baselineMaturity: { buckets: 6552, trusted: 0, trustedFrac: 0, portsWithTrusted: 0, maxDays: 2, minDaysToTrust: 3 },
  },
});

const TUE = Date.parse('2026-07-14T06:01:00Z');
const SUN = Date.parse('2026-07-19T06:01:00Z');

test('clean relay past the 7-day window reports the gate as satisfied', () => {
  const r = buildOpsReport({ health: healthy(), now: TUE, cleanSince: '2026-07-02' });
  assert.match(r, /✅ LAUNCH GATE SATISFIED — trips clean 12d/);
  assert.match(r, /open decision #7/);
  assert.match(r, /arrived 1435 · abandoned 789 \(65% arrive\)/);
  assert.match(r, /0\/6552 trusted \(0%\) · 0\/39 ports · maxDays 2\/3 — trust is ~1 week out/);
  assert.doesNotMatch(r, /⚠️/); // a clean relay produces no anomaly lines
});

test('degraded trips lead with the gate reset, not the numbers', () => {
  const h = healthy();
  h.trips.degraded = true;
  h.trips.lastTripWriteOk = false;
  h.trips.lastTripError = 'ECONNRESET';
  const r = buildOpsReport({ health: h, now: TUE, cleanSince: '2026-07-14' });
  assert.match(r.split('\n')[0], /🚨 GATE RESET/);
  assert.match(r, /ECONNRESET/);
});

test('mid-window clean streak counts the day', () => {
  const r = buildOpsReport({ health: healthy(), now: TUE, cleanSince: '2026-07-11' });
  assert.match(r, /⏳ Launch gate: day 3 of 7 clean/);
});

test('anomalies surface: dropped points, oldest-open near the 120h cap, wide grace', () => {
  const h = healthy();
  h.trips.tripPointsDropped = 12;
  h.trips.oldestOpenTripAgeMin = 7112;   // 98.8% of the 7200 cap that would flip degraded
  h.trips.openTripsInGrace = 400;        // 400/619 = 65% of open trips
  const r = buildOpsReport({ health: h, now: TUE, cleanSince: '2026-07-02' });
  assert.match(r, /⚠️ tripPointsDropped=12/);
  assert.match(r, /⚠️ oldestOpenTripAgeMin 7112 is within 5% of the 7200 cap/);
  assert.match(r, /⚠️ 65% of open trips are in the anchor-loss grace window/);
});

test('first trusted baselines are called out; a mature fraction flags the backtest', () => {
  const h = healthy();
  h.portHistory.baselineMaturity = { buckets: 6552, trusted: 40, trustedFrac: 0.006, portsWithTrusted: 3, maxDays: 3, minDaysToTrust: 3 };
  assert.match(buildOpsReport({ health: h, now: TUE, cleanSince: '2026-07-02' }), /🎉 first trusted buckets/);
  h.portHistory.baselineMaturity = { buckets: 6552, trusted: 4000, trustedFrac: 0.61, portsWithTrusted: 30, maxDays: 5, minDaysToTrust: 3 };
  assert.match(buildOpsReport({ health: h, now: TUE, cleanSince: '2026-07-02' }), /backtest is becoming feasible/);
});

test('a relay predating the baselineMaturity field is noted, not treated as an error', () => {
  const h = healthy();
  delete h.portHistory.baselineMaturity;
  const r = buildOpsReport({ health: h, now: TUE, cleanSince: '2026-07-02' });
  assert.match(r, /baselineMaturity missing from \/health .* not an error/);
});

test('the Sunday checklist only appears on Sundays, and gains the WoW line from 2026-07-26', () => {
  assert.doesNotMatch(buildOpsReport({ health: healthy(), now: TUE, cleanSince: '2026-07-02' }), /Sunday checklist/);
  const sun = buildOpsReport({ health: healthy(), now: SUN, cleanSince: '2026-07-02' });
  assert.match(sun, /— Sunday checklist —/);
  assert.match(sun, /npm run report:corridor/);
  assert.doesNotMatch(sun, /Week-over-week deltas are now/); // Jul 19 < Jul 26
  const later = buildOpsReport({ health: healthy(), now: Date.parse('2026-07-26T06:01:00Z'), cleanSince: '2026-07-02' });
  assert.match(later, /Week-over-week deltas are now methodologically valid/);
});

test('an unreachable relay is louder than a degraded one', () => {
  const r = buildUnreachableReport({ error: 'fetch failed', attempts: 2 });
  assert.match(r.split('\n')[0], /🚨 RELAY UNREACHABLE/);
  assert.match(r, /2 attempt\(s\)/);
});

test('degraded resets the clean-week clock to today; clean carries the streak', () => {
  assert.equal(nextCleanSince({ degraded: true, writeOk: true, today: '2026-07-14', cleanSince: '2026-07-02' }), '2026-07-14');
  assert.equal(nextCleanSince({ degraded: false, writeOk: false, today: '2026-07-14', cleanSince: '2026-07-02' }), '2026-07-14');
  assert.equal(nextCleanSince({ degraded: false, writeOk: true, today: '2026-07-14', cleanSince: '2026-07-02' }), '2026-07-02');
  assert.equal(nextCleanSince({ degraded: false, writeOk: true, today: '2026-07-14', cleanSince: null }), '2026-07-02'); // first run
});

test('due once per day, after the send hour, and never twice', () => {
  const at = (t) => Date.parse(`2026-07-14T${t}Z`);
  assert.equal(isReportDue({ now: at('05:59:00'), lastSent: '2026-07-13' }), false); // before the hour
  assert.equal(isReportDue({ now: at('06:00:00'), lastSent: '2026-07-13' }), true);
  assert.equal(isReportDue({ now: at('06:00:00'), lastSent: '2026-07-14' }), false); // already sent today
  assert.equal(isReportDue({ now: at('09:30:00'), lastSent: '2026-07-13' }), true);  // late boot, inside catch-up
  assert.equal(isReportDue({ now: at('23:00:00'), lastSent: '2026-07-13' }), false); // past catch-up — skip to tomorrow
});
