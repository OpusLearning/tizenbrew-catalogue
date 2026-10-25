// Remote-only UI tests: headless Chrome at 1920x1080, keyboard arrows/Enter/Back only, against a
// TizenBrew service double and the real helper service. Covers browse, details, search, add (success,
// failure, retry), open, installed, favourites persistence, standalone status/open, autolaunch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startMockTizenBrew } from './mock-tizenbrew.mjs';
import { startFakeTvApi, startHelper, tempConfig, moduleDir } from './helpers.mjs';

const SELF = 'gh/test/tizenbrew-catalogue';
const appPkg = (name, appName) => ({ 'package.json': { name, version: '1.0.0', packageType: 'app', appName, appPath: 'index.html', keys: [] },
  'index.html': `<!doctype html><title>${appName}</title><h1>${appName} running</h1>` });
const registry = {
  'npm/@foxreis/tizentube': { 'package.json': { name: '@foxreis/tizentube', version: '1.15.2', packageType: 'mods', appName: 'TizenTube', websiteURL: 'about:blank', main: 'dist/userScript.js' } },
  'npm/@jjg0/twizen': appPkg('@jjg0/twizen', 'Twizen'),
  'npm/@glenlowland/jellyfin-tizen': appPkg('@glenlowland/jellyfin-tizen', 'Jellyfin'),
  'npm/@pindagus/jellyfin-tizenbrew': appPkg('@pindagus/jellyfin-tizenbrew', 'Jellyfin'),
  'npm/tizenbrew-iptv': appPkg('tizenbrew-iptv', 'IPTV Player')
  // gh/tenda96/moonfin-tizenbrew deliberately missing: used for the failure test
};
const BASELINE = ['npm/@foxreis/tizentube', 'npm/@jjg0/twizen', 'npm/@glenlowland/jellyfin-tizen', 'npm/tizenbrew-iptv', SELF];

let tb, tv, helper, browser, page, cfgPath;
const url = () => `http://127.0.0.1:${tb.port}/module/${encodeURIComponent(SELF)}/app/index.html?helper=${encodeURIComponent(helper.base)}`;

before(async () => {
  cfgPath = tempConfig({ modules: BASELINE.slice(), autoLaunchServiceList: [], autoLaunchModule: 'npm/@foxreis/tizentube' });
  tb = await startMockTizenBrew({ configPath: cfgPath, registry, selfId: SELF, selfDir: moduleDir });
  tv = await startFakeTvApi({ 'madebypatk.vlcweb': '1.31.0' });
  process.env.TEST_ORIGIN = `http://127.0.0.1:${tb.port}`;
  helper = await startHelper({ tvPort: tv.port, configPath: cfgPath });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(url());
  await page.waitForFunction(() => document.querySelector('#conn').textContent.startsWith('Connected'));
});
after(async () => { await browser?.close(); helper?.stop(); await tv?.close(); await tb?.close(); });

const press = async (key, times = 1) => { for (let i = 0; i < times; i++) { await page.keyboard.press(key); await new Promise((r) => setTimeout(r, 40)); } };
const back = () => page.evaluate(() => { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => 10009 }); window.dispatchEvent(e); });
const focusedFid = () => page.evaluate(() => document.querySelector('.focused')?.getAttribute('data-fid'));
const focusedText = () => page.evaluate(() => document.querySelector('.focused')?.textContent);
const dialogText = () => page.evaluate(() => document.querySelector('#overlay:not([hidden])')?.textContent || '');
const waitDialog = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#overlay:not([hidden])')?.textContent || ''), { timeout: 10000 }, re.source);
async function focusCard(entryId) {
  // Walk the grid with arrows only until the card is focused (proves reachability by D-pad).
  for (let i = 0; i < 40; i++) {
    if ((await focusedFid())?.endsWith(':' + entryId)) return;
    const pos = await page.evaluate((id) => {
      const t = document.querySelector(`[data-fid$=":${id}"]`).getBoundingClientRect();
      const f = document.querySelector('.focused').getBoundingClientRect();
      return { dy: t.top - f.top, dx: t.left - f.left };
    }, entryId);
    if (Math.abs(pos.dy) > 20) await press(pos.dy > 0 ? 'ArrowDown' : 'ArrowUp');
    else await press(pos.dx > 0 ? 'ArrowRight' : 'ArrowLeft');
  }
  throw new Error('could not reach ' + entryId);
}
async function toTab(id) {
  for (let i = 0; i < 8 && !(await focusedFid())?.startsWith('tab:'); i++) await press('ArrowUp');
  // tabs are in a row; move left until the first, then right to the target
  for (let i = 0; i < 6 && (await focusedFid()) !== 'tab:browse'; i++) await press('ArrowLeft');
  const order = ['browse', 'search', 'installed', 'favourites', 'settings'];
  await press('ArrowRight', order.indexOf(id));
  assert.equal(await focusedFid(), 'tab:' + id);
  await press('Enter');
}

test('browse shows every catalogue entry with a type label and visible focus', async () => {
  const n = await page.$$eval('.card', (els) => els.length);
  assert.equal(n, 12);
  assert.match(await focusedFid(), /^browse:/);
  const labels = await page.$$eval('.card .badge.type', (els) => els.length);
  assert.equal(labels, 12);
  const outline = await page.evaluate(() => getComputedStyle(document.querySelector('.focused')).boxShadow);
  assert.notEqual(outline, 'none');
});

test('D-pad moves focus right, down, and up to the category chips', async () => {
  const first = await focusedFid();
  await press('ArrowRight');
  assert.notEqual(await focusedFid(), first);
  await press('ArrowDown');
  assert.match(await focusedFid(), /^browse:/);
  await press('ArrowUp', 2);
  assert.match(await focusedFid(), /^chip:/);
});

test('category filter via OK', async () => {
  await press('ArrowLeft', 6);
  await press('ArrowRight', 3); // All, Video, Your media, Game streaming
  assert.equal(await focusedFid(), 'chip:games');
  await press('Enter');
  const names = await page.$$eval('.card .name', (els) => els.map((e) => e.textContent));
  assert.deepEqual(names.sort(), ['Chiaki (PlayStation Remote Play)', 'Moonlight']);
  await press('ArrowLeft', 3);
  await press('Enter');
  assert.equal(await page.$$eval('.card', (els) => els.length), 12);
});

test('details open with OK, Back returns focus to the same card', async () => {
  await press('ArrowDown');
  await focusCard('moonlight');
  await press('Enter');
  await page.waitForSelector('.details');
  const text = await page.$eval('.details', (e) => e.textContent);
  assert.match(text, /Standalone app/);
  assert.match(text, /Sunshine/);
  assert.match(text, /GPL-3.0/);
  await page.waitForFunction(() => /Not installed on this TV/.test(document.querySelector('.details').textContent));
  assert.equal(await page.$('[data-fid="act:open"]'), null, 'no Open button for a missing standalone app');
  await back();
  assert.equal(await focusedFid(), 'browse:moonlight');
});

test('unsupported entry explains itself and offers no Add', async () => {
  await focusCard('chiaki');
  await press('Enter');
  const text = await page.$eval('.details', (e) => e.textContent);
  assert.match(text, /no Tizen build/i);
  assert.equal(await page.$('[data-fid="act:add"]'), null);
  await back();
});

test('add success: progress, verified result, existing modules preserved', async () => {
  await focusCard('jellyfin-pindagus');
  await press('Enter');
  assert.equal(await focusedFid(), 'act:add');
  await press('Enter');
  await waitDialog(/was added to TizenBrew/);
  const cfg = JSON.parse((await import('node:fs')).readFileSync(cfgPath, 'utf8'));
  for (const id of BASELINE) assert.ok(cfg.modules.includes(id), 'kept ' + id);
  assert.ok(cfg.modules.includes('npm/@pindagus/jellyfin-tizenbrew'));
  assert.match(await dialogText(), /Confirming it was added/);
  await press('ArrowRight'); // Close
  await press('Enter');
  assert.match(await page.$eval('.details', (e) => e.textContent), /Added/);
  assert.equal(await focusedFid() !== null, true);
  await back();
});

test('add failure is reported, changes nothing, and Retry works once the package exists', async () => {
  await focusCard('moonfin-module');
  await press('Enter');
  const before = JSON.parse((await import('node:fs')).readFileSync(cfgPath, 'utf8')).modules.slice();
  await press('Enter');
  await waitDialog(/not found on jsDelivr/);
  assert.match(await dialogText(), /Nothing was changed/);
  assert.deepEqual(JSON.parse((await import('node:fs')).readFileSync(cfgPath, 'utf8')).modules, before);
  registry['gh/tenda96/moonfin-tizenbrew'] = appPkg('moonfin-tizenbrew', 'Moonfin');
  assert.equal(await focusedText(), 'Retry');
  await press('Enter');
  await waitDialog(/was added to TizenBrew/);
  await press('ArrowRight');
  assert.equal(await focusedText(), 'Close');
  await press('Enter');
  await back();
});

test('network timeout is reported, not hung', async () => {
  // twizen is already added, so use an entry that is not: remove pindagus via the double, then hang
  const fs = await import('node:fs');
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  c.modules = c.modules.filter((m) => m !== 'npm/@pindagus/jellyfin-tizenbrew');
  fs.writeFileSync(cfgPath, JSON.stringify(c));
  await page.evaluate(() => window.TBCatalogueUI.client.getModules(true));
  tb.setHang(true);
  await page.evaluate(() => { window.TBCatalogueUI.client.opts.packageTimeout = 1500; });
  await focusCard('jellyfin-pindagus');
  await press('Enter');
  await press('Enter');
  await waitDialog(/no answer from jsDelivr/);
  assert.ok(!JSON.parse(fs.readFileSync(cfgPath, 'utf8')).modules.includes('npm/@pindagus/jellyfin-tizenbrew'));
  tb.setHang(false);
  await press('ArrowRight');
  await press('Enter'); // Close
  await back();
});

test('search with the on-screen keypad finds apps by name', async () => {
  await toTab('search');
  assert.equal(await focusedFid(), 'key:A');
  // J is row 2 col 4 in a 6-wide pad: A B C D E F / G H I J K L
  await press('ArrowDown'); await press('ArrowRight', 3); assert.equal(await focusedFid(), 'key:J'); await press('Enter');
  await press('ArrowUp'); await press('ArrowRight'); assert.equal(await focusedFid(), 'key:E'); await press('Enter');
  await press('ArrowDown'); await press('ArrowRight'); assert.equal(await focusedFid(), 'key:L'); await press('Enter');
  const names = await page.$$eval('.card .name', (els) => els.map((e) => e.textContent));
  // name matches first, then entries that mention Jellyfin in their text (Moonfin)
  assert.deepEqual(names.slice(0, 2), ['Jellyfin', 'Jellyfin (maintained build)']);
  assert.ok(names.slice(2).every((n) => n.startsWith('Moonfin')));
  assert.equal(await page.$eval('.query', (e) => e.textContent), 'jel');
});

test('installed lists added modules, including ones from outside the catalogue', async () => {
  await back(); // search -> browse
  await toTab('installed');
  const text = await page.$eval('#screen', (e) => e.textContent);
  assert.match(text, /IPTV Player/);
  assert.match(text, /TizenTube/);
  assert.match(text, /Tessel/); // installed standalone (fake TV API)
  assert.doesNotMatch(text, /App Catalogue/);
});

test('standalone app installed on the TV can be opened', async () => {
  await focusCard('tessel');
  await press('Enter');
  await page.waitForSelector('[data-fid="act:open"]');
  assert.equal(await focusedFid(), 'act:open');
  await press('Enter');
  await waitDialog(/is opening/);
  assert.deepEqual(tv.log.posts, ['madebypatk.vlcweb']);
  await press('Enter');
  await back();
  await back();
});

test('favourites persist across a reload', async () => {
  await toTab('browse');
  await press('ArrowDown', 2);
  await focusCard('moonlight');
  await press('Enter');
  await press('ArrowRight'); // no Open button for Moonlight, first button is Favourites? focus starts on first .btn
  await page.evaluate(() => {});
  const fid = await focusedFid();
  if (fid !== 'act:fav') { await press('ArrowLeft', 3); }
  assert.equal(await focusedFid(), 'act:fav');
  await press('Enter');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#conn').textContent.startsWith('Connected'));
  await toTab('favourites');
  assert.deepEqual(await page.$$eval('.card .name', (els) => els.map((e) => e.textContent)), ['Moonlight']);
});

test('settings: autolaunch on remembers the previous value, off restores it', async () => {
  await back();
  await toTab('settings');
  await page.waitForFunction(() => /TizenBrew currently opens npm\/@foxreis\/tizentube/.test(document.querySelector('#screen').textContent));
  assert.equal(await focusedFid(), 'set:auto');
  await press('Enter');
  await page.waitForFunction(() => /ON/.test(document.querySelector('[data-fid="set:auto"] .switch').textContent), { timeout: 10000 });
  const fs = await import('node:fs');
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).autoLaunchModule, SELF);
  await press('Enter');
  await page.waitForFunction(() => /OFF/.test(document.querySelector('[data-fid="set:auto"] .switch').textContent), { timeout: 10000 });
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).autoLaunchModule, 'npm/@foxreis/tizentube');
});

test('open launches through TizenBrew and the module page replaces the catalogue', async () => {
  await back();
  await toTab('browse');
  await press('ArrowDown', 2);
  await focusCard('twizen');
  await press('Enter');
  assert.equal(await focusedFid(), 'act:open');
  await Promise.all([page.waitForNavigation(), press('Enter')]);
  assert.ok(tb.log.launches.includes('npm/@jjg0/twizen'));
  assert.match(await page.content(), /Twizen running/);
  // Back to the catalogue the way history allows inside one webview
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#conn')?.textContent.startsWith('Connected'));
});

test('after returning, the catalogue shows the app you opened; Back twice offers to leave', async () => {
  await page.waitForFunction(() => !window.TBCatalogueUI.state.dialog && document.querySelector('.details'));
  assert.match(await page.$eval('.details h1', (e) => e.textContent), /Twizen/);
  await back(); // details -> browse
  await back();
  await waitDialog(/Leave the catalogue/);
  assert.equal(await focusedText(), 'TizenBrew home');
  await back(); // Back closes the dialog
  assert.equal(await dialogText(), '');
});

test('no module was removed that the catalogue did not add', async () => {
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  for (const id of BASELINE) assert.ok(cfg.modules.includes(id), id);
  const removes = tb.log.actions.filter((a) => a.action === 'remove').map((a) => a.module);
  assert.deepEqual(removes, []);
});
