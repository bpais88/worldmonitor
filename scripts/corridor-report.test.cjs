'use strict';

const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const { isoWeek, buildModel, renderHtml, renderText, opName, fmtDur, upcomingStrikes, OPERATOR_SOLID_N } = require('./corridor-report.cjs');

const RAW = {
  head: { fleet: 1873, arrivals_7d: 4200, points: 1_164_955, snapshots: 116_000 },
  dow: [
    { dy: 'Sun', d: 0, n: 1431 }, { dy: 'Mon', d: 1, n: 694 }, { dy: 'Tue', d: 2, n: 672 },
    { dy: 'Wed', d: 3, n: 598 }, { dy: 'Thu', d: 4, n: 919 }, { dy: 'Fri', d: 5, n: 1398 }, { dy: 'Sat', d: 6, n: 981 },
  ],
  peaks: [{ dest_port_id: 'genoa', name: 'Genoa', peak: 15, n: 1061 }],
  dwell: [
    { dest_port_id: 'vlissingen', name: 'Vlissingen', med: 46, n: 208 },
    { dest_port_id: 'livorno', name: 'Livorno', med: 2, n: 300 }, // transit artifact — must be gated out
  ],
  operators: [{ op: 'gnv', pct: 81, n: 37 }, { op: 'msc_line', pct: 65, n: 130 }],
  corridors: [{ o: 'rotterdam', d: 'felixstowe', oname: 'Rotterdam', dname: 'Felixstowe', med: 346, n: 17 }],
  berth: [{ port_id: 'rotterdam', name: 'Rotterdam', mean: 35, p90: 46 }],
};

test('isoWeek: mid-year date lands in the right ISO week', () => {
  assert.deepStrictEqual(isoWeek(new Date('2026-07-12T12:00:00Z')), { year: 2026, week: 28 });
  assert.deepStrictEqual(isoWeek(new Date('2026-01-01T12:00:00Z')), { year: 2026, week: 1 });
});

test('buildModel: busiest/quietest days and early-signal flag', () => {
  const m = buildModel(RAW, null, new Date('2026-07-12T12:00:00Z'));
  assert.equal(m.busiestDow.dy, 'Sun');
  assert.equal(m.quietestDow.dy, 'Wed');
  assert.equal(m.operatorsEarly, true); // gnv n=37 < OPERATOR_SOLID_N
  assert.ok(OPERATOR_SOLID_N > 0);
  assert.equal(m.operators[0].name, 'GNV'); // id → display name
});

test('buildModel gates out sub-plausible dwell medians (geofence-transit artifacts)', () => {
  const m = buildModel(RAW, null, new Date('2026-07-12T12:00:00Z'));
  assert.deepStrictEqual(m.dwell.map((d) => d.name), ['Vlissingen']); // Livorno 2min dropped
});

test('renderHtml: sections present when fed, thin strike section suppressed when null', () => {
  const m = buildModel(RAW, null, new Date('2026-07-12T12:00:00Z'));
  const html = renderHtml(m);
  assert.match(html, /Freight Corridor Report/);
  assert.match(html, /WEEK 28 \/ 2026/);
  assert.match(html, /Genoa/);
  assert.match(html, /15:00/);          // peak hour formatted
  assert.match(html, /5\.8h/);          // 346min corridor as hours
  assert.match(html, /treat as directional/); // early-signal caveat present
  assert.ok(!html.includes('Scheduled strikes'), 'strike section suppressed without data');
});

test('renderHtml: empty datasets suppress their sections entirely (never padded)', () => {
  const m = buildModel({ ...RAW, peaks: [], dwell: [], corridors: [], berth: [], operators: [] }, null, new Date('2026-07-12T12:00:00Z'));
  const html = renderHtml(m);
  assert.ok(!html.includes('When ports actually peak'));
  assert.ok(!html.includes('Turnaround league'));
  assert.ok(!html.includes('Corridor benchmarks'));
  assert.ok(!html.includes('Operator punctuality'));
});

test('renderHtml escapes injected names', () => {
  const dirty = { ...RAW, peaks: [{ dest_port_id: 'x', name: '<script>alert(1)</script>', peak: 9, n: 60 }] };
  const html = renderHtml(buildModel(dirty, null, new Date('2026-07-12T12:00:00Z')));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderText produces a paste-ready digest with the headline finding', () => {
  const txt = renderText(buildModel(RAW, null, new Date('2026-07-12T12:00:00Z')));
  assert.match(txt, /week 28\/2026/);
  assert.match(txt, /Heaviest day: Sun/);
  assert.match(txt, /Genoa 15:00/);
});

test('upcomingStrikes windows to [now, now+14d]: past and far-future events are dropped', () => {
  const NOW = Date.parse('2026-07-12T12:00:00Z');
  const DAY = 86_400_000;
  const ev = (startsAt, id) => ({ id, kind: 'strike_scheduled', startsAt, summary: id });
  const events = [
    ev(NOW - 2 * DAY, 'expired'),          // relay cache can carry these — must not show
    ev(NOW + 5 * DAY, 'in-window-late'),
    ev(NOW + 1 * DAY, 'in-window-early'),
    ev(NOW + 20 * DAY, 'beyond-window'),
    { id: 'news', kind: 'strike_report', startsAt: NOW + 3 * DAY },   // news, not calendar
    { id: 'undated', kind: 'strike_scheduled' },                       // no startsAt
  ];
  assert.deepStrictEqual(upcomingStrikes(events, NOW).map((e) => e.id), ['in-window-early', 'in-window-late']);
  assert.deepStrictEqual(upcomingStrikes(null, NOW), []);
});

test('formatting helpers', () => {
  assert.equal(fmtDur(46), '46min');
  assert.equal(fmtDur(346), '5.8h');
  assert.equal(opName('cma_cgm'), 'CMA CGM');
  assert.equal(opName('some_new_op'), 'Some New Op');
});
