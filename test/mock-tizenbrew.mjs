// Test double for TizenBrew 2.0.5's service (service-nextgen/service/index.js): same WebSocket messages,
// same config file shape and write behaviour, same /module/<id>/<path> proxy (including its habit of
// returning an error body with status 200 for missing files). Module packages come from `registry`.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { WebSocketServer } from 'ws';

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

export function startMockTizenBrew({ configPath, registry, selfId, selfDir }) {
  const Events = { Ready: -1, GetDebugStatus: 1, GetModules: 4, LaunchModule: 5, Error: 8, ModuleAction: 10 };
  const log = { launches: [], actions: [] };
  let hangPackages = false;

  const readConfig = () => existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : { modules: ['npm/@foxreis/tizentube'], autoLaunchServiceList: [], autoLaunchModule: '' };
  const writeConfig = (c) => writeFileSync(configPath, JSON.stringify(c, null, 4));

  function pkgFor(id) {
    if (id === selfId) return JSON.parse(readFileSync(join(selfDir, 'package.json'), 'utf8'));
    return registry[id] ? registry[id]['package.json'] : null;
  }
  function loadModules(port) {
    return readConfig().modules.map((module) => {
      const [type, name] = [module.slice(0, module.indexOf('/')), module.slice(module.indexOf('/') + 1)];
      const p = pkgFor(module);
      if (!p || (p.packageType !== 'app' && p.packageType !== 'mods')) {
        return { appName: 'Unknown Module', name, fullName: module, appPath: '', keys: [], moduleType: type, packageType: 'app',
          description: `Unknown module ${module}. Please check the module name and try again.` };
      }
      const base = { fullName: module, appName: p.appName, version: p.version, name, keys: p.keys || [], moduleType: type,
        packageType: p.packageType, description: p.description, serviceFile: p.serviceFile };
      if (p.packageType === 'app') return { ...base, appPath: `http://127.0.0.1:${port}/module/${encodeURIComponent(module)}/${p.appPath}` };
      return { ...base, appPath: p.websiteURL, tizenAppId: p.tizenAppId, mainFile: p.main, evaluateScriptOnDocumentStart: p.evaluateScriptOnDocumentStart };
    });
  }

  const server = http.createServer((req, res) => {
    const m = /^\/module\/([^/]+)\/(.*)$/.exec(req.url.split('?')[0]);
    if (!m) { res.end('127.0.0.1'); return; }
    const id = decodeURIComponent(m[1]);
    const file = m[2];
    if (hangPackages && file === 'package.json' && id !== selfId) return; // like a dead network: never answers
    let body = null;
    if (id === selfId) {
      const p = join(selfDir, file);
      if (existsSync(p)) body = readFileSync(p);
    } else if (registry[id] && registry[id][file] !== undefined) {
      const v = registry[id][file];
      body = typeof v === 'string' ? v : JSON.stringify(v);
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'text/plain' });
    res.end(body === null ? "Couldn't find the requested file." : body);
  });

  const wss = new WebSocketServer({ server });
  let cache = null;
  wss.on('connection', (ws) => {
    const send = (type, payload) => ws.send(JSON.stringify({ type, payload }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send(Events.Error, `Invalid JSON: ${raw}`); }
      const { type, payload } = msg;
      const port = server.address().port;
      if (type === Events.GetModules) {
        if (payload || !cache) cache = loadModules(port);
        setTimeout(() => send(Events.GetModules, cache), 30);
      } else if (type === Events.ModuleAction) {
        log.actions.push(payload);
        const c = readConfig();
        if (payload.action === 'add' && !c.modules.includes(payload.module)) { c.modules.push(payload.module); writeConfig(c); }
        if (payload.action === 'remove' && c.modules.includes(payload.module)) { c.modules.splice(c.modules.indexOf(payload.module), 1); writeConfig(c); }
        if (payload.action === 'autolaunch') { c.autoLaunchModule = payload.module; writeConfig(c); }
      } else if (type === Events.LaunchModule) {
        log.launches.push(payload.fullName);
        if (payload.packageType === 'mods' && payload.evaluateScriptOnDocumentStart) setTimeout(() => send(Events.LaunchModule, payload.name), 100);
      } else if (type === Events.Ready || type === Events.GetDebugStatus) {
        if (type === Events.GetDebugStatus) send(type, { tizenDebug: true, webDebug: true, rwiDebug: false });
      } else send(Events.Error, 'Invalid event type.');
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    log,
    readConfig,
    setHang(v) { hangPackages = v; },
    close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(); server.close(() => r()); })
  })));
}
