// Starts the built helper service (service/service.js) on free ports against a fake TV app API.
import http from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

export const moduleDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function freePort() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// Fake of the TV's REST API at 127.0.0.1:8001 (GET/POST /api/v2/applications/<id>).
export function startFakeTvApi(installed) {
  const log = { posts: [] };
  const server = http.createServer((req, res) => {
    const m = /^\/api\/v2\/applications\/(.+)$/.exec(req.url);
    const id = m && decodeURIComponent(m[1]);
    if (!id || !installed[id]) { res.writeHead(404); return res.end('{"code":404,"message":"Not found error.","status":404}'); }
    if (req.method === 'POST') { log.posts.push(id); res.writeHead(200); return res.end('true'); }
    res.writeHead(200); res.end(JSON.stringify({ id, name: id, running: false, version: installed[id], visible: false }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, log, close: () => new Promise((c) => server.close(c)) })));
}

export async function startHelper({ tvPort, configPath }) {
  const port = await freePort();
  const code = readFileSync(join(moduleDir, 'service/service.js'), 'utf8')
    .replace(/var PORT = \d+;/, `var PORT = ${port};`)
    .replace("port: 8001", `port: ${tvPort}`)
    .replace("'/home/owner/share/tizenbrewConfig.json'", JSON.stringify(configPath))
    .replace("var ORIGINS = [", "var ORIGINS = [process.env.TEST_ORIGIN, ");
  const dir = mkdtempSync(join(tmpdir(), 'tbcat-svc-'));
  const file = join(dir, 'service.cjs');
  writeFileSync(file, code);
  const child = spawn(process.execPath, [file], { stdio: 'pipe', env: { ...process.env, TEST_ORIGIN: process.env.TEST_ORIGIN || '' } });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { await new Promise((w) => setTimeout(w, 50)); }
  }
  return { port, base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

export function tempConfig(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'tbcat-cfg-'));
  const p = join(dir, 'tizenbrewConfig.json');
  writeFileSync(p, JSON.stringify(initial, null, 4));
  return p;
}
