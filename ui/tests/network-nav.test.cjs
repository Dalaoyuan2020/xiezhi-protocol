'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../network-nav.js'), 'utf8');
const valid = { chainId: 968, address: '0x' + '1'.repeat(40), block: 7 };

async function run(search, response) {
  const calls = [];
  const redirects = [];
  const document = { getElementById: () => null };
  const location = { search, href: 'https://demo.example/ui/org.html' + search, replace: value => redirects.push(value) };
  vm.runInNewContext(source, {
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, document, location,
    fetch: async path => { calls.push(path); return response(path); }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, redirects };
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
