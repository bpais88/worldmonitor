import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createWatch, listWatches, cancelWatch, cancelWatchesByTarget, cancelWatchesForTeam, evaluateWatches } from './watches.mjs';

const genoa = (congestion) => [{ name: 'Genoa', portId: 'genoa', congestion, atPort: 9, inbound: 3 }];

test('port watch: silent baseline, alerts on transition, no repeat', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Genoa', channel: 'C1', thread: 'T1', createdBy: 'U1' });
  // First eval = baseline (records state, no alert).
  assert.equal((await evaluateWatches({ ports: genoa('clear'), vessels: [] })).length, 0);
  // Transition clear -> congested = one alert.
  const a = await evaluateWatches({ ports: genoa('congested'), vessels: [] });
  assert.equal(a.length, 1);
  assert.match(a[0].message, /Genoa.*congested/);
  // Same state again = no repeat.
  assert.equal((await evaluateWatches({ ports: genoa('congested'), vessels: [] })).length, 0);
  await cancelWatch(w.id);
});

test('port watch condition "clears" fires only on clearing, not on busy', async () => {
  const w = await createWatch({ type: 'port_congestion', target: 'Genoa', condition: 'clears', channel: 'C', thread: 'T' });
  await evaluateWatches({ ports: genoa('clear'), vessels: [] }); // baseline
  // becomes congested -> must NOT alert (we only want "clears")
  assert.equal((await evaluateWatches({ ports: genoa('congested'), vessels: [] })).length, 0);
  // clears -> alert
  const a = await evaluateWatches({ ports: genoa('clear'), vessels: [] });
  assert.equal(a.length, 1);
  assert.match(a[0].message, /cleared/);
  await cancelWatch(w.id);
});

test('vessel watch alerts when the vessel becomes delayed', async () => {
  const w = await createWatch({ type: 'vessel_delay', target: 'MOBY FANTASY', channel: 'C', thread: 'T' });
  await evaluateWatches({ ports: [], vessels: [{ name: 'MOBY FANTASY' }] }); // baseline: ok
  const a = await evaluateWatches({ ports: [], vessels: [{ name: 'MOBY FANTASY', delay: { slipping: true, reasons: [{ summary: 'rough seas' }] } }] });
  assert.equal(a.length, 1);
  assert.match(a[0].message, /MOBY FANTASY.*delayed/);
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
