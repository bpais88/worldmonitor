import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  saveInstallation, getInstallation, listInstallations, removeInstallation,
  getConfig, setConfig, addActionUser,
} from './installations.mjs';

test('save/get/list/remove an installation', async () => {
  const inst = { teamId: 'T1', teamName: 'Acme Freight', botToken: 'xoxb-1', botUserId: 'UBOT', installedBy: 'U1' };
  await saveInstallation(inst);
  assert.equal((await getInstallation('T1')).botToken, 'xoxb-1');
  assert.ok((await listInstallations()).some((i) => i.teamId === 'T1'));
  await removeInstallation('T1');
  assert.equal(await getInstallation('T1'), null);
  assert.ok(!(await listInstallations()).some((i) => i.teamId === 'T1'));
});

test('saveInstallation stamps platform=slack + deliver, keeps botToken readable', async () => {
  await saveInstallation({ teamId: 'TGEN', botToken: 'xoxb-x', botUserId: 'UB', installedBy: 'U' });
  const got = await getInstallation('TGEN');
  assert.equal(got.platform, 'slack');     // generalized record shape
  assert.equal(got.deliver, 'xoxb-x');     // delivery handle for send.mjs
  assert.equal(got.botToken, 'xoxb-x');    // still readable for the legacy path
  await removeInstallation('TGEN');
});

test('getConfig returns full defaults; setConfig shallow-merges', async () => {
  const c0 = await getConfig('T2');
  assert.deepEqual(c0, { ports: [], operators: [], actionUsers: [], onboarded: false });
  await setConfig('T2', { onboarded: true });
  const c1 = await getConfig('T2');
  assert.equal(c1.onboarded, true);
  assert.deepEqual(c1.ports, []); // untouched keys keep defaults
  await removeInstallation('T2');
});

test('addActionUser is idempotent', async () => {
  await addActionUser('T3', 'U9');
  await addActionUser('T3', 'U9');
  assert.deepEqual((await getConfig('T3')).actionUsers, ['U9']);
  await removeInstallation('T3');
});

test('saveInstallation requires teamId', async () => {
  await assert.rejects(() => saveInstallation({ botToken: 'x' }), /teamId required/);
});
