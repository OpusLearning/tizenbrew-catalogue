/* TV interface: D-pad focus engine, screens, dialogs. All text is set with textContent. */
(function () {
  'use strict';
  var DATA = window.TBCAT_DATA;
  var BUILD = window.TBCAT_BUILD || { version: 'dev' };
  var Lib = window.TBLib;

  var inTizenBrew = location.port === '8081';
  var params = new URLSearchParams(location.search);
  var client = new window.TBClient({
    wsUrl: 'ws://' + location.host,
    moduleBase: location.origin + '/module/',
    serviceBase: (!inTizenBrew && params.get('helper')) || 'http://127.0.0.1:8093'
  });

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BACKSPACE: 8 };
  var TABS = [
    { id: 'browse', label: 'Browse' },
    { id: 'search', label: 'Search' },
    { id: 'installed', label: 'Installed' },
    { id: 'favourites', label: 'Favourites' },
    { id: 'settings', label: 'Settings' }
  ];
  var CAT_NAME = {};
  DATA.categories.forEach(function (c) { CAT_NAME[c.id] = c.name; });
  var TYPE_LABEL = { module: 'TizenBrew module', standalone: 'Standalone app', unavailable: 'Not available' };
  var STATUS_LABEL = {
    verified: ['Tested on QN90B (Tizen 6.5)', 'ok'],
    pending: ['Not tested on this TV yet', 'warn'],
    upstream: ['Compatible according to upstream', ''],
    unverified: ['Not reviewed', 'warn'],
    unsupported: ['Not supported', 'unavailable']
  };

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('tbcat:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('tbcat:' + k, JSON.stringify(v)); } catch (e) {} }
  };

  var state = {
    tab: 'browse',
    category: 'all',
    query: '',
    detail: null,          // entry being shown in details
    detailFrom: null,      // focus id to return to
    favs: store.get('favs', []),
    standalone: {},        // appId -> {installed, running} | {error}
    autolaunch: null,      // current autoLaunchModule or null if unknown
    conn: 'connecting',
    dialog: null
  };
  var focusMemory = {};
  var focused = null;

  /* ---------- small DOM helpers ---------- */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'onSelect') el._onSelect = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function focusable(tag, fid, cls, onSelect, children, attrs) {
    var a = Object.assign({ class: 'focusable ' + (cls || ''), 'data-fid': fid, onSelect: onSelect }, attrs || {});
    return h(tag, a, children);
  }
  function $(id) { return document.getElementById(id); }

  /* ---------- focus engine ---------- */
  function candidates() {
    var scope = state.dialog ? $('overlay') : document.getElementById('app');
    return Array.prototype.slice.call(scope.querySelectorAll('.focusable')).filter(function (el) {
      return el.offsetParent !== null || el === focused;
    });
  }
  function setFocus(el) {
    if (!el) return;
    if (focused) focused.classList.remove('focused');
    focused = el;
    el.classList.add('focused');
    if (!state.dialog) focusMemory[screenKey()] = el.getAttribute('data-fid');
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { el.scrollIntoView(false); }
  }
  function focusFid(fid) {
    var list = candidates();
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-fid') === fid) { setFocus(list[i]); return true; }
    return false;
  }
  function focusFirst(preferSelector) {
    var scope = state.dialog ? $('overlay') : $('screen');
    var el = (preferSelector && scope.querySelector(preferSelector)) || scope.querySelector('.focusable') || candidates()[0];
    setFocus(el);
  }
  function move(dir) {
    var list = candidates();
    if (!focused || list.indexOf(focused) === -1) return focusFirst();
    var r = focused.getBoundingClientRect();
    var best = null;
    var bestScore = Infinity;
    list.forEach(function (el) {
      if (el === focused) return;
      var c = el.getBoundingClientRect();
      var primary, overlap, gap;
      if (dir === 'right' || dir === 'left') {
        primary = dir === 'right' ? c.left - r.right : r.left - c.right;
        if (primary < -4) return;
        overlap = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
        gap = overlap > 0 ? 0 : Math.abs((c.top + c.bottom) / 2 - (r.top + r.bottom) / 2);
      } else {
        primary = dir === 'down' ? c.top - r.bottom : r.top - c.bottom;
        if (primary < -4) return;
        overlap = Math.min(r.right, c.right) - Math.max(r.left, c.left);
        gap = overlap > 0 ? Math.abs(c.left - r.left) * 0.1 : Math.abs((c.left + c.right) / 2 - (r.left + r.right) / 2);
      }
      var score = Math.max(primary, 0) + gap * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) setFocus(best);
  }

  /* ---------- status helpers ---------- */
  function isFav(id) { return state.favs.indexOf(id) !== -1; }
  function toggleFav(entry) {
    if (isFav(entry.id)) state.favs = state.favs.filter(function (x) { return x !== entry.id; });
    else state.favs = state.favs.concat([entry.id]);
    store.set('favs', state.favs);
    toast(isFav(entry.id) ? entry.name + ' added to Favourites' : entry.name + ' removed from Favourites');
  }
  function moduleEntryStatus(entry) {
    if (entry.kind !== 'module') return null;
    if (!client.modules) return 'unknown';
    var m = client.findInstalled(entry.moduleId);
    if (!m) return 'not-added';
    return m.appName === 'Unknown Module' ? 'broken' : 'added';
  }
  function standaloneStatus(entry) {
    return entry.kind === 'standalone' ? state.standalone[entry.appId] : null;
  }
  function refreshStandalone(entries) {
    var list = (entries || DATA.apps).filter(function (a) { return a.kind === 'standalone'; });
    return Promise.all(list.map(function (a) {
      return client.standaloneStatus(a.appId).then(function (s) { state.standalone[a.appId] = s; }, function (e) {
        state.standalone[a.appId] = { error: e.message };
      });
    }));
  }
  function selfModuleId() {
    var m = /^\/module\/([^\/]+)\//.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* ---------- cards ---------- */
  function badgesFor(entry) {
    var out = [h('span', { class: 'badge type ' + entry.kind, text: TYPE_LABEL[entry.kind] })];
    var ms = moduleEntryStatus(entry);
    if (ms === 'added') out.push(h('span', { class: 'badge ok', text: 'Added' }));
    if (ms === 'broken') out.push(h('span', { class: 'badge warn', text: 'Added, not loading' }));
    var ss = standaloneStatus(entry);
    if (ss && ss.installed) out.push(h('span', { class: 'badge ok', text: 'Installed' }));
    if (entry.compatibility && entry.compatibility.status !== 'verified') {
      var s = STATUS_LABEL[entry.compatibility.status];
      out.push(h('span', { class: 'badge ' + s[1], text: s[0] }));
    }
    if (isFav(entry.id)) out.push(h('span', { class: 'badge star', text: '★ Favourite' }));
    return out;
  }
  function card(entry, fidPrefix) {
    var fid = fidPrefix + ':' + entry.id;
    return focusable('div', fid, 'card', function () { openDetails(entry, fid); }, [
      h('div', { class: 'row' }, [
        h('div', { class: 'mono ' + entry.kind, text: entry.name.charAt(0).toUpperCase() }),
        h('div', { class: 'name', text: entry.name })
      ]),
      h('div', { class: 'summary', text: entry.summary }),
      h('div', { class: 'badges' }, badgesFor(entry))
    ], { 'data-entry': entry.id });
  }
  function grid(entries, fidPrefix, cls) {
    return h('div', { class: 'grid ' + (cls || '') }, entries.map(function (e) { return card(e, fidPrefix); }));
  }

  /* ---------- screens ---------- */
  function screenKey() { return state.detail ? 'detail:' + state.detail.id : state.tab; }

  function renderTabs() {
    var tabs = $('tabs');
    tabs.textContent = '';
    TABS.forEach(function (t) {
      tabs.appendChild(focusable('div', 'tab:' + t.id, 'tab' + (state.tab === t.id && !state.detail ? ' active' : ''), function () {
        state.detail = null;
        state.tab = t.id;
        render(true);
      }, [t.label]));
    });
  }

  function renderConn() {
    var el = $('conn');
    el.className = 'conn' + (state.conn === 'ok' ? '' : ' bad');
    if (state.conn === 'ok') el.textContent = 'Connected to TizenBrew · ' + client.modules.length + ' modules added';
    else if (state.conn === 'connecting') el.textContent = 'Connecting to TizenBrew…';
    else el.textContent = state.conn;
  }

  function browseScreen() {
    var cats = [{ id: 'all', name: 'All apps' }].concat(DATA.categories);
    var chips = h('div', { class: 'chips' }, cats.map(function (c) {
      return focusable('div', 'chip:' + c.id, 'chip' + (state.category === c.id ? ' active' : ''), function () {
        state.category = c.id;
        render(false);
        focusFid('chip:' + c.id);
      }, [c.name]);
    }));
    var entries = DATA.apps.filter(function (a) { return state.category === 'all' || a.category === state.category; });
    return h('div', { class: 'scroller' }, [chips, grid(entries, 'browse')]);
  }

  function matches(entry, q) {
    var hay = (entry.name + ' ' + entry.summary + ' ' + entry.description + ' ' + CAT_NAME[entry.category] + ' ' + TYPE_LABEL[entry.kind]).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) !== -1; });
  }
  // Name matches first (prefix before substring), then matches found only in the text; stable otherwise.
  function rank(list, q) {
    var w = q.trim().toLowerCase();
    var score = function (a) { var n = a.name.toLowerCase(); return n.indexOf(w) === 0 ? 0 : n.indexOf(w) !== -1 ? 1 : 2; };
    return list.map(function (a, i) { return [score(a), i, a]; })
      .sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; })
      .map(function (x) { return x[2]; });
  }
  function searchScreen() {
    var q = state.query;
    var keys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
    var pad = h('div', { class: 'keys' }, keys.map(function (k) {
      return focusable('div', 'key:' + k, 'key', function () { setQuery(q + k.toLowerCase()); }, [k]);
    }).concat([
      focusable('div', 'key:space', 'key wide', function () { setQuery(q + ' '); }, ['Space']),
      focusable('div', 'key:del', 'key wide', function () { setQuery(q.slice(0, -1)); }, ['⌫ Delete']),
      focusable('div', 'key:clear', 'key wide', function () { setQuery(''); }, ['Clear'])
    ]));
    var results = q.trim() ? rank(DATA.apps.filter(function (a) { return matches(a, q); }), q) : [];
    var right = q.trim()
      ? (results.length ? grid(results, 'search', 'two') : h('div', { class: 'empty', text: 'Nothing matches “' + q.trim() + '”. Try a shorter word, such as “jelly” or “game”.' }))
      : h('div', { class: 'empty', text: 'Type part of an app name or what it does, for example “youtube”, “jellyfin” or “games”.' });
    return h('div', { class: 'search' }, [
      h('div', null, [
        h('div', { class: 'query' }, [q ? q : h('span', { class: 'placeholder', text: 'Search apps' })]),
        pad
      ]),
      h('div', { class: 'scroller' }, [h('h2', { text: q.trim() ? results.length + ' result' + (results.length === 1 ? '' : 's') : 'Results' }), right])
    ]);
  }
  function setQuery(q) {
    var fid = focused && focused.getAttribute('data-fid');
    state.query = q.slice(0, 40);
    render(false);
    if (fid) focusFid(fid);
  }

  function externalEntry(mod) {
    return {
      id: 'ext-' + mod.fullName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40),
      name: mod.appName || mod.name,
      kind: 'module',
      moduleId: mod.fullName,
      category: null,
      summary: mod.description || 'Added in TizenBrew. Not part of this catalogue.',
      description: (mod.description || 'This module was added in TizenBrew directly.') + ' It is not part of this catalogue, so there is no extra information about it here.',
      prerequisites: [],
      addable: false,
      external: true,
      source: { repo: '', package: mod.fullName, licence: 'See the package' },
      version: mod.version || 'unknown',
      compatibility: { status: 'unverified', note: 'Not part of this catalogue.' }
    };
  }
  function installedScreen() {
    var parts = [];
    if (!client.modules) {
      parts.push(h('div', { class: 'empty', text: 'Waiting for TizenBrew’s module list…' }));
    } else {
      var self = selfModuleId();
      var mods = client.modules.filter(function (m) { return !self || !Lib.sameModule(m.fullName, self); });
      var entries = mods.map(function (m) {
        var known = DATA.apps.filter(function (a) { return a.kind === 'module' && Lib.sameModule(a.moduleId, m.fullName); })[0];
        return known || externalEntry(m);
      });
      parts.push(h('h2', { text: 'TizenBrew modules (' + entries.length + ')' }));
      parts.push(entries.length ? grid(entries, 'inst') : h('div', { class: 'empty', text: 'No modules added yet. Pick one in Browse and choose Add.' }));
    }
    var standalone = DATA.apps.filter(function (a) { return a.kind === 'standalone'; });
    var installed = standalone.filter(function (a) { return state.standalone[a.appId] && state.standalone[a.appId].installed; });
    var unknown = standalone.filter(function (a) { return !state.standalone[a.appId] || state.standalone[a.appId].error; });
    parts.push(h('h2', { text: 'Standalone apps from this catalogue on this TV (' + installed.length + ')' }));
    if (installed.length) parts.push(grid(installed, 'inst-sa'));
    else if (unknown.length === standalone.length) parts.push(h('div', { class: 'empty', text: 'Could not ask the TV which standalone apps are installed. ' + ((state.standalone[standalone[0].appId] || {}).error || 'Checking…') }));
    else parts.push(h('div', { class: 'empty', text: 'None of the catalogue’s standalone apps are installed. Their details pages explain how to install them from a PC.' }));
    return h('div', { class: 'scroller' }, parts);
  }

  function favouritesScreen() {
    var entries = DATA.apps.filter(function (a) { return isFav(a.id); });
    if (!entries.length) return h('div', { class: 'empty', text: 'No favourites yet. Open an app’s details and choose “Add to Favourites”.' });
    return h('div', { class: 'scroller' }, [grid(entries, 'fav')]);
  }

  function settingsScreen() {
    var self = selfModuleId();
    var on = state.autolaunch !== null && self && Lib.sameModule(state.autolaunch, self);
    var autoSub = state.autolaunch === null
      ? 'Checking the current setting…'
      : on ? 'On. Reopening TizenBrew brings you straight here. Press Up while TizenBrew starts to reach its own home screen.'
        : 'Off. ' + (state.autolaunch ? 'TizenBrew currently opens ' + state.autolaunch + ' at start; turning this on remembers that and restores it when you turn it off.' : 'TizenBrew opens its own home screen at start.');
    return h('div', { class: 'scroller' }, [
      focusable('div', 'set:auto', 'setting', function () { toggleAutolaunch(!on); }, [
        h('div', null, [h('div', { class: 'label', text: 'Open the catalogue when TizenBrew starts' }), h('div', { class: 'sub', text: autoSub })]),
        h('div', { class: 'switch' + (on ? ' on' : ''), text: on ? 'ON' : 'OFF' })
      ]),
      focusable('div', 'set:reload', 'setting', function () { reconnect(true); }, [
        h('div', null, [h('div', { class: 'label', text: 'Refresh' }), h('div', { class: 'sub', text: 'Reconnect to TizenBrew, reload its module list and ask the TV which standalone apps are installed.' })])
      ]),
      h('div', { class: 'setting' }, [
        h('div', null, [
          h('div', { class: 'label', text: 'Getting back to the catalogue' }),
          h('div', { class: 'sub', text: 'Apps opened from here replace the catalogue on screen. To come back, leave the app (Back or Home), then open TizenBrew again. With the setting above on, the catalogue opens by itself; otherwise choose it on TizenBrew’s home screen.' })
        ])
      ]),
      h('div', { class: 'setting' }, [
        h('div', null, [
          h('div', { class: 'label', text: 'About' }),
          h('div', { class: 'sub', text: 'App Catalogue ' + BUILD.version + ' · catalogue checked ' + DATA.checked + ' · ' + DATA.apps.length + ' entries. Each entry lists its upstream source and licence. This catalogue does not install standalone apps; it shows how.' })
        ])
      ])
    ]);
  }

  function detailsScreen(entry) {
    var ms = moduleEntryStatus(entry);
    var ss = standaloneStatus(entry);
    var actions = [];
    var notes = [];
    if (entry.kind === 'module') {
      if (ms === 'added' || ms === 'broken') actions.push(focusable('div', 'act:open', 'btn primary', function () { openModule(entry); }, ['Open']));
      else if (entry.addable) actions.push(focusable('div', 'act:add', 'btn primary', function () { addModule(entry); }, ['Add to TizenBrew']));
      else if (!entry.external) notes.push(h('div', { class: 'note warn', text: 'This catalogue does not add this module. ' + entry.compatibility.note }));
      if (ms === 'unknown') notes.push(h('div', { class: 'note warn', text: 'Not connected to TizenBrew, so Add and Open are unavailable. ' + (state.conn === 'ok' ? '' : state.conn) }));
      if (ms === 'broken') notes.push(h('div', { class: 'note warn', text: 'TizenBrew has this module but could not load its details last time (often a network problem).' }));
    } else if (entry.kind === 'standalone') {
      if (ss && ss.installed) actions.push(focusable('div', 'act:open', 'btn primary', function () { openStandalone(entry); }, ['Open']));
      notes.push(h('div', { class: 'note' }, [
        h('div', { text: ss === undefined ? 'Checking whether it is installed…' : ss.error ? 'Could not check whether it is installed: ' + ss.error : ss.installed ? 'Installed on this TV' + (ss.version ? ' (version ' + ss.version + ')' : '') + '.' : 'Not installed on this TV.' }),
        h('div', { text: 'This is a separate TV app, not a TizenBrew module, so it cannot be added from here. How to install: ' + entry.install })
      ]));
    } else {
      notes.push(h('div', { class: 'note warn', text: entry.install }));
    }
    if (!entry.external) actions.push(focusable('div', 'act:fav', 'btn', function () { toggleFav(entry); render(false); focusFid('act:fav'); }, [isFav(entry.id) ? '★ Remove from Favourites' : '☆ Add to Favourites']));
    actions.push(focusable('div', 'act:back', 'btn', function () { goBack(); }, ['Back']));

    var facts = [
      ['Type', TYPE_LABEL[entry.kind]],
      entry.category ? ['Category', CAT_NAME[entry.category]] : null,
      entry.moduleId ? ['TizenBrew module name', entry.moduleId] : null,
      entry.appId ? ['TV app id', entry.appId] : null,
      ['Version checked', entry.version],
      ['Compatibility', STATUS_LABEL[entry.compatibility.status][0] + '. ' + entry.compatibility.note],
      entry.source.repo ? ['Source', entry.source.repo] : null,
      ['Package', entry.source.package],
      ['Licence', entry.source.licence]
    ].filter(Boolean);
    var dl = h('dl', null, []);
    facts.forEach(function (f) { dl.appendChild(h('dt', { text: f[0] })); dl.appendChild(h('dd', { text: f[1] })); });

    return h('div', { class: 'details' }, [
      h('div', { class: 'main scroller' }, [
        h('div', { class: 'badges' }, badgesFor(entry)),
        h('h1', { text: entry.name }),
        h('p', { class: 'lead', text: entry.summary }),
        h('div', { class: 'actions' }, actions),
        h('p', { text: entry.description }),
        entry.prerequisites.length ? h('h2', { text: 'You will need' }) : null,
        entry.prerequisites.length ? h('ul', null, entry.prerequisites.map(function (p) { return h('li', { text: p }); })) : null
      ].concat(notes)),
      h('div', { class: 'facts' }, [dl])
    ]);
  }

  function render(resetFocus) {
    renderTabs();
    renderConn();
    var screen = $('screen');
    screen.textContent = '';
    var body;
    if (state.detail) body = detailsScreen(state.detail);
    else if (state.tab === 'browse') body = browseScreen();
    else if (state.tab === 'search') body = searchScreen();
    else if (state.tab === 'installed') body = installedScreen();
    else if (state.tab === 'favourites') body = favouritesScreen();
    else body = settingsScreen();
    screen.appendChild(body);
    if (state.dialog) return;
    if (resetFocus === true) {
      var mem = focusMemory[screenKey()];
      if (!(mem && focusFid(mem))) focusFirst(state.detail ? '.btn.primary, .btn' : '.card, .key, .setting.focusable');
    } else if (focused && !document.body.contains(focused)) {
      var fid = focused.getAttribute('data-fid');
      if (!focusFid(fid)) focusFirst();
    }
  }

  function openDetails(entry, fromFid) {
    state.detail = entry;
    state.detailFrom = fromFid;
    render(true);
    if (entry.kind === 'standalone') {
      refreshStandalone([entry]).then(function () { if (state.detail === entry) render(false); });
    }
  }
  function goBack() {
    if (state.dialog) { if (state.dialog.closable) closeDialog(); return; }
    if (state.detail) {
      var from = state.detailFrom;
      state.detail = null;
      render(false);
      if (!(from && focusFid(from))) render(true);
      return;
    }
    if (state.tab !== 'browse') { state.tab = 'browse'; render(true); return; }
    confirmLeave();
  }

  /* ---------- dialogs ---------- */
  function showDialog(spec) {
    state.dialog = spec;
    var ov = $('overlay');
    ov.textContent = '';
    var body = [h('h3', { text: spec.title })];
    if (spec.steps) {
      body.push(h('ul', { class: 'steps' }, spec.steps.map(function (s) { return h('li', { class: s.state || '', text: s.label }); })));
    }
    if (spec.message) body.push(h('div', { class: 'msg ' + (spec.tone || ''), text: spec.message }));
    var buttons = (spec.buttons || []).map(function (b, i) {
      return focusable('div', 'dlg:' + i, 'btn' + (i === 0 ? ' primary' : ''), b.onSelect, [b.label]);
    });
    if (buttons.length) body.push(h('div', { class: 'actions' }, buttons));
    ov.appendChild(h('div', { class: 'dialog', role: 'dialog' }, body));
    ov.hidden = false;
    if (focused) focused.classList.remove('focused');
    focused = null;
    if (buttons.length) setFocus(buttons[0]);
  }
  function closeDialog() {
    state.dialog = null;
    $('overlay').hidden = true;
    $('overlay').textContent = '';
    render(false);
    var mem = focusMemory[screenKey()];
    if (!(mem && focusFid(mem))) focusFirst();
  }
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------- actions ---------- */
  var ADD_STEPS = [
    ['connect', 'Connecting to TizenBrew'],
    ['check', 'Checking the package on jsDelivr'],
    ['save', 'Saving it in TizenBrew'],
    ['reload', 'Reloading TizenBrew’s module list'],
    ['verify', 'Confirming it was added']
  ];
  function addModule(entry) {
    var steps = ADD_STEPS.map(function (s) { return { id: s[0], label: s[1], state: '' }; });
    var spec = { title: 'Adding ' + entry.name, steps: steps, closable: false, buttons: [] };
    var mark = function (id) {
      var seen = false;
      steps.forEach(function (s) {
        if (s.id === id) { s.state = 'active'; seen = true; } else if (!seen) s.state = 'done';
      });
      showDialog(spec);
    };
    showDialog(spec);
    client.addModule(entry.moduleId, mark).then(function (res) {
      steps.forEach(function (s) { s.state = 'done'; });
      spec.message = res.already ? entry.name + ' was already in TizenBrew.' : entry.name + ' was added to TizenBrew (version ' + (res.module.version || '?') + ').';
      spec.tone = 'success';
      spec.closable = true;
      spec.buttons = [
        { label: 'Open now', onSelect: function () { closeDialog(); openModule(entry); } },
        { label: 'Close', onSelect: closeDialog }
      ];
      state.conn = 'ok';
      render(false);
      showDialog(spec);
    }, function (err) {
      steps.forEach(function (s) { if (s.state === 'active') s.state = 'failed'; });
      spec.message = err.message + ' Nothing was changed in TizenBrew.';
      if (err.code === 'busy') spec.message = err.message;
      spec.tone = 'error';
      spec.closable = true;
      spec.buttons = [
        { label: 'Retry', onSelect: function () { addModule(entry); } },
        { label: 'Close', onSelect: closeDialog }
      ];
      client.getModules(false).then(function () { render(false); }, function () {});
      showDialog(spec);
    });
  }
  function openModule(entry) {
    store.set('lastOpened', { id: entry.id, name: entry.name, at: Date.now() });
    showDialog({ title: 'Opening ' + entry.name + '…', message: 'To come back here later, leave the app and open TizenBrew again.', closable: false, buttons: [] });
    client.launchModule(entry.moduleId).catch(function (err) {
      showDialog({
        title: 'Could not open ' + entry.name, message: err.message, tone: 'error', closable: true,
        buttons: [{ label: 'Retry', onSelect: function () { openModule(entry); } }, { label: 'Close', onSelect: closeDialog }]
      });
    });
  }
  function openStandalone(entry) {
    showDialog({ title: 'Opening ' + entry.name + '…', closable: false, buttons: [] });
    client.openStandalone(entry.appId).then(function () {
      showDialog({ title: entry.name + ' is opening', message: 'The TV is switching to ' + entry.name + '. TizenBrew keeps running in the background.', tone: 'success', closable: true, buttons: [{ label: 'Close', onSelect: closeDialog }] });
    }, function (err) {
      showDialog({
        title: 'Could not open ' + entry.name, message: err.message, tone: 'error', closable: true,
        buttons: [{ label: 'Retry', onSelect: function () { openStandalone(entry); } }, { label: 'Close', onSelect: closeDialog }]
      });
    });
  }
  function toggleAutolaunch(turnOn) {
    var self = selfModuleId();
    if (!self) return toast('Only available when the catalogue runs inside TizenBrew.');
    showDialog({ title: turnOn ? 'Turning on…' : 'Turning off…', closable: false, buttons: [] });
    client.currentAutoLaunch().then(function (current) {
      var target;
      if (turnOn) {
        if (!Lib.sameModule(current, self)) store.set('prevAutolaunch', current);
        target = self;
      } else {
        var prev = store.get('prevAutolaunch', '');
        target = prev && !Lib.sameModule(prev, self) ? prev : '';
      }
      return client.setAutoLaunch(target).then(function () {
        return new Promise(function (r) { setTimeout(r, 500); });
      }).then(function () { return client.currentAutoLaunch(); }).then(function (after) {
        state.autolaunch = after;
        if (after !== target) throw new Error('TizenBrew did not save the setting.');
        closeDialog();
        toast(turnOn ? 'The catalogue will open when TizenBrew starts.' : (target ? 'Restored: TizenBrew opens ' + target + ' at start.' : 'TizenBrew will open its home screen at start.'));
      });
    }).catch(function (err) {
      showDialog({ title: 'Could not change the setting', message: err.message, tone: 'error', closable: true,
        buttons: [{ label: 'Retry', onSelect: function () { toggleAutolaunch(turnOn); } }, { label: 'Close', onSelect: closeDialog }] });
    });
  }
  function confirmLeave() {
    showDialog({
      title: 'Leave the catalogue?', closable: true,
      message: 'Go back to TizenBrew’s home screen.',
      buttons: [
        { label: 'TizenBrew home', onSelect: function () {
          if (history.length > 1) history.back();
          else showDialog({ title: 'Leave the catalogue?', message: 'There is no previous screen. Press Home on the remote to leave.', closable: true, buttons: [{ label: 'OK', onSelect: closeDialog }] });
        } },
        { label: 'Stay', onSelect: closeDialog }
      ]
    });
  }

  function reconnect(withToast) {
    state.conn = 'connecting';
    renderConn();
    return client.getModules(false).then(function () {
      state.conn = 'ok';
      return Promise.all([
        refreshStandalone(),
        client.currentAutoLaunch().then(function (a) { state.autolaunch = a; }, function () { state.autolaunch = null; })
      ]);
    }, function (err) {
      state.conn = err.message;
    }).then(function () {
      if (!state.dialog) render(false);
      else renderConn();
      if (withToast) toast(state.conn === 'ok' ? 'Refreshed.' : 'Still not connected.');
    });
  }

  /* ---------- keys ---------- */
  window.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    var handled = true;
    if (k === KEY.LEFT) move('left');
    else if (k === KEY.RIGHT) move('right');
    else if (k === KEY.UP) move('up');
    else if (k === KEY.DOWN) move('down');
    else if (k === KEY.ENTER) { if (focused && focused._onSelect) focused._onSelect(); }
    else if (k === KEY.BACK || k === KEY.ESC) goBack();
    else if (state.tab === 'search' && !state.detail && !state.dialog && k === KEY.BACKSPACE) setQuery(state.query.slice(0, -1));
    else if (state.tab === 'search' && !state.detail && !state.dialog && e.key && e.key.length === 1 && /[a-z0-9 ]/i.test(e.key)) setQuery(state.query + e.key.toLowerCase());
    else handled = false;
    if (handled) e.preventDefault();
  });

  // Coming back with the browser's Back (page restored from the back-forward cache): clear the
  // "Opening..." dialog and re-read TizenBrew's state, since another app ran in between.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    state.dialog = null;
    $('overlay').hidden = true;
    client.socket = null;
    reconnect(false).then(function () { render(true); });
  });

  window.TBCatalogueUI = { state: state, client: client };
  render(true);
  reconnect(false).then(function () { if (!state.dialog) render(false); });
})();
