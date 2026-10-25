/* Pure helpers shared by the page, the build and the tests. No DOM, no network. */
(function (root) {
  'use strict';

  // npm/<name> or npm/@scope/<name>, gh/<owner>/<repo>; optional @<version-or-ref>.
  var NPM_NAME = '[a-z0-9][a-z0-9._~-]{0,213}';
  var MODULE_ID_RE = new RegExp(
    '^(?:npm/(?:@' + NPM_NAME + '/)?' + NPM_NAME +
    '|gh/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100})' +
    '(?:@[A-Za-z0-9._-]{1,64})?$'
  );
  // Tizen app id: <10-char package id>.<name>, or reverse-DNS for native packages.
  var APP_ID_RE = /^[A-Za-z0-9]{1,30}(?:\.[A-Za-z0-9_-]{1,60}){1,4}$/;
  var KINDS = ['module', 'standalone', 'unavailable'];
  var STATUSES = ['verified', 'pending', 'upstream', 'unverified', 'unsupported'];
  var SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
  var URL_RE = /^https:\/\/[^\s<>"']+$/;

  function isValidModuleId(id) {
    return typeof id === 'string' && id.length <= 260 && MODULE_ID_RE.test(id) && id.indexOf('..') === -1;
  }

  function isValidAppId(id) {
    return typeof id === 'string' && APP_ID_RE.test(id);
  }

  // Strip a trailing @version so "npm/@scope/pkg@1.2.3" matches "npm/@scope/pkg".
  function baseModuleId(id) {
    if (typeof id !== 'string') return '';
    var at = id.lastIndexOf('@');
    var slash = id.lastIndexOf('/');
    if (at > slash) return id.slice(0, at);
    return id;
  }

  function sameModule(a, b) {
    return baseModuleId(a).toLowerCase() === baseModuleId(b).toLowerCase();
  }

  function isText(v, max) {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  }

  function validateCatalogue(cat) {
    var errors = [];
    function err(where, msg) { errors.push(where + ': ' + msg); }
    if (!cat || typeof cat !== 'object') return ['catalogue: not an object'];
    if (cat.schema !== 1) err('catalogue', 'schema must be 1');
    if (!Array.isArray(cat.categories) || cat.categories.length === 0) err('catalogue', 'categories missing');
    if (!Array.isArray(cat.apps) || cat.apps.length === 0) err('catalogue', 'apps missing');
    if (errors.length) return errors;

    var catIds = {};
    cat.categories.forEach(function (c, i) {
      if (!c || !SLUG_RE.test(c.id)) err('categories[' + i + ']', 'bad id');
      else catIds[c.id] = true;
      if (!c || !isText(c.name, 40)) err('categories[' + i + ']', 'bad name');
    });

    var seen = {};
    var seenModules = {};
    cat.apps.forEach(function (a, i) {
      var w = 'apps[' + i + ']' + (a && a.id ? ' (' + a.id + ')' : '');
      if (!a || typeof a !== 'object') return err(w, 'not an object');
      if (!SLUG_RE.test(a.id || '')) err(w, 'bad id');
      if (seen[a.id]) err(w, 'duplicate id');
      seen[a.id] = true;
      if (!isText(a.name, 60)) err(w, 'bad name');
      if (KINDS.indexOf(a.kind) === -1) err(w, 'bad kind');
      if (!catIds[a.category]) err(w, 'unknown category');
      if (!isText(a.summary, 120)) err(w, 'bad summary');
      if (!isText(a.description, 600)) err(w, 'bad description');
      if (!Array.isArray(a.prerequisites) || a.prerequisites.some(function (p) { return !isText(p, 120); })) err(w, 'bad prerequisites');
      if (typeof a.addable !== 'boolean') err(w, 'addable must be boolean');
      if (!a.source || !isText(a.source.licence, 120) || !isText(a.source.package, 200)) err(w, 'source.licence/package required');
      if (a.source && a.source.repo && !URL_RE.test(a.source.repo)) err(w, 'source.repo must be https URL or empty');
      if (!isText(a.version, 40)) err(w, 'bad version');
      if (!a.compatibility || STATUSES.indexOf(a.compatibility.status) === -1 || !isText(a.compatibility.note, 300)) err(w, 'bad compatibility');

      if (a.kind === 'module') {
        if (!isValidModuleId(a.moduleId)) err(w, 'invalid moduleId');
        else {
          var key = baseModuleId(a.moduleId).toLowerCase();
          if (seenModules[key]) err(w, 'duplicate moduleId');
          seenModules[key] = true;
        }
        if (a.appId !== undefined) err(w, 'module must not have appId');
        if (a.addable && ['verified', 'pending'].indexOf(a.compatibility && a.compatibility.status) === -1) err(w, 'only verified/pending modules may be addable');
      } else {
        if (a.moduleId !== undefined) err(w, 'only modules have moduleId');
        if (a.addable) err(w, 'only modules can be addable');
        if (!isText(a.install, 300)) err(w, 'install route text required');
      }
      if (a.kind === 'standalone' && !isValidAppId(a.appId)) err(w, 'invalid appId');
      if (a.kind === 'unavailable' && a.compatibility && a.compatibility.status !== 'unsupported') err(w, 'unavailable must be unsupported');
    });
    return errors;
  }

  var api = {
    isValidModuleId: isValidModuleId,
    isValidAppId: isValidAppId,
    baseModuleId: baseModuleId,
    sameModule: sameModule,
    validateCatalogue: validateCatalogue
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TBLib = api;
})(this);
