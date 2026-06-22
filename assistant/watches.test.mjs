import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createWatch, listWatches, cancelWatch, evaluateWatches } from './watches.mjs';

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
