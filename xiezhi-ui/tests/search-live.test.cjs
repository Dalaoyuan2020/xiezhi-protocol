'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../search.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = name => ({ source: 'openalex', fetchedAt: '2026-10-07T12:00:00Z', cached: true,
  institution: { status: 'matched', matches: [{ name: 'Hohai University' }] },
  results: [{ id: 'A5072119017', name, institutions: ['Hohai University'], topics: [], works: 97, orcid: 'https://orcid.org/0000-0001-6951-5633' }] });
function element(tag = 'div') {
  return { tag, children: [], listeners: {}, attributes: {}, dataset: {}, style: { setProperty() {} }, value: '', hidden: false, textContent: '',
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attributes[key] = String(value); }, getAttribute(key) { return this.attributes[key]; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    dispatch(type, extra = {}) { this.listeners[type]?.({ preventDefault() {}, ...extra }); }, focus() {}, scrollIntoView() {} };
}
async function page(href, fetcher) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const document = { getElementById: get, body: element('body'), createElement: element, createTextNode: text => ({ tag: '#text', textContent: text, children: [] }), querySelectorAll: () => [], addEventListener() {} };
  const location = { href, get origin() { return new URL(this.href).origin; }, get search() { return new URL(this.href).search; } };
  const history = { replaceState(_state, _unused, url) { location.href = String(url); } };
  const requests = [];
  vm.runInNewContext(script, { window: { location }, document, location, history, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); } });
  const flush = async () => { await tick(); await tick(); };
  await flush();
  return { get, requests, location, flush };
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test('real search uses the server API and live detail return preserves Chinese name, institution and network', async () => {
  const state = await page('https://demo.example/ui/?q=徐林森&institution=河海大学&network=testnet', async () => ({ ok: true, json: async () => result('Linsen Xu') }));
  const request = new URL(state.requests[0].url, state.location.href);
  assert.equal(request.pathname, '/scholar-api/search'); assert.equal(request.searchParams.get('institution'), '河海大学');
  const link = descendants(state.get('ss-result-list')).find(node => node.tag === 'a' && node.textContent === '查看实时档案');
  const destination = new URL(link.href, state.location.href);
  assert.equal(destination.pathname, '/live/'); assert.equal(destination.searchParams.get('q'), 'A5072119017');
  const back = new URL(destination.searchParams.get('returnTo'), state.location.href);
  assert.equal(back.pathname, '/ui/index.html'); assert.equal(back.searchParams.get('q'), '徐林森');
  assert.equal(back.searchParams.get('institution'), '河海大学'); assert.equal(back.searchParams.get('network'), 'testnet');
  state.get('ss-institution-skip').dispatch('click'); await state.flush();
  assert.equal(new URL(state.requests.at(-1).url, state.location.href).searchParams.has('institution'), false);
});

test('both Chinese input fields wait for composition to finish before submitting', async () => {
  const state = await page('https://demo.example/ui/', async () => ({ ok: true, json: async () => result('Linsen Xu') }));
  state.get('ss-query').value = '徐林森';
  state.get('ss-query').dispatch('compositionstart'); state.get('ss-form').dispatch('submit'); assert.equal(state.requests.length, 0);
  state.get('ss-query').dispatch('compositionend'); state.get('ss-form').dispatch('submit'); await state.flush(); assert.equal(state.requests.length, 1);
  state.get('ss-institution').value = '河海大学';
  state.get('ss-institution').dispatch('compositionstart'); state.get('ss-institution-form').dispatch('submit'); assert.equal(state.requests.length, 1);
  state.get('ss-institution').dispatch('compositionend'); state.get('ss-institution-form').dispatch('submit'); await state.flush(); assert.equal(state.requests.length, 2);
});

test('an older response cannot restore results after the name is cleared', async () => {
  const pending = [];
  const state = await page('https://demo.example/ui/', (url, options) => new Promise(resolve => pending.push({ resolve, options })));
  state.get('ss-query').value = '徐林森'; state.get('ss-form').dispatch('submit');
  state.get('ss-query').value = ''; state.get('ss-query').dispatch('input');
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve({ ok: true, json: async () => result('Stale result') }); await state.flush();
  assert.equal(state.get('ss-results').hidden, true); assert.equal(state.get('ss-result-list').children.length, 0);
});
