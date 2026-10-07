import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-literature-'));
  const app = await createApp({ dataDir, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); assert.ok(path.basename(dataDir).startsWith('aia-literature-')); await rm(dataDir, { recursive: true, force: true }); });
  return { origin, request: (route, options) => fetch(origin + route, options) };
}

test('literature routes work without a session and stay isolated from account writes', async t => {
  const calls = [], record = { source: 'sciverse', results: [] };
  const env = await setup(t, { literature: { health: () => ({ configured: true, source: 'sciverse', tools: ['search_papers'] }), search: async value => { calls.push(value); return record; }, catalog: async () => ({ fields: [] }), content: async args => args, resource: async file => ({ bytes: Buffer.from('binary'), mimeType: 'image/png' }) } });
  const response = await env.request('/scholar-api/literature/search?q=combustion&author=Ada&mode=semantic', { headers: { Referer: env.origin + '/ui/papers.html' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), record);
  assert.deepEqual(calls, [{ q: 'combustion', author: 'Ada', mode: 'semantic', page: 1, source: 'all', discipline: 'general' }]);
  assert.deepEqual(await (await env.request('/scholar-api/literature/content?doc=abc&offset=3')).json(), { doc: 'abc', offset: '3' });
  const resource = await env.request('/scholar-api/literature/resource?file=x.png');
  assert.equal(resource.headers.get('content-type'), 'image/png');
  assert.equal(resource.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(resource.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(await resource.text(), 'binary');
  for (const action of ['search', 'content', 'resource', 'catalog', 'health']) {
    const denied = await env.request('/scholar-api/literature/' + action, { method: 'POST' });
    assert.equal(denied.status, 405); assert.equal(denied.headers.get('allow'), 'GET');
  }
  assert.equal((await env.request('/scholar-api/literature/arbitrary')).status, 404);
  assert.equal((await env.request('/api/research')).status, 401);
  assert.equal((await env.request('/api/session', { headers: { Referer: env.origin + '/ui/papers.html' } })).status, 403);
  const html = await env.request('/ui/');
  assert.match(html.headers.get('content-security-policy'), /img-src[^;]*\/scholar-api\/literature\/resource/);
});

test('public failures are sanitized and client request budgets are enforced', async t => {
  let calls = 0;
  const env = await setup(t, { literatureLimits: { perMinute: 2 }, literature: { search: async () => { calls++; throw Object.assign(new Error('Bearer secret-example https://upstream/private'), { status: 403 }); } } });
  for (let n = 0; n < 2; n++) {
    const response = await env.request('/scholar-api/literature/search?q=valid');
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /secret-example|upstream|Bearer/);
  }
  assert.equal((await env.request('/scholar-api/literature/search?q=valid')).status, 429);
  assert.equal(calls, 2);
});

test('public concurrency budget releases after completion', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const env = await setup(t, { literatureLimits: { concurrent: 1 }, literature: { search: async () => { started(); await gate; return { results: [] }; } } });
  const first = env.request('/scholar-api/literature/search?q=valid');
  await ready;
  assert.equal((await env.request('/scholar-api/literature/search?q=another')).status, 429);
  release(); assert.equal((await first).status, 200);
  assert.equal((await env.request('/scholar-api/literature/search?q=another')).status, 200);
});
