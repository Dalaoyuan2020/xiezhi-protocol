'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../network-nav.js'), 'utf8');
const valid = { chainId: 968, address: '0x' + '1'.repeat(40), block: 7 };

async function run(search, response, links = [], pathname = '/ui/org.html') {
  const calls = [];
  const redirects = [];
  const listeners = new Map();
  const document = {
    getElementById: () => null,
    querySelectorAll: () => links,
    querySelector: () => null,
    createElement: () => ({ setAttribute() {} }),
    head: { append() {} },
    addEventListener: (name, callback) => listeners.set(name, callback)
  };
  const location = { search, origin: 'https://demo.example', href: 'https://demo.example' + pathname + search, replace: value => redirects.push(value) };
  vm.runInNewContext(source, {
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, document, location,
    fetch: async path => { calls.push(path); return response(path); }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, redirects, listeners };
}

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

test('static menu and case links retain either explicitly selected network', async () => {
  for (const network of ['mainnet', 'testnet']) {
    const links = [
      { href: 'cases.html' },
      { href: 'index.html?q=Zhiyuan%20Lyu#ss-results' },
      { href: 'checkup.html?case=SYNTHETIC' },
      { href: '/ui/' },
      { href: 'org.html?network=mainnet', id: 'sc-network-choice' },
      { href: 'https://external.example/ui/cases.html' },
      { href: '/app/' }
    ];
    const untouched = links.slice(4).map(anchor => anchor.href);
    await run('?network=' + network, () => { throw Error('should not fetch'); }, links);
    for (const anchor of links.slice(0, 4)) assert.equal(new URL(anchor.href).searchParams.get('network'), network);
    assert.equal(new URL(links[1].href).searchParams.get('q'), 'Zhiyuan Lyu');
    assert.equal(new URL(links[1].href).hash, '#ss-results');
    assert.equal(new URL(links[2].href).searchParams.get('case'), 'SYNTHETIC');
    assert.deepEqual(links.slice(4).map(anchor => anchor.href), untouched);
  }
});

test('dynamically created candidate links retain network for clicks and new-tab gestures', async () => {
  for (const network of ['mainnet', 'testnet']) {
    const state = await run('?network=' + network, () => { throw Error('should not fetch'); });
    for (const eventName of ['click', 'auxclick', 'contextmenu']) {
      const anchor = { href: 'checkup.html?case=A5111337086&candidate=1' };
      state.listeners.get(eventName)({ target: { closest: () => anchor } });
      const target = new URL(anchor.href);
      assert.equal(target.searchParams.get('network'), network);
      assert.equal(target.searchParams.get('case'), 'A5111337086');
      assert.equal(target.searchParams.get('candidate'), '1');
    }
  }
});


test('classic pages and nested live readers keep their edition and network on internal links', async () => {
  for (const pathname of ['/classic/index.html', '/classic/live/']) {
    const links = [{ href: '/workbench/' }, { href: '/workbench/live/?q=A123' }, { href: '/classic/' }, { href: '/classic/papers.html?q=water' }, { href: '/classic/live/?q=A123' }, { href: '/ui/index.html' }, { href: '/live/?q=A456' }, { href: '/other/index.html' }];
    const state = await run('?network=testnet', () => { throw Error('should not fetch'); }, links, pathname);
    for (const link of links.slice(0, 7)) assert.equal(new URL(link.href).searchParams.get('network'), 'testnet');
    assert.equal(new URL(links[3].href).pathname, '/classic/papers.html');
    assert.equal(new URL(links[3].href).searchParams.get('q'), 'water');
    assert.equal(links[7].href, '/other/index.html');
    assert.equal(state.calls.length, 0);
  }
});

test('deployment detection uses shared absolute URLs even under classic/live', async () => {
  const state = await run('', path => path.endsWith('botchain.json') ? { status: 404, ok: false } : { status: 200, ok: true, json: async () => valid }, [], '/classic/live/');
  assert.deepEqual(state.calls, ['/chain/deployments/botchain.json', '/chain/deployments/botchain-testnet.json']);
  assert.equal(new URL(state.redirects[0]).pathname, '/classic/live/');
});
