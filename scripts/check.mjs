// Release check: catalogue valid, committed build output matches a fresh build, no private data.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const fail = (m) => { console.error('FAIL ' + m); failed++; };
const ok = (m) => console.log('ok   ' + m);

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === '.git') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// 1. reproducible build
const tmp = mkdtempSync(join(tmpdir(), 'tbcat-'));
execFileSync(process.execPath, [join(here, 'scripts/build.mjs'), tmp], { stdio: 'pipe' });
for (const d of ['app', 'service']) {
  const fresh = walk(join(tmp, d)).map(p => relative(tmp, p)).sort();
  const committed = walk(join(here, d)).map(p => relative(here, p)).sort();
  if (JSON.stringify(fresh) !== JSON.stringify(committed)) fail(`${d}/ file list differs from a fresh build`);
  for (const f of fresh) {
    if (committed.includes(f) && hash(join(tmp, f)) !== hash(join(here, f))) fail(`${f} differs from a fresh build (run npm run build)`);
  }
}
if (!failed) ok('app/ and service/ match a fresh build');

// 2. private data scan over everything that would be published
const patterns = [
  [/\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, 'private IP address'],
  [/\b[0-9A-F]{2}(?::[0-9A-F]{2}){5}\b/i, 'MAC address'],
  [/\bDUID\b.{0,20}[A-Z0-9]{13}\b/, 'device DUID'],
  [/\.p12\b|SamsungCertificate|BEGIN (?:RSA |EC )?PRIVATE KEY/i, 'certificate or key'],
  [/password\s*[:=]/i, 'password'],
  [/\/home\/(?!owner\/share\/tizenbrewConfig)[a-z]+\//, 'local home path']
];
for (const p of walk(here)) {
  const rel = relative(here, p);
  if (rel.startsWith('scripts/check.mjs')) continue;
  const text = readFileSync(p, 'utf8');
  for (const [re, what] of patterns) if (re.test(text)) fail(`${rel}: looks like a ${what}`);
}
if (!failed) ok('no private addresses, device ids, keys or local paths');

process.exit(failed ? 1 : 0);
