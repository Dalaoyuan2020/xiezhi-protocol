'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { documentDouble } = require('./helpers/reader-dom.cjs');
const readerApi = require('../reader-context.js');
const script = fs.readFileSync(path.join(__dirname, '../search.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const author = (id, name = 'Linsen Xu') => ({ id, name, institutions: ['Hohai University'], topics: ['Water science'], works: 30, orcid: 'https://orcid.org/0000-0001-6951-5633' });
const payload = (results, extra = {}) => ({ source: 'openalex', results, fetchedAt: '2026-10-07T08:00:00Z', cached: false, ...extra });
function browser(href, storage) {
  const values = new Map();
  const location = { href, assigned: [], assign(url) { this.assigned.push(url); }, get search() { return new URL(this.href).search; } };
  const history = { state: null, length: 2, replaceState(value, _, url) { this.state = value; location.href = String(url); } };
  return { location, history, storage: storage || { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) } };
}
async function searchPage(state, { fetcher = async () => ({ ok: true, json: async () => payload([author('A5072119017')]) }), navigationType = 'navigate' } = {}) {
  const dom = documentDouble();
  for (const id of ['ss-query', 'ss-status', 'ss-results', 'ss-result-list', 'ss-empty', 'ss-empty-title', 'ss-empty-detail', 'ss-result-count', 'ss-results-title', 'ss-result-note', 'ss-external-search', 'ss-submit', 'ss-retry', 'ss-source-note', 'ss-form', 'ss-present', 'ss-institution', 'ss-institution-guide', 'ss-institution-form', 'ss-institution-status', 'ss-institution-skip']) dom.node(id);
  const frames = []; const listeners = {}; const requests = [];
  const window = { ...state, scrollY: 287,
    XiezhiReader: { ...readerApi, create: () => readerApi.create({ ...state, document: dom.document, navigationType, newToken: () => 'search-session-token' }) },
    requestAnimationFrame: callback => frames.push(callback), scrollTo(value) { this.scrolledTo = value; }, addEventListener(type, callback) { listeners[type] = callback; } };
  vm.runInNewContext(script, { window, document: dom.document, location: state.location, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); } });
  const flush = async () => { await tick(); await tick(); frames.splice(0).forEach(callback => callback()); };
  await flush();
  return { ...dom, window, listeners, requests, flush, get: id => dom.document.getElementById(id) };
}

test('live search preserves the workbench route, actual ORCID and source while candidate links keep name, unit and network', async () => {
  const state = browser('https://demo.example/workbench/index.html?q=徐林森&institution=河海&network=testnet');
  const page = await searchPage(state, { fetcher: async () => ({ ok: true, json: async () => payload([author('A5072119017')], { cached: true, institution: { status: 'matched', matches: [{ name: 'Hohai University' }] } }) }) });
  assert.equal(new URL(page.requests[0].url, state.location.href).searchParams.get('institution'), '河海');
  assert.equal(page.get('ss-result-list').children.length, 1);
  assert.match(page.get('ss-source-note').textContent, /近期缓存/);
  assert.match(page.get('ss-result-list').textContent, /0000-0001-6951-5633/);
  const link = page.document.querySelector('a[data-reader-candidate="A5072119017"]');
  const url = new URL(link.href);
  assert.equal(url.pathname, '/workbench/live/'); assert.equal(url.searchParams.get('q'), 'A5072119017'); assert.equal(url.searchParams.get('network'), 'testnet');
  const back = new URL(url.searchParams.get('returnTo'), state.location.href);
  assert.equal(back.pathname, '/workbench/index.html'); assert.equal(back.searchParams.get('q'), '徐林森'); assert.equal(back.searchParams.get('institution'), '河海');
  link.dispatch('click');
  const context = JSON.parse(state.storage.getItem(readerApi.STORAGE_KEY)).contexts[0];
  assert.equal(context.candidateId, 'A5072119017'); assert.equal(context.scrollY, 287);
  page.get('ss-institution-skip').dispatch('click'); await page.flush();
  assert.equal(new URL(page.requests.at(-1).url, state.location.href).searchParams.has('institution'), false);
});

test('browser back restores the selected real candidate and scroll without an automatic redirect', async () => {
  const state = browser('https://demo.example/workbench/index.html?q=Linsen+Xu&network=mainnet');
  const first = await searchPage(state);
  first.document.querySelector('a[data-reader-candidate="A5072119017"]').dispatch('click');
  const returned = await searchPage(state, { navigationType: 'back_forward' });
  const link = returned.document.querySelector('a[data-reader-candidate="A5072119017"]');
  assert.equal(returned.document.activeElement, link);
  assert.equal(returned.window.scrolledTo.top, 287);
  assert.match(returned.get('ss-status').textContent, /已恢复所选档案/);
  assert.equal(state.location.assigned.length, 0);
});

test('unresolved institution is explained separately from missing scholar records and can be cleared', async () => {
  const state = browser('https://demo.example/workbench/index.html?q=徐林森&institution=未知大学');
  const page = await searchPage(state, { fetcher: async () => ({ ok: true, json: async () => payload([], { institution: { status: 'unresolved', matches: [] } }) }) });
  assert.match(page.get('ss-empty-title').textContent, /单位/);
  assert.match(page.get('ss-empty-detail').textContent, /不代表研究者没有档案/);
  assert.equal(page.get('ss-institution-guide').hidden, false);
});

test('clearing or replacing a pending query aborts stale results and IME Enter never submits early', async () => {
  const state = browser('https://demo.example/workbench/index.html');
  const pending = [];
  const page = await searchPage(state, { fetcher: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })) });
  const input = page.get('ss-query');
  input.value = '旧查询'; input.dispatch('compositionstart'); page.get('ss-form').dispatch('submit');
  assert.equal(pending.length, 0);
  input.dispatch('compositionend'); page.get('ss-form').dispatch('submit');
  input.value = '新查询'; input.dispatch('input'); page.get('ss-form').dispatch('submit');
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve({ ok: true, json: async () => payload([author('A2', 'Current')]) }); await page.flush();
  pending[0].resolve({ ok: true, json: async () => payload([author('A1', 'Stale')]) }); await page.flush();
  assert.match(page.get('ss-result-list').textContent, /Current/); assert.doesNotMatch(page.get('ss-result-list').textContent, /Stale/);
  input.value = 'Another'; input.dispatch('input'); page.get('ss-form').dispatch('submit');
  input.value = ''; input.dispatch('input');
  pending[2].resolve({ ok: true, json: async () => payload([author('A3')]) }); await page.flush();
  assert.equal(page.get('ss-results').hidden, true); assert.equal(page.get('ss-result-list').children.length, 0);
});

test('upstream errors retain retry and external search, and candidate text never becomes HTML', async () => {
  let fail = true;
  const state = browser('https://demo.example/workbench/index.html?q=Linsen+Xu');
  const page = await searchPage(state, { fetcher: async () => ({ ok: !fail, json: async () => fail ? { error: '上游查询暂不可用' } : payload([author('A123', '<img src=x onerror=alert(1)>')]) }) });
  assert.equal(page.get('ss-retry').hidden, false); assert.match(page.get('ss-empty-detail').textContent, /暂不可用/);
  assert.match(page.get('ss-external-search').href, /^https:\/\/openalex.org\//);
  fail = false; page.get('ss-retry').dispatch('click'); await page.flush();
  assert.match(page.get('ss-result-list').textContent, /<img src=x/);
  assert.equal(page.get('ss-result-list').querySelectorAll('img').length, 0);
});

test('storage denial and failed explicit return still provide usable search and projection controls', async () => {
  const state = browser('https://demo.example/workbench/index.html?network=testnet#reader-return-unavailable', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
  const page = await searchPage(state);
  assert.equal(new URL(state.location.href).hash, '');
  assert.match(page.get('ss-status').textContent, /原搜索结果和阅读位置未保留/);
  page.get('ss-present').dispatch('click'); assert.equal(page.document.body.dataset.presentation, 'true');
  page.get('ss-query').value = 'Linsen Xu'; page.get('ss-form').dispatch('submit'); await page.flush();
  const link = page.document.querySelector('a[data-reader-candidate="A5072119017"]');
  assert.doesNotThrow(() => link.dispatch('click')); assert.match(link.href, /\/live\//);
});
