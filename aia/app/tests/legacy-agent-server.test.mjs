import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAgentServer, DEFAULT_PORT } from '../../chain/agent-server.mjs';

async function setup(t, options = {}) {
  const calls = [], keyReads = [];
  const server = createAgentServer({ anchoringEnabled: false, getDeployment: () => ({ address: 'public-test-contract' }),
    getPrivateKey: () => { keyReads.push(true); return 'injected-non-wallet-test-value'; },
    run: async (query, emit, opts) => { calls.push({ type: 'run', query, opts }); emit({ step: 1, query }); },
    stamp: async (input, emit, opts) => { calls.push({ type: 'stamp', input, opts }); emit({ step: 1, bytes: input.bytes.length }); }, ...options });
  assert.equal(server.listening, false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  async function request(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + route, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }
  const rawRequest = route => new Promise((resolve, reject) => {
    httpRequest(origin, { path: route }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) })); }).on('error', reject).end();
  });
  return { request, rawRequest, origin, calls, keyReads };
}

test('legacy Agent uses port 8892 and a precise public allowlist; imports do not start a listener or read keys', async t => {
  assert.equal(DEFAULT_PORT, 8892);
  const env = await setup(t);
  for (const route of ['/', '/workbench/index.html','/workbench/card.html','/workbench/checkup.html','/workbench/search.js','/workbench/style.css','/workbench/search-data.json','/workbench/org-mock.json','/product/mock_cases.json','/chain/artifacts/ActionRegistry.json','/chain/deployments/botchain-testnet.json','/chain/deployments/journals-testnet.json','/brand/seal.html','/brand/seal.png','/workbench/reader-context.js','/workbench/evidence-core.js','/workbench/role-drafts.js','/chain/artifacts/PointsLedger.json','/chain/deployments/points-testnet.json']) assert.equal((await env.request(route)).status, 200, route);
  for (const route of ['/app/.runtime/aia.sqlite','/app/.runtime/aia.sqlite-wal','/.env','/chain/.env','/app/server.mjs','/chain/agent-server.mjs','/chain/agent.mjs','/chain/config.mjs','/chain/contracts/ActionRegistry.sol','/chain/receipts/private.json','/product/checkup.py','/workbench/tests/search-core.test.cjs','/workbench/package.json','/workbench/README.md','/node_modules/ethers/package.json','/brand/README.md']) {
    const response = await env.request(route); assert.equal(response.status, 404, route); assert.equal(response.json.code, 'NOT_FOUND');
  }
  for (const route of ['/workbench/../app/.runtime/aia.sqlite','/workbench/%2e%2e/app/.runtime/aia.sqlite','/workbench/%2e%2e%2fapp/server.mjs','/workbench/%5c..%5c.env']) assert.equal((await env.rawRequest(route)).status, 404, route);
  assert.equal((await env.rawRequest('/workbench/%ZZ')).status, 400);
  assert.equal((await env.request('/workbench/index.html', { method: 'HEAD' })).text, '');
  assert.equal((await env.request('/workbench/index.html', { method: 'POST' })).status, 405);
  const health = await env.request('/api/health'); assert.equal(health.status, 200); assert.equal(health.json.wallet, null); assert.equal(health.json.balance, null); assert.equal(health.json.anchoringEnabled, false);
  assert.equal(env.keyReads.length, 0); assert.equal(env.calls.length, 0);
});

test('Agent host serves the canonical teammate UI and redirects retired URLs without losing network or case', async t => {
  const env = await setup(t);
  const query = '?case=A5126602136&network=mainnet&q=Lv%20Z&tag=1&tag=2';
  for (const [before, after] of [['/', '/ui/'], ['/classic', '/ui/'], ['/ui/card.html', '/ui/checkup.html'], ['/classic/live', '/live/'], ['/index.html', '/ui/'], ['/ui', '/ui/'], ['/workbench/card.html', '/workbench/checkup.html'], ['/legacy/ui/card.html', '/ui/checkup.html'], ['/legacy/ui/', '/ui/'], ['/legacy/ui/index.html', '/ui/index.html'], ['/legacy/ui/search.js', '/ui/search.js'], ['/legacy/chain/deployments/points.json', '/chain/deployments/points.json']]) {
    const response = await fetch(env.origin + before + query, { redirect: 'manual' });
    assert.equal(response.status, 302, before); assert.equal(response.headers.get('location'), after + query, before);
  }
  assert.equal((await env.request('/workbench/')).text, await readFile(new URL('../../../新ui/index.html', import.meta.url), 'utf8'));
  assert.equal((await env.request('/workbench/workbench.css')).status, 200);
  for (const route of ['/workbench/cases.html', '/workbench/workbench.js', '/workbench/page-registry.js']) assert.equal((await env.request(route)).status, 200, route);
  assert.deepEqual((await env.request('/product/mock_cases.json')).json, JSON.parse(await readFile(new URL('../../product/mock_cases.json', import.meta.url), 'utf8')));
  for (const route of ['/legacy/ui/README.md','/legacy/product/checkup.py','/workbench/product/checkup.py','/legacy/app/.runtime/aia.sqlite','/xiezhi-ui/README.md','/aia/public-ui.mjs']) assert.equal((await env.request(route)).status, 404, route);
  assert.equal((await env.request('/ui/')).text, await readFile(new URL('../../../xiezhi-ui/index.html', import.meta.url), 'utf8'));
  for (const route of ['/ui/menu.js', '/ui/style-guanya.css', '/ui/papers.html', '/live/', '/live/live.js', '/workbench/live/workbench-live.css']) assert.equal((await env.request(route)).status, 200, route);
  for (const route of ['/ui/.env', '/ui/package.json', '/ui/README.md', '/ui/tests/search-core.test.cjs', '/live/agent.mjs']) assert.equal((await env.request(route)).status, 404, route);
  assert.equal(env.calls.length, 0); assert.equal(env.keyReads.length, 0);
});

test('GET can never anchor; same-origin POST still requires explicit server enablement', async t => {
  const env = await setup(t);
  assert.equal((await env.request('/api/run?q=A5126602136&anchor=1')).status, 405);
  assert.equal((await env.request('/api/stamp?anchor=1')).status, 405);
  assert.equal((await env.request('/api/run?q=A5126602136&anchor=1', { method: 'POST' })).status, 403);
  assert.equal((await env.request('/api/run?q=A5126602136&anchor=1', { method: 'POST', headers: { Origin: 'https://outside.invalid' } })).status, 403);
  for (const route of ['/api/run?q=A5126602136&anchor=1','/api/stamp?author=A5126602136&anchor=1']) {
    const response = await env.request(route, { method: 'POST', body: 'manuscript', headers: { Origin: env.origin } });
    assert.equal(response.status, 403); assert.equal(response.json.code, 'ANCHOR_DISABLED');
  }
  assert.equal(env.keyReads.length, 0); assert.equal(env.calls.length, 0);
  const readonly = await env.request('/api/run?q=A5126602136'); assert.equal(readonly.status, 200); assert.match(readonly.text, /"done":true/);
  const preview = await env.request('/api/stamp?author=A5126602136', { method: 'POST', body: '# Supplied content', headers: { Origin: env.origin } }); assert.equal(preview.status, 200);
  assert.ok(env.calls.every(call => call.opts.anchor === false && call.opts.privateKey === null)); assert.equal(env.keyReads.length, 0);
});

test('enabled anchoring only reaches injected jobs after POST and exact Origin, with stable failures before and during SSE', async t => {
  const env = await setup(t, { anchoringEnabled: true });
  assert.equal((await env.request('/api/run?q=A5126602136&anchor=1')).status, 405);
  assert.equal((await env.request('/api/run?q=A5126602136&anchor=1', { method: 'POST', headers: { Origin: 'http://localhost:8890' } })).status, 403);
  assert.equal(env.keyReads.length, 0);
  const response = await env.request('/api/run?q=A5126602136&anchor=1', { method: 'POST', headers: { Origin: env.origin } });
  assert.equal(response.status, 200); assert.match(response.text, /"done":true/); assert.equal(env.keyReads.length, 1); assert.equal(env.calls[0].opts.anchor, true);
  const invalid = await env.request('/api/run?q=A5126602136&anchor=1&anchor=0', { method: 'POST', headers: { Origin: env.origin } }); assert.equal(invalid.status, 400);
  assert.equal((await env.request('/api/run?q=A5126602136', { method: 'PUT' })).status, 405);
  assert.equal((await env.request('/api/run')).status, 400);
  assert.equal((await env.request('/api/run?q=name&pick=../../private')).status, 400);
  assert.equal((await env.request('/api/stamp', { method: 'POST', body: '', headers: { Origin: env.origin } })).status, 400);
  const large = await env.request('/api/stamp', { method: 'POST', body: Buffer.alloc(5 * 1024 * 1024 + 1, 65), headers: { Origin: env.origin } });
  assert.equal(large.status, 413); assert.equal(large.json.code, 'BODY_TOO_LARGE');
  const failing = await setup(t, { run: async () => { throw new Error('do-not-expose-internal-details'); }, getDeployment: () => { throw new Error('private-config-path'); } });
  const health = await failing.request('/api/health'); assert.equal(health.status, 500); assert.equal(health.json.code, 'INTERNAL_ERROR'); assert.equal(health.text.includes('private-config-path'), false);
  const stream = await failing.request('/api/run?q=A5126602136'); assert.equal(stream.status, 200); assert.match(stream.text, /AGENT_EXECUTION_FAILED/); assert.equal(stream.text.includes('do-not-expose'), false);
});
