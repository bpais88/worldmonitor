import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createWatch, listWatches, cancelWatch, cancelWatchesByTarget, cancelWatchesByConversation, cancelWatchesForTeam, evaluateWatches, evaluateDisruptionWatches, WATCH_DWELL_MS } from './watches.mjs';

const genoa = (congestion) => [{ name: 'Genoa', portId: 'genoa', congestion, atPort: 9, inbound: 3 }];

test('port watch: silent baseline, alerts on a sustained transition, no repeat', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Genoa', channel: 'C1', thread: 'T1', createdBy: 'U1' });
  const t = 1_000_000;
  // First eval = baseline (records state, no alert).
  assert.equal((await evaluateWatches({ ports: genoa('clear') }, t)).length, 0);
  // Transition observed but still within the dwell window -> no alert yet.
  assert.equal((await evaluateWatches({ ports: genoa('congested') }, t + 1000)).length, 0);
  // New state has now held past the dwell -> one alert.
  const a = await evaluateWatches({ ports: genoa('congested') }, t + WATCH_DWELL_MS + 1000);
  assert.equal(a.length, 1);
  assert.match(a[0].message, /Genoa.*congested/);
  // Same state again = no repeat.
  assert.equal((await evaluateWatches({ ports: genoa('congested') }, t + WATCH_DWELL_MS + 2000)).length, 0);
  await cancelWatch(w.id);
});

test('port watch condition "clears" fires only on a sustained clearing, not on busy', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Genoa', condition: 'clears', channel: 'C', thread: 'T' });
  const t = 2_000_000;
  await evaluateWatches({ ports: genoa('clear') }, t); // baseline = clear
  // becomes congested and holds past the dwell -> commits silently (we only want "clears")
  await evaluateWatches({ ports: genoa('congested') }, t + 1000);
  assert.equal((await evaluateWatches({ ports: genoa('congested') }, t + WATCH_DWELL_MS + 1000)).length, 0);
  // clears and holds past the dwell -> alert
  await evaluateWatches({ ports: genoa('clear') }, t + WATCH_DWELL_MS + 2000);
  const a = await evaluateWatches({ ports: genoa('clear') }, t + 2 * WATCH_DWELL_MS + 3000);
  assert.equal(a.length, 1);
  assert.match(a[0].message, /cleared/);
  await cancelWatch(w.id);
});

test('vessel watch alerts when the vessel stays delayed past the dwell', async () => {
  const w = await createWatch({ type: 'vessel_delay', target: 'MOBY FANTASY', channel: 'C', thread: 'T' });
  const t = 3_000_000;
  const delayed = [{ name: 'MOBY FANTASY', delay: { slipping: true, reasons: [{ summary: 'rough seas' }] } }];
  await evaluateWatches({ ports: [], vessels: [{ name: 'MOBY FANTASY' }] }, t); // baseline: ok
  await evaluateWatches({ ports: [], vessels: delayed }, t + 1000); // candidate delayed
  const a = await evaluateWatches({ ports: [], vessels: delayed }, t + WATCH_DWELL_MS + 1000);
  assert.equal(a.length, 1);
  assert.match(a[0].message, /MOBY FANTASY.*delayed/);
  await cancelWatch(w.id);
});

test('flapping port state never matures, so it never alerts', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Genoa', condition: 'clears', channel: 'C', thread: 'T' });
  const t = 4_000_000;
  const STEP = 5 * 60_000; // realistic 5-min ticks, shorter than the dwell
  await evaluateWatches({ ports: genoa('busy') }, t); // baseline busy
  let alerts = 0;
  // Oscillate busy<->clear every tick for an hour: each clear reverts before the dwell.
  for (let i = 1; i <= 12; i++) {
    const congestion = i % 2 === 0 ? 'busy' : 'clear';
    alerts += (await evaluateWatches({ ports: genoa(congestion) }, t + i * STEP)).length;
  }
  assert.equal(alerts, 0, 'flapping must produce no alerts');
  await cancelWatch(w.id);
});

test('a sustained clear still alerts (once) after the flapping settles', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Genoa', condition: 'clears', channel: 'C', thread: 'T' });
  const t = 5_000_000;
  const STEP = 5 * 60_000;
  await evaluateWatches({ ports: genoa('busy') }, t); // baseline busy
  for (let i = 1; i <= 6; i++) { // flap for a while
    await evaluateWatches({ ports: genoa(i % 2 === 0 ? 'busy' : 'clear') }, t + i * STEP);
  }
  let alerts = 0; // then clear holds steadily, well past the dwell
  for (let i = 7; i <= 16; i++) {
    alerts += (await evaluateWatches({ ports: genoa('clear') }, t + i * STEP)).length;
  }
  assert.equal(alerts, 1, 'exactly one alert once the clear is sustained');
  await cancelWatch(w.id);
});

test('list and cancel watches', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Bari', channel: 'C', thread: 'T' });
  assert.ok((await listWatches()).some((x) => x.id === w.id));
  assert.equal(await cancelWatch(w.id), true);
  assert.ok(!(await listWatches()).some((x) => x.id === w.id));
});

test('listWatches scoped by team returns only that workspace’s watches', async () => {
  const a = await createWatch({ type: 'port_congestion', target: 'Salerno', team: 'WS_A', channel: 'C', thread: 'T' });
  const b = await createWatch({ type: 'port_congestion', target: 'Trieste', team: 'WS_B', channel: 'C', thread: 'T' });
  const onlyA = await listWatches({ team: 'WS_A' });
  assert.ok(onlyA.some((w) => w.id === a.id), 'A’s watch present');
  assert.ok(!onlyA.some((w) => w.id === b.id), 'B’s watch absent from A’s list');
  await cancelWatch(a.id);
  await cancelWatch(b.id);
});

test('cancelWatch refuses to cancel another workspace’s watch (tenant guard)', async () => {
  const b = await createWatch({ type: 'port_congestion', target: 'Ancona', team: 'WS_B', channel: 'C', thread: 'T' });
  // Workspace A tries to cancel B’s watch by id -> rejected, watch survives.
  assert.equal(await cancelWatch(b.id, { team: 'WS_A' }), false);
  assert.ok((await listWatches({ team: 'WS_B' })).some((w) => w.id === b.id), 'B’s watch survives A’s attempt');
  // B cancels its own -> ok.
  assert.equal(await cancelWatch(b.id, { team: 'WS_B' }), true);
});

test('cancelWatchesByTarget cancels by name within a team, leaving others', async () => {
  const a = await createWatch({ type: 'port_congestion', target: 'Porto Marghera', team: 'WS_A', channel: 'C', thread: 'T' });
  const aOther = await createWatch({ type: 'port_congestion', target: 'Genoa', team: 'WS_A', channel: 'C', thread: 'T' });
  const bSame = await createWatch({ type: 'port_congestion', target: 'Porto Marghera', team: 'WS_B', channel: 'C', thread: 'T' });
  const cancelled = await cancelWatchesByTarget({ team: 'WS_A', target: 'porto marghera' });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].id, a.id);
  // A’s other-port watch and B’s same-name watch (different workspace) are untouched.
  assert.ok((await listWatches({ team: 'WS_A' })).some((w) => w.id === aOther.id), 'A’s other-port watch kept');
  assert.ok((await listWatches({ team: 'WS_B' })).some((w) => w.id === bSame.id), 'B’s same-name watch kept (different workspace)');
  await cancelWatch(aOther.id);
  await cancelWatch(bSame.id);
});

test('cancelWatchesByTarget matches leniently (substring); empty when nothing matches', async () => {
  const a = await createWatch({ type: 'port_congestion', target: 'Porto Marghera', team: 'WS_C', channel: 'C', thread: 'T' });
  // A substring of the stored target resolves it ("marghera" -> "Porto Marghera").
  const cancelled = await cancelWatchesByTarget({ team: 'WS_C', target: 'marghera' });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].id, a.id);
  // Nothing left, and an unknown name returns [].
  assert.deepEqual(await cancelWatchesByTarget({ team: 'WS_C', target: 'nowhere' }), []);
});

test('cancelWatchesForTeam removes only that workspace’s watches (uninstall)', async () => {
  const a1 = await createWatch({ type: 'port_congestion', target: 'Genoa', team: 'T_A', channel: 'C', thread: 'T' });
  const a2 = await createWatch({ type: 'vessel_delay', target: 'MOBY X', team: 'T_A', channel: 'C', thread: 'T' });
  const b1 = await createWatch({ type: 'port_congestion', target: 'Bari', team: 'T_B', channel: 'C', thread: 'T' });
  assert.equal(await cancelWatchesForTeam('T_A'), 2);
  const remaining = await listWatches();
  assert.ok(!remaining.some((w) => w.id === a1.id || w.id === a2.id), 'T_A watches gone');
  assert.ok(remaining.some((w) => w.id === b1.id), 'T_B watch kept');
  await cancelWatch(b1.id);
});

test('createWatch defaults platform to slack; carries platform + deliver for Teams', async () => {
  const slackW = await createWatch({ type: 'port_congestion', target: 'Genoa', channel: 'C', thread: 'T', team: 'WS' });
  assert.equal(slackW.platform, 'slack');     // default keeps existing Slack watches unchanged
  assert.equal(slackW.deliver, undefined);
  // A Teams watch carries its conversation reference so the ticker can deliver without a token lookup.
  const deliver = { serviceUrl: 'https://smba/', from: { id: '28:bot' }, recipient: { id: '29:user' } };
  const teamsW = await createWatch({ type: 'port_congestion', target: 'Trieste', channel: 'a:conv', team: 'tnt', platform: 'teams', deliver });
  assert.equal(teamsW.platform, 'teams');
  assert.deepEqual(teamsW.deliver, deliver);
  await cancelWatch(slackW.id);
  await cancelWatch(teamsW.id);
});

test('cancelWatchesByConversation cancels a removed Teams conversation’s watches (exact 1:1 + channel prefix), scoped', async () => {
  const T = 'CONV_T';
  const dm = await createWatch({ type: 'port_congestion', target: 'Genoa', team: T, platform: 'teams', channel: 'a:conv1' });
  const ch = await createWatch({ type: 'port_congestion', target: 'Bari', team: T, platform: 'teams', channel: '19:abc@thread.tacv2;messageid=42' });
  const other = await createWatch({ type: 'port_congestion', target: 'Trieste', team: T, platform: 'teams', channel: 'a:conv2' });
  // Bot removed from the 1:1 (channel === conversationId) -> exact match.
  assert.equal(await cancelWatchesByConversation({ team: T, conversationId: 'a:conv1' }), 1);
  // Bot removed from the channel (root id, no ;messageid=) -> prefix-matches the thread watch.
  assert.equal(await cancelWatchesByConversation({ team: T, conversationId: '19:abc@thread.tacv2' }), 1);
  const remaining = (await listWatches({ team: T })).map((w) => w.id);
  assert.ok(!remaining.includes(dm.id) && !remaining.includes(ch.id), 'removed-conversation watches gone');
  assert.ok(remaining.includes(other.id), 'a different conversation’s watch survives');
  await cancelWatch(other.id);
});

// --- M4: proactive disruption alerts ---------------------------------------------------------

const GENOA = { portId: 'genoa', name: 'Genoa', congestion: 'clear', atPort: 3, inbound: 2 };
const STRIKE = { id: 'mit/9001', kind: 'strike_scheduled', summary: 'Scheduled Marittimo strike (national)', startsAt: Date.now() + 3 * 86_400_000 };

test('disruption alerts: fire once per event per watch, then stay silent (dedupe survives re-ticks)', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Genoa', channel: 'C1', team: 'T1' });
  const fetcher = async () => [STRIKE];
  const first = await evaluateDisruptionWatches({ ports: [GENOA], fetchPortDisruptions: fetcher });
  assert.equal(first.length, 1);
  assert.match(first[0].message, /Scheduled strike affecting Genoa/);
  assert.match(first[0].message, /in 3 days/);
  const second = await evaluateDisruptionWatches({ ports: [GENOA], fetchPortDisruptions: fetcher });
  assert.equal(second.length, 0, 'same event must never alert twice');
  await cancelWatch(w.id);
});

test('disruption alerts: official calendar only — news reports never page', async () => {
  const w = await createWatch({ type: 'port_disruption', target: 'Genoa', channel: 'C1', team: 'T1' });
  const out = await evaluateDisruptionWatches({ ports: [GENOA], fetchPortDisruptions: async () => [
    { id: 'gdelt:x', kind: 'strike_report', summary: 'reportedly a strike', confidence: 0.4 },
  ] });
  assert.equal(out.length, 0);
  await cancelWatch(w.id);
});

test('disruption alerts: one relay fetch per distinct port, all its watches alerted', async () => {
  const w1 = await createWatch({ type: 'port_congestion', target: 'Genoa', channel: 'C1', team: 'T1' });
  const w2 = await createWatch({ type: 'port_disruption', target: 'genoa', channel: 'C2', team: 'T2' });
  let calls = 0;
  const out = await evaluateDisruptionWatches({ ports: [GENOA], fetchPortDisruptions: async () => { calls++; return [STRIKE]; } });
  assert.equal(calls, 1, 'grouped by port — one fetch');
  assert.equal(out.length, 2, 'both watches on the port alert');
  await cancelWatch(w1.id); await cancelWatch(w2.id);
});

test('disruption alerts: vessel watches and unknown ports stay silent; fetch failure degrades', async () => {
  const wv = await createWatch({ type: 'vessel_delay', target: 'MOBY X', channel: 'C1', team: 'T1' });
  const wu = await createWatch({ type: 'port_disruption', target: 'Atlantis', channel: 'C1', team: 'T1' });
  const wf = await createWatch({ type: 'port_disruption', target: 'Genoa', channel: 'C1', team: 'T1' });
  const out = await evaluateDisruptionWatches({ ports: [GENOA], fetchPortDisruptions: async () => { throw new Error('boom'); } });
  assert.equal(out.length, 0);
  await cancelWatch(wv.id); await cancelWatch(wu.id); await cancelWatch(wf.id);
});

// ---- 'all ports' wildcard disruption watch ------------------------------------------------------

const DAY = 86_400_000;
const wildcardEvents = (t) => [
  // national strike 2 days out — would match many ports; must alert ONCE
  { id: 's-near', kind: 'strike_scheduled', national: true, country: 'IT', startsAt: t + 2 * DAY, summary: 'National maritime strike' },
  // 30 days out — beyond the 7-day push window; silent until it comes inside
  { id: 's-far', kind: 'strike_scheduled', country: 'IT', region: 'Liguria', startsAt: t + 30 * DAY, summary: 'Regional strike far out' },
  // news report — never pushes (official calendar only)
  { id: 'r-news', kind: 'strike_report', country: 'IT', summary: 'Union threatens action' },
];

test('all-ports watch: one alert per scheduled strike, 7-day lookahead, no repeat, far strike fires when due', async () => {
  const w = await createWatch({ type: 'port_disruption', target: 'all ports', channel: 'C', createdBy: 'U', team: 'T1' });
  const t = 5_000_000;
  let calls = 0;
  const fetchAllDisruptions = async () => { calls++; return wildcardEvents(t); };
  // First eval: only the near national strike (far is outside the window, report never pushes).
  const first = await evaluateDisruptionWatches({ ports: [], fetchAllDisruptions }, t);
  assert.equal(first.length, 1);
  assert.match(first[0].message, /national · IT/);
  assert.match(first[0].message, /in 2 days/);
  assert.equal(calls, 1); // one unfiltered fetch, no per-port calls
  // Second eval: already notified -> silent.
  assert.equal((await evaluateDisruptionWatches({ ports: [], fetchAllDisruptions }, t + 1000)).length, 0);
  // 24 days later the far strike enters the 7-day window -> fires once, near one stays deduped.
  const later = await evaluateDisruptionWatches({ ports: [], fetchAllDisruptions }, t + 24 * DAY);
  assert.equal(later.length, 1);
  assert.match(later[0].message, /Liguria/);
  await cancelWatch(w.id);
});

test('all-ports watch: fetch failure marks nothing seen — alert still fires on the next tick', async () => {
  const w = await createWatch({ type: 'port_disruption', target: 'all ports', channel: 'C', createdBy: 'U', team: 'T2' });
  const t = 6_000_000;
  let fail = true;
  const fetchAllDisruptions = async () => { if (fail) throw new Error('relay 502'); return wildcardEvents(t); };
  assert.equal((await evaluateDisruptionWatches({ ports: [], fetchAllDisruptions }, t)).length, 0);
  fail = false;
  assert.equal((await evaluateDisruptionWatches({ ports: [], fetchAllDisruptions }, t + 1000)).length, 1);
  await cancelWatch(w.id);
});

test('all-ports watch coexists with per-port watches; "stop watching all ports" cancels it', async () => {
  const all = await createWatch({ type: 'port_disruption', target: 'all ports', channel: 'C', createdBy: 'U', team: 'T3' });
  const one = await createWatch({ type: 'port_disruption', target: 'Genoa', channel: 'C', createdBy: 'U', team: 'T3' });
  const t = 7_000_000;
  const ev = [{ id: 's-x', kind: 'strike_scheduled', national: true, country: 'IT', startsAt: t + DAY, summary: 'Strike' }];
  const alerts = await evaluateDisruptionWatches({
    ports: [{ name: 'Genoa', portId: 'genoa', congestion: 'clear', atPort: 1, inbound: 0 }],
    fetchAllDisruptions: async () => ev,
    fetchPortDisruptions: async () => ev,
  }, t);
  // one alert per WATCH (different subscriptions), not per port-match within a watch
  assert.equal(alerts.length, 2);
  const cancelled = await cancelWatchesByTarget({ team: 'T3', target: 'all ports' });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].id, all.id);
  await cancelWatch(one.id);
});
