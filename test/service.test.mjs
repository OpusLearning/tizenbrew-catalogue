import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTvApi, startHelper, tempConfig } from './helpers.mjs';

let tv, helper, cfg;
before(async () => {
  tv = await startFakeTvApi({ 'madebypatk.vlcweb': '1.31.0', '111299001912': '2.1.513' });
  cfg = tempConfig({ modules: ['npm/@foxreis/tizentube'], autoLaunchServiceList: [], autoLaunchModule: 'npm/@foxreis/tizentube' });
  process.env.TEST_ORIGIN = 'http://127.0.0.1:1';
  helper = await startHelper({ tvPort: tv.port, configPath: cfg });
});
after(async () => { helper.stop(); await tv.close(); });

const get = async (p, init) => { const r = await fetch(helper.base + p, init); return { status: r.status, body: await r.json(), headers: r.headers }; };

test('health', async () => { assert.equal((await get('/health')).body.ok, true); });
test('installed standalone app', async () => {
  assert.deepEqual((await get('/apps/madebypatk.vlcweb')).body, { ok: true, installed: true, running: false, version: '1.31.0' });
});
test('missing standalone app reports not installed', async () => {
  assert.deepEqual((await get('/apps/MoonLightS.MoonlightWasm')).body, { ok: true, installed: false });
});
test('apps outside the catalogue are refused (no generic launcher)', async () => {
  const r = await get('/apps/111299001912/launch', { method: 'POST' });
  assert.equal(r.status, 403);
  assert.equal(tv.log.posts.length, 0);
});
test('launch goes to the TV API', async () => {
  assert.equal((await get('/apps/madebypatk.vlcweb/launch', { method: 'POST' })).body.ok, true);
  assert.deepEqual(tv.log.posts, ['madebypatk.vlcweb']);
});
test('launching a missing app fails honestly', async () => {
  const r = await get('/apps/MoonLightS.MoonlightWasm/launch', { method: 'POST' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /not installed/);
});
test('reads autolaunch read-only', async () => {
  assert.equal((await get('/autolaunch')).body.autoLaunchModule, 'npm/@foxreis/tizentube');
});
test('CORS only for the module origin', async () => {
  const good = await get('/health', { headers: { Origin: 'http://127.0.0.1:8081' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8081');
  const bad = await get('/health', { headers: { Origin: 'http://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
