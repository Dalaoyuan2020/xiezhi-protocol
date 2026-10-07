'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../network-nav.js'), 'utf8');
const valid = { chainId: 968, address: '0x' + '1'.repeat(40), block: 7 };

async function run(search, response, notice = null, anchors = [], pathname = '/ui/org.html') {
  const calls = [];
  const redirects = [];
  const listeners = {};
  const document = {
    getElementById: id => id === 'network-notice' ? notice : null,
    querySelectorAll: () => anchors,
    addEventListener: (type, listener) => { listeners[type] = listener; },
    createElement: () => ({ dataset: {}, setAttribute() {} }),
    querySelector: () => ({ after() {} }),
    head: { append() {} }
  };
  const location = { search, href: 'https://demo.example' + pathname + search, origin: 'https://demo.example', replace: value => redirects.push(value) };
  vm.runInNewContext(source, {
    XiezhiPages: require('../page-registry.js'),
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, document, location,
    fetch: async path => { calls.push(path); return response(path); }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, redirects, listeners };
}

test('explicit mainnet survives internal links, including dynamically rendered candidates', async () => {
  const state = await run('?network=mainnet', () => { throw Error('should not fetch'); });
  assert.equal(typeof state.listeners.click, 'function');
  for (const page of ['index', 'checkup', 'card', 'org', 'reviewer', 'submitter', 'rules', 'data']) {
    const anchor = { href: `https://demo.example/ui/${page}.html?case=A123&candidate=1` };
    state.listeners.click({ target: { closest: () => anchor } });
    const url = new URL(anchor.href);
    assert.equal(url.searchParams.get('network'), 'mainnet');
    assert.equal(url.searchParams.get('case'), 'A123');
    assert.equal(url.searchParams.get('candidate'), '1');
  }
});

test('initial real hrefs retain explicit network for copying and opening new tabs', async () => {
  const anchors = ['reviewer', 'submitter', 'rules', 'data', 'index'].map(page => ({ href: `https://demo.example/ui/${page}.html` }));
  anchors.push({ id: 'sc-network-choice', href: 'https://demo.example/ui/index.html?network=testnet' });
  await run('?network=mainnet', () => { throw Error('should not fetch'); }, null, anchors);
  for (const link of anchors.slice(0, -1)) assert.equal(new URL(link.href).searchParams.get('network'), 'mainnet');
  assert.equal(new URL(anchors.at(-1).href).searchParams.get('network'), 'testnet');
});

test('network notice mounts only in its declared slot on both networks', async () => {
  for (const network of ['mainnet', 'testnet']) {
    let banner;
    const notice = { replaceChildren: node => { banner = node; } };
    await run('?network=' + network, () => { throw Error('should not fetch'); }, notice);
    assert.equal(banner.className, 'sc-network-notice');
    assert.equal(banner.dataset.network, network);
    assert.match(banner.textContent, network === 'testnet' ? /不属于主网交付/ : /核验结果/);
  }
});

test('testnet propagation leaves explicit switch controls and external sources untouched', async () => {
  const state = await run('?network=testnet', () => { throw Error('should not fetch'); });
  const internal = { href: 'https://demo.example/ui/checkup.html?case=A123' };
  state.listeners.click({ target: { closest: () => internal } });
  assert.equal(new URL(internal.href).searchParams.get('network'), 'testnet');
  for (const anchor of [
    { id: 'sc-network-choice', href: 'https://demo.example/ui/index.html?network=mainnet' },
    { href: 'https://external.example/ui/checkup.html?case=A123' },
    { href: 'https://demo.example/another-app/checkup.html?case=A123' },
    { href: 'https://demo.example/product/checkup.py' }
  ]) {
    const original = anchor.href;
    state.listeners.click({ target: { closest: () => anchor } });
    assert.equal(anchor.href, original);
  }
});

test('unrecognized network parameters are never propagated', async () => {
  const state = await run('?network=untrusted', () => { throw Error('should not fetch'); });
  assert.equal(state.listeners.click, undefined);
});

test('default routing prefers mainnet when its manifest exists', async () => {
  const state = await run('', () => ({ status: 200, ok: true }));
  assert.equal(state.calls.length, 1);
  assert.equal(state.redirects.length, 0);
});

test('only a missing mainnet manifest routes to a valid testnet, preserving the current query', async () => {
  const state = await run('?q=A5126602136&mode=chain', path => path.endsWith('botchain.json')
    ? { status: 404, ok: false } : { status: 200, ok: true, json: async () => valid });
  assert.equal(state.calls.length, 2);
  const next = new URL(state.redirects[0]);
  assert.equal(next.searchParams.get('network'), 'testnet');
  assert.equal(next.searchParams.get('q'), 'A5126602136');
  assert.equal(next.searchParams.get('mode'), 'chain');
});

test('explicit mainnet selection never silently switches to the available testnet', async () => {
  const state = await run('?network=mainnet', () => { throw Error('should not fetch'); });
  assert.equal(state.calls.length, 0);
  assert.equal(state.redirects.length, 0);
});

test('server and connection failures are not treated as missing mainnet deployment', async () => {
  for (const response of [() => ({ status: 500, ok: false }), () => { throw Error('offline'); }]) {
    const state = await run('', response);
    assert.equal(state.calls.length, 1);
    assert.equal(state.redirects.length, 0);
  }
});

test('missing, wrong-network or malformed testnet manifests cannot trigger a redirect', async () => {
  for (const config of [null, { ...valid, chainId: 677 }, { ...valid, address: '0x0' }, { ...valid, block: -1 }]) {
    const state = await run('', path => path.endsWith('botchain.json')
      ? { status: 404, ok: false } : { status: config ? 200 : 404, ok: Boolean(config), json: async () => config });
    assert.equal(state.redirects.length, 0);
  }
});


test('nested workbench live pages use the workbench registry base and shared deployment URLs', async () => {
  const links = [{ href: '/workbench/papers.html?author=Linsen+Xu' }, { href: '/workbench/index.html?q=A123' }, { href: '/ui/index.html' }];
  await run('?network=testnet', () => { throw Error('should not fetch'); }, null, links, '/workbench/live/');
  assert.equal(new URL(links[0].href).searchParams.get('network'), 'testnet');
  assert.equal(new URL(links[1].href).searchParams.get('network'), 'testnet');
  assert.equal(links[2].href, '/ui/index.html');
  const state = await run('', path => path.endsWith('botchain.json') ? { status: 404, ok: false } : { status: 200, ok: true, json: async () => valid }, null, [], '/workbench/live/');
  assert.deepEqual(state.calls, ['/chain/deployments/botchain.json', '/chain/deployments/botchain-testnet.json']);
  assert.equal(new URL(state.redirects[0]).pathname, '/workbench/live/');
});
