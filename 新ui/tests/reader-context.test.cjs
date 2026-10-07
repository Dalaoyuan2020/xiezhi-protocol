'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reader = require('../reader-context.js');

function tab(href = 'https://demo.example/ui/index.html?q=Zhiyuan+Lyu&network=testnet', storage) {
  const values = new Map();
  const localStorage = storage || { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const location = { href, assign(url) { this.href = url; } };
  const history = { state: null, length: 1, replaceState(value, _, url) { this.state = value; location.href = String(url); } };
  const document = { referrer: '' };
  let type = 'navigate';
  let counter = 0;
  const instance = () => reader.create({ location, history, document, storage: localStorage, navigationType: () => type, newToken: () => 'context-token-' + (++counter) });
  function navigate(url, nextType = 'navigate', state = null) {
    if (nextType === 'navigate') history.length += 1;
    document.referrer = location.href;
    location.href = url;
    history.state = state;
    type = nextType;
    return instance();
  }
  return { instance, navigate, location, history, document, storage: localStorage, values };
}

test('same-tab search → detail → refresh → return restores the exact query, network, candidate and reading position', () => {
  const browser = tab();
  const search = browser.instance();
  browser.history.state = { unrelated: 'preserved' };
  assert.equal(search.captureSearch({ q: 'Zhiyuan Lyu', candidateId: 'A5111337086', scrollY: 731 }), true);
  const searchState = browser.history.state;
  assert.equal(searchState.unrelated, 'preserved');
  const detail = browser.navigate('https://demo.example/ui/checkup.html?case=A5111337086&candidate=1&network=testnet');
  assert.equal(detail.detailContext().candidateId, 'A5111337086');
  const detailState = browser.history.state;
  const refreshed = browser.navigate(browser.location.href, 'reload', detailState);
  const result = refreshed.prepareReturn();
  assert.equal(result.restored, true);
  assert.equal(new URL(result.url).searchParams.get('q'), 'Zhiyuan Lyu');
  const returned = browser.navigate(result.url);
  const context = returned.searchRestore();
  assert.deepEqual([context.q, context.candidateId, context.scrollY, context.network], ['Zhiyuan Lyu', 'A5111337086', 731, 'testnet']);
  assert.equal(returned.canRestore('Zhiyuan Lyu', context), true);
  // A refresh of the returned result page retains the explicit return state.
  assert.equal(browser.navigate(browser.location.href, 'reload', browser.history.state).searchRestore().candidateId, 'A5111337086');
});

test('browser back restores its search entry, while ordinary ORCID navigation has no restoration privilege', () => {
  const q = '0009-0008-5473-5367';
  const browser = tab('https://demo.example/ui/index.html?q=' + q + '&network=mainnet');
  const search = browser.instance();
  assert.equal(search.searchRestore(), null);
  assert.equal(search.canRestore(q, null), false);
  search.captureSearch({ q, candidateId: 'A5126602136', scrollY: 12 });
  const original = { url: browser.location.href, state: browser.history.state };
  const detail = browser.navigate('https://demo.example/ui/checkup.html?case=A5126602136&network=mainnet');
  assert.ok(detail.detailContext());
  const back = browser.navigate(original.url, 'back_forward', original.state);
  const context = back.searchRestore();
  assert.equal(back.canRestore(q, context), true);
  assert.equal(back.canRestore('0009-0005-5014-6889', context), false);
  back.clearSearchRestore();
  assert.equal(back.searchRestore(), null);
});

test('contexts never cross networks, including an explicit-network change during detail refresh', () => {
  const browser = tab();
  browser.instance().captureSearch({ q: 'Zhiyuan Lyu', candidateId: 'A5111337086', scrollY: 200 });
  const detail = browser.navigate('https://demo.example/ui/checkup.html?case=A5111337086&candidate=1&network=testnet');
  assert.ok(detail.detailContext());
  const changed = browser.navigate('https://demo.example/ui/checkup.html?case=A5111337086&candidate=1&network=mainnet', 'reload', browser.history.state);
  assert.equal(changed.detailContext(), null);
  assert.equal(changed.prepareReturn().url, 'https://demo.example/ui/index.html?network=mainnet');
  assert.equal(browser.navigate('https://demo.example/ui/index.html?q=Zhiyuan+Lyu&network=mainnet', 'back_forward').searchRestore(), null);
});

test('new tabs with copied sessionStorage do not adopt an already-used context or another candidate', () => {
  const browser = tab();
  browser.instance().captureSearch({ q: 'Zhiyuan Lyu', candidateId: 'A5111337086', scrollY: 200 });
  const pendingCopy = tab('https://demo.example/ui/checkup.html?case=A5111337086&candidate=1&network=testnet', browser.storage);
  pendingCopy.document.referrer = browser.location.href;
  assert.equal(pendingCopy.instance().detailContext(), null);
  const wrong = tab('https://demo.example/ui/checkup.html?case=A5008144497&candidate=1&network=testnet', browser.storage);
  wrong.document.referrer = browser.location.href;
  assert.equal(wrong.instance().detailContext(), null);
  const detail = browser.navigate('https://demo.example/ui/checkup.html?case=A5111337086&candidate=1&network=testnet');
  assert.ok(detail.detailContext());
  const copied = tab(browser.location.href, browser.storage);
  copied.document.referrer = 'https://demo.example/ui/index.html?q=Zhiyuan+Lyu&network=testnet';
  assert.equal(copied.instance().detailContext(), null);
  assert.equal(copied.instance().prepareReturn().url, 'https://demo.example/ui/index.html?network=testnet');
});

test('foreign referrers, invalid networks and unrelated pages cannot claim a pending context', () => {
  for (const [url, referrer] of [
    ['https://demo.example/ui/checkup.html?case=A5111337086&network=testnet', 'https://evil.example/ui/index.html?q=Zhiyuan+Lyu&network=testnet'],
    ['https://demo.example/ui/checkup.html?case=A5111337086&network=unknown', 'https://demo.example/ui/index.html?q=Zhiyuan+Lyu&network=testnet'],
    ['https://demo.example/ui/org.html?case=A5111337086&network=testnet', 'https://demo.example/ui/index.html?q=Zhiyuan+Lyu&network=testnet']
  ]) {
    const browser = tab();
    browser.instance().captureSearch({ q: 'Zhiyuan Lyu', candidateId: 'A5111337086', scrollY: 0 });
    const detail = browser.navigate(url);
    browser.document.referrer = referrer;
    assert.equal(detail.detailContext(), null);
  }
});

test('return URL validation prevents arbitrary navigation and rebuilds only supported search parameters', () => {
  const here = 'https://demo.example/ui/checkup.html?case=A123';
  for (const url of ['https://evil.example/ui/index.html', 'javascript:alert(1)', '/other/index.html', '/ui/org.html',
    'https://user:password@demo.example/ui/index.html', 'index.html?network=evil', 'index.html?q=' + 'x'.repeat(201)]) {
    assert.equal(reader.safeReturnUrl(url, here), null, url);
  }
  assert.equal(reader.safeReturnUrl('index.html?q=吕志远&network=mainnet&redirect=https://evil.example#anything', here),
    'https://demo.example/ui/index.html?q=%E5%90%95%E5%BF%97%E8%BF%9C&network=mainnet');
});

test('storage denial, quota errors, malformed JSON and a blocked property getter do not break navigation', () => {
  for (const storage of [
    { getItem() { throw Error('denied'); }, setItem() {} },
    { getItem() { return null; }, setItem() { throw Error('quota'); } },
    { getItem() { return '{bad json'; }, setItem() {} },
    null
  ]) {
    const browser = tab('https://demo.example/ui/checkup.html?case=A123&network=testnet', storage || { getItem() { throw Error('blocked'); }, setItem() {} });
    const context = browser.instance();
    assert.equal(context.captureSearch({ q: 'test', candidateId: 'A123', scrollY: 5 }), false);
    assert.deepEqual(context.prepareReturn(), { url: 'https://demo.example/ui/index.html?network=testnet', restored: false });
    assert.equal(context.searchRestore(), null);
  }
  const vm = require('node:vm');
  const fs = require('node:fs');
  const sandbox = { URL, location: { href: 'https://demo.example/ui/checkup.html?case=A123' }, history: { state: null } };
  Object.defineProperty(sandbox, 'sessionStorage', { get() { throw Error('SecurityError'); } });
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../reader-context.js'), 'utf8'), sandbox);
  const context = sandbox.XiezhiReader.create();
  assert.equal(context.storageAvailable(), false);
  assert.equal(context.prepareReturn().url, 'https://demo.example/ui/index.html');
});

test('modified links remain ordinary new-tab links and never arm a return request', () => {
  for (const event of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    assert.equal(reader.isSameTabActivation(event, { target: '' }), false);
  }
  assert.equal(reader.isSameTabActivation({ button: 0 }, { target: '_blank' }), false);
  assert.equal(reader.isSameTabActivation({ button: 0 }, { target: '' }), true);
});

test('the history-only ORCID loop guard is explicit and network-bound when storage is blocked', () => {
  const q = '0009-0008-5473-5367';
  const browser = tab('https://demo.example/ui/index.html?q=' + q + '&network=testnet', { getItem() { throw Error('denied'); }, setItem() {} });
  const search = browser.instance();
  assert.equal(search.captureSearch({ q, candidateId: 'A5126602136', direct: true }), false);
  assert.equal(search.shouldShowDirectResult(q), false);
  assert.equal(search.shouldShowDirectResult(q, { fromHistory: true }), true);
  browser.location.href = 'https://demo.example/ui/index.html?q=' + q + '&network=mainnet';
  assert.equal(search.shouldShowDirectResult(q, { fromHistory: true }), false);
  search.clearSearchRestore();
  assert.equal(search.shouldShowDirectResult(q, { fromHistory: true }), false);
});


test('live scholar details restore the exact institution refinement, selection and viewport without crossing routes', () => {
  const browser = tab('https://demo.example/workbench/index.html?q=徐林森&institution=河海&network=testnet');
  assert.equal(browser.instance().captureSearch({ q: '徐林森', candidateId: 'A5072119017', scrollY: 654 }), true);
  const detail = browser.navigate('https://demo.example/workbench/live/?q=A5072119017&network=testnet');
  assert.equal(detail.detailContext().candidateId, 'A5072119017');
  const savedState = browser.history.state;
  const result = detail.prepareReturn();
  assert.equal(result.restored, true);
  assert.equal(new URL(result.url).searchParams.get('institution'), '河海');
  const returned = browser.navigate(result.url);
  const context = returned.searchRestore();
  assert.equal(context.scrollY, 654);
  assert.equal(returned.canRestore('徐林森', context), true);
  browser.location.href = result.url.replace(encodeURIComponent('河海'), encodeURIComponent('北京大学'));
  assert.equal(browser.instance().canRestore('徐林森', context), false);
  const wrongCandidate = browser.navigate('https://demo.example/workbench/live/?q=A999&network=testnet', 'reload', savedState);
  assert.equal(wrongCandidate.detailContext(), null);
});

test('live return URL validation allows only the canonical workbench and bounded institution values', () => {
  const here = 'https://demo.example/workbench/live/?q=A5072119017';
  assert.equal(reader.safeReturnUrl('/workbench/index.html?q=徐林森&institution=河海&redirect=https://evil.example', here),
    'https://demo.example/workbench/index.html?q=%E5%BE%90%E6%9E%97%E6%A3%AE&institution=%E6%B2%B3%E6%B5%B7');
  for (const target of ['/live/index.html?q=test', '/workbench/index.html?institution=' + 'x'.repeat(161), '//evil.example/ui/index.html']) {
    assert.equal(reader.safeReturnUrl(target, here), null);
  }
  const browser = tab(here);
  assert.equal(browser.instance().prepareReturn().url, 'https://demo.example/workbench/index.html');
});
