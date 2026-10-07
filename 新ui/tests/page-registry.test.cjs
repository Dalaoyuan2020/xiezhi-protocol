'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../page-registry.js');

test('every registered route ships a real page, and navigation roles cannot imply extra routes', () => {
  assert.equal(new Set(registry.pages.map(page => page.file)).size, registry.pages.length);
  assert.deepEqual(registry.pages.filter(page => page.group === 'roles').map(page => page.key), ['reader', 'reviewer', 'submitter']);
  for (const entry of registry.pages) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', entry.file)), entry.file);
    assert.equal(registry.forPath('/ui/' + entry.file).key, entry.key);
    assert.equal(registry.isAppPath('/ui/' + entry.file), true);
  }
  for (const route of ['/ui/not-registered.html', '/ui/checkup.py', '/ui/index.html/extra']) assert.equal(registry.isAppPath(route), false);
  assert.equal(registry.isAppPath('/other/index.html', '/ui/'), false);
  assert.equal(registry.isAppPath('/ui/index.html', '/ui/'), true);
});

test('local draft views are marked local-only independently of chosen chain', () => {
  assert.equal(registry.byKey('reviewer').localOnly, true);
  assert.equal(registry.byKey('submitter').localOnly, true);
  assert.equal(registry.byKey('profile').localOnly, false);
  assert.equal(registry.byKey('missing'), null);
});
