/* Talks to TizenBrew's own service (ws://127.0.0.1:8081), using the same messages as TizenBrew's UI,
 * and to the catalogue's helper service for standalone apps. Every call has a timeout and reports
 * failure honestly; nothing here claims success without reading TizenBrew's module list back. */
(function (root) {
  'use strict';
  var Lib = (typeof module !== 'undefined' && module.exports) ? require('./lib.js') : root.TBLib;

  var Events = {
    Ready: -1, AppControlData: 0, GetDebugStatus: 1, CanLaunchInDebug: 2, ReLaunchInDebug: 3,
    GetModules: 4, LaunchModule: 5, StartService: 6, GetServiceStatuses: 7, Error: 8,
    CanLaunchModules: 9, ModuleAction: 10
  };

  function CatalogueError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function TBClient(opts) {
    this.opts = Object.assign({
      wsUrl: 'ws://127.0.0.1:8081',
      moduleBase: 'http://127.0.0.1:8081/module/',
      serviceBase: 'http://127.0.0.1:8093',
      requestTimeout: 30000,
      packageTimeout: 15000,
      WebSocket: root.WebSocket,
      fetch: root.fetch ? root.fetch.bind(root) : null,
      navigate: function (url) { root.location.href = url; },
      wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    }, opts || {});
    this.socket = null;
    this.waiters = [];
    this.modules = null;
    this.busy = false;
  }

  TBClient.prototype.connect = function () {
    var self = this;
    if (self.socket && self.socket.readyState === 1) return Promise.resolve();
    if (self.connecting) return self.connecting;
    self.connecting = new Promise(function (resolve, reject) {
      var ws;
      try { ws = new self.opts.WebSocket(self.opts.wsUrl); } catch (e) {
        self.connecting = null;
        return reject(CatalogueError('no-service', 'Cannot reach TizenBrew’s service.'));
      }
      var timer = setTimeout(function () {
        self.connecting = null;
        try { ws.close(); } catch (e) {}
        reject(CatalogueError('no-service', 'TizenBrew’s service did not answer.'));
      }, 8000);
      ws.onopen = function () { clearTimeout(timer); self.socket = ws; self.connecting = null; resolve(); };
      ws.onerror = function () {
        clearTimeout(timer); self.connecting = null;
        reject(CatalogueError('no-service', 'Cannot reach TizenBrew’s service. Open the catalogue from TizenBrew.'));
      };
      ws.onclose = function () { if (self.socket === ws) self.socket = null; };
      ws.onmessage = function (ev) { self._onMessage(ev.data); };
    });
    return self.connecting;
  };

  TBClient.prototype._onMessage = function (raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    var remaining = [];
    var handled = false;
    this.waiters.forEach(function (w) {
      if (!handled && w.type === msg.type) { handled = true; w.resolve(msg.payload); }
      else if (msg.type === Events.Error && !handled) { handled = true; w.reject(CatalogueError('tb-error', String(msg.payload))); }
      else remaining.push(w);
    });
    this.waiters = remaining;
  };

  TBClient.prototype._send = function (type, payload) {
    if (!this.socket || this.socket.readyState !== 1) throw CatalogueError('no-service', 'Not connected to TizenBrew.');
    this.socket.send(JSON.stringify({ type: type, payload: payload }));
  };

  TBClient.prototype._request = function (type, payload, timeoutMs) {
    var self = this;
    return self.connect().then(function () {
      return new Promise(function (resolve, reject) {
        var w = { type: type };
        var timer = setTimeout(function () {
          self.waiters = self.waiters.filter(function (x) { return x !== w; });
          reject(CatalogueError('timeout', 'TizenBrew took too long to answer.'));
        }, timeoutMs || self.opts.requestTimeout);
        w.resolve = function (p) { clearTimeout(timer); resolve(p); };
        w.reject = function (e) { clearTimeout(timer); reject(e); };
        self.waiters.push(w);
        self._send(type, payload);
      });
    });
  };

  // reload=true makes TizenBrew re-read every module's package.json (as its own UI does after a change).
  TBClient.prototype.getModules = function (reload) {
    var self = this;
    var attempt = function (n) {
      return self._request(Events.GetModules, reload ? true : undefined).then(function (list) {
        if (list === null && n < 20) return self.opts.wait(500).then(function () { return attempt(n + 1); });
        if (!Array.isArray(list)) throw CatalogueError('bad-reply', 'TizenBrew sent an unexpected module list.');
        self.modules = list;
        return list;
      });
    };
    return attempt(0);
  };

  TBClient.prototype.findInstalled = function (moduleId) {
    if (!this.modules) return null;
    for (var i = 0; i < this.modules.length; i++) {
      if (Lib.sameModule(this.modules[i].fullName, moduleId)) return this.modules[i];
    }
    return null;
  };

  // Fetch the module's package.json through TizenBrew's own proxy (same origin as this page).
  TBClient.prototype.checkPackage = function (moduleId) {
    var self = this;
    var url = self.opts.moduleBase + encodeURIComponent(moduleId) + '/package.json';
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(CatalogueError('network', 'Could not download the package details (no answer from jsDelivr).')); }, self.opts.packageTimeout);
    });
    var get = self.opts.fetch(url, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (text) {
      var pkg;
      try { pkg = JSON.parse(text); } catch (e) {
        throw CatalogueError('not-found', 'The package was not found on jsDelivr.');
      }
      if (!pkg || (pkg.packageType !== 'app' && pkg.packageType !== 'mods')) {
        throw CatalogueError('not-module', 'This package is not a TizenBrew module.');
      }
      return pkg;
    }, function () {
      throw CatalogueError('network', 'Could not download the package details.');
    });
    return Promise.race([get, timeout]);
  };

  /* Add a module. onStep(stepId, label) reports real progress. Resolves with the module entry that
   * TizenBrew itself reports; rejects with a CatalogueError and leaves the config as it was found. */
  TBClient.prototype.addModule = function (moduleId, onStep) {
    var self = this;
    var step = onStep || function () {};
    if (!Lib.isValidModuleId(moduleId)) return Promise.reject(CatalogueError('invalid-id', 'This entry has an invalid package name.'));
    if (self.busy) return Promise.reject(CatalogueError('busy', 'Another change is still running.'));
    self.busy = true;
    var wasPresent = false;
    var sent = false;
    return Promise.resolve()
      .then(function () { step('connect', 'Connecting to TizenBrew'); return self.getModules(false); })
      .then(function () {
        var existing = self.findInstalled(moduleId);
        if (existing && existing.appName !== 'Unknown Module') return { already: true, module: existing };
        wasPresent = !!existing;
        step('check', 'Checking the package on jsDelivr');
        return self.checkPackage(moduleId).then(function () {
          step('save', 'Saving it in TizenBrew');
          if (!wasPresent) { self._send(Events.ModuleAction, { action: 'add', module: moduleId }); sent = true; }
          step('reload', 'Reloading TizenBrew’s module list');
          return self.getModules(true);
        }).then(function () {
          step('verify', 'Confirming it was added');
          var mod = self.findInstalled(moduleId);
          if (!mod) throw CatalogueError('not-saved', 'TizenBrew did not save the module.');
          if (mod.appName === 'Unknown Module') throw CatalogueError('load-failed', 'TizenBrew saved the module but could not load it.');
          return { already: false, module: mod };
        });
      })
      .then(function (result) { self.busy = false; return result; }, function (err) {
        // Undo only what this call added, so a failed add leaves TizenBrew as it was.
        var undo = Promise.resolve();
        if (sent && !wasPresent) {
          undo = Promise.resolve().then(function () {
            self._send(Events.ModuleAction, { action: 'remove', module: moduleId });
            return self.getModules(true);
          }).catch(function () {});
        }
        return undo.then(function () { self.busy = false; throw err; });
      });
  };

  /* Open a module that TizenBrew already knows, the way TizenBrew's UI does. */
  TBClient.prototype.launchModule = function (moduleId) {
    var self = this;
    return self.getModules(false).then(function () {
      var mod = self.findInstalled(moduleId);
      if (!mod) throw CatalogueError('not-added', 'Add this app before opening it.');
      if (!mod.appPath || mod.appName === 'Unknown Module') throw CatalogueError('load-failed', 'TizenBrew could not load this module. Try again later.');
      if (mod.packageType === 'mods' && mod.evaluateScriptOnDocumentStart) {
        // TizenBrew answers with LaunchModule once its script is ready to inject.
        return self._request(Events.LaunchModule, mod, 15000).then(function () { self.opts.navigate(mod.appPath); return mod; });
      }
      self._send(Events.LaunchModule, mod);
      return self.opts.wait(400).then(function () { self.opts.navigate(mod.appPath); return mod; });
    });
  };

  TBClient.prototype.setAutoLaunch = function (moduleId) {
    var self = this;
    if (moduleId !== '' && !Lib.isValidModuleId(moduleId)) return Promise.reject(CatalogueError('invalid-id', 'Invalid module name.'));
    return self.connect().then(function () { self._send(Events.ModuleAction, { action: 'autolaunch', module: moduleId }); });
  };

  TBClient.prototype._service = function (method, path) {
    var self = this;
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(CatalogueError('no-helper', 'The catalogue helper did not answer.')); }, 6000);
    });
    var call = self.opts.fetch(self.opts.serviceBase + path, { method: method, cache: 'no-store' })
      .then(function (r) { return r.json(); }, function () {
        throw CatalogueError('no-helper', 'The catalogue helper is not running. Reopen the catalogue from TizenBrew.');
      })
      .then(function (body) {
        if (!body || body.ok === false && !('installed' in body)) throw CatalogueError('helper-error', (body && body.error) || 'Helper error.');
        return body;
      });
    return Promise.race([call, timeout]);
  };

  TBClient.prototype.standaloneStatus = function (appId) {
    if (!Lib.isValidAppId(appId)) return Promise.reject(CatalogueError('invalid-id', 'Invalid app id.'));
    return this._service('GET', '/apps/' + encodeURIComponent(appId));
  };

  TBClient.prototype.openStandalone = function (appId) {
    if (!Lib.isValidAppId(appId)) return Promise.reject(CatalogueError('invalid-id', 'Invalid app id.'));
    return this._service('POST', '/apps/' + encodeURIComponent(appId) + '/launch').then(function (body) {
      if (!body.ok) throw CatalogueError('launch-failed', body.error || 'The TV did not open the app.');
      return body;
    });
  };

  TBClient.prototype.currentAutoLaunch = function () {
    return this._service('GET', '/autolaunch').then(function (b) { return b.autoLaunchModule || ''; });
  };

  TBClient.Events = Events;
  if (typeof module !== 'undefined' && module.exports) module.exports = TBClient;
  else root.TBClient = TBClient;
})(this);
