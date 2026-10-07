import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { createPublicAgentRunner } from '../lib/public-agent.mjs';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-scholar-public-'));
  const app = await createApp({ dataDir, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    assert.ok(path.basename(dataDir).startsWith('aia-scholar-public-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app, origin, request: (route, options) => fetch(origin + route, options) };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const events = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('public search works without an account and rejects invalid requests before querying upstream', async t => {
  const calls = [];
  const record = { source: 'openalex', fetchedAt: '2026-10-07T00:00:00.000Z', cached: false, results: [{ id: 'A1234567', name: 'Ada Lovelace' }] };
  const env = await setup(t, { scholars: { search: async query => { calls.push(query); return record; } } });
  const result = await env.request('/scholar-api/search?q=Ada%20Lovelace', { headers: { Referer: env.origin + '/workbench/' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.deepEqual(await result.json(), record);
  assert.deepEqual(calls, ['Ada Lovelace']);
  for (const query of ['', 'a', '%00Ada', 'a'.repeat(161)]) assert.equal((await env.request('/scholar-api/search?q=' + query)).status, 400);
  assert.deepEqual(calls, ['Ada Lovelace']);
  for (const route of ['/scholar-api/search?q=Ada', '/scholar-api/run?q=Ada', '/scholar-api/health']) {
    const response = await env.request(route, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  }
  assert.equal((await env.request('/api/scholars?q=Ada')).status, 401);
  assert.equal((await env.request('/scholar-api/claim?q=Ada')).status, 404);
  const health = await (await env.request('/scholar-api/health')).json();
  assert.equal(health.anchoringEnabled, false);
  assert.equal(health.assessmentCacheTtlHours, 24);
  assert.equal(typeof health.apiKeyConfigured, 'boolean');
  assert.equal(Object.hasOwn(health, 'apiKey'), false);
});

test('search failures never expose upstream URLs or credentials, and rate limits bound public requests', async t => {
  let calls = 0;
  const env = await setup(t, { scholarLimits: { search: 2 }, scholars: { search: async () => { calls++; throw Object.assign(new Error('https://api.openalex.org/?api_key=secret-test-only'), { status: 503 }); } } });
  for (let n = 0; n < 2; n++) {
    const response = await env.request('/scholar-api/search?q=Ada');
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /secret-test-only|api_key|api\.openalex/);
    assert.doesNotMatch(text, /results/);
  }
  assert.equal((await env.request('/scholar-api/search?q=Ada')).status, 429);
  assert.equal(calls, 2);
});

test('search concurrency is capped and releases the slot after an upstream response', async t => {
  const started = deferred(), release = deferred();
  const env = await setup(t, { scholarLimits: { concurrentSearches: 1 }, scholars: { search: async () => { started.resolve(); await release.promise; return { results: [] }; } } });
  const first = env.request('/scholar-api/search?q=Ada');
  await started.promise;
  assert.equal((await env.request('/scholar-api/search?q=Grace')).status, 429);
  release.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await env.request('/scholar-api/search?q=Grace')).status, 200);
});

test('public search passes optional institution text, validates it, and preserves only safe failure metadata', async t => {
  const calls = [];
  const env = await setup(t, { scholars: { search: async (query, options) => {
    calls.push({ query, options });
    if (options.institution === 'Unavailable') throw Object.assign(new Error('secret upstream URL'), { status: 503,
      institution: { query: 'secret upstream URL', status: 'unavailable', matches: ['secret'], privateKey: 'secret' } });
    return { results: [], ...(options.institution ? { institution: { query: options.institution, status: 'unresolved', matches: [] } } : {}) };
  } } });
  const response = await env.request('/scholar-api/search?q=Li%20Wei&institution=' + encodeURIComponent(' 河海大学 '));
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], { query: 'Li Wei', options: { institution: '河海大学' } });
  assert.equal((await response.json()).institution.status, 'unresolved');
  assert.equal((await env.request('/scholar-api/search?q=Li%20Wei&institution=')).status, 200);
  assert.equal(calls[1].options.institution, '');
  for (const institution of ['a', 'a'.repeat(161), 'A%00BC', '%3F%3F']) assert.equal((await env.request('/scholar-api/search?q=Li%20Wei&institution=' + institution)).status, 400);
  assert.equal(calls.length, 2);
  const unavailable = await env.request('/scholar-api/search?q=Li%20Wei&institution=Unavailable');
  assert.equal(unavailable.status, 503);
  const text = await unavailable.text();
  assert.doesNotMatch(text, /secret|privateKey|upstream URL/);
  assert.deepEqual(JSON.parse(text).institution, { query: 'Unavailable', status: 'unavailable', matches: [], applied: false });
});

test('public Agent run uses read-only options regardless of query flags and streams a terminating event', async t => {
  const calls = [];
  const env = await setup(t, { agentRun: async (query, emit, options) => {
    calls.push({ query, options });
    emit({ step: 3, target: { id: options.pick }, title: '核对身份' });
    emit({ step: 7, title: '未上链（演示模式）', chain: null });
  } });
  const response = await env.request('/scholar-api/run?q=Ada&pick=A1234567&anchor=1&privateKey=untrusted');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.deepEqual(calls, [{ query: 'Ada', options: { anchor: false, privateKey: null, pick: 'A1234567', query: 'Ada' } }]);
  const data = events(await response.text());
  assert.equal(data[0].target.id, 'A1234567');
  assert.match(data[1].title, /未发起链上写入/);
  assert.deepEqual(data.at(-1), { done: true });
  assert.equal((await env.request('/scholar-api/run?q=Ada&pick=..%2Fsecret')).status, 400);
  assert.equal(calls.length, 1);
});

test('SMTP booleans, ports and model names cannot corrupt or redact streamed research results', async t => {
  const payload = { step: 3, title: '核对身份', orcid: { match: false }, flag: true, absent: null,
    target: { id: 'A5126602136' }, stats: [587, 0, false, true], detail: 'false / 587 / step' };
  const env = await setup(t, { sourceAdminOptions: { env: { SMTP_SECURE: 'false', SMTP_PORT: '587', LLM_A_MODEL: 'step', SMTP_HOST: 'true', SMTP_USER: 'null' } },
    agentRun: async (_query, emit) => emit(payload) });
  const response = await env.request('/scholar-api/run?q=A5126602136');
  assert.equal(response.status, 200);
  assert.deepEqual(events(await response.text()), [payload, { done: true }]);
});

test('secret redaction preserves valid SSE JSON even for quoted, escaped or numeric-looking credentials', async t => {
  const key = 'fixture-key"with\\escapes', password = 'test-mail-password';
  const env = await setup(t, { sourceAdminOptions: { env: { OPENALEX_API_KEY: key, SMTP_PASS: password, S2_API_KEY: '587' } },
    agentRun: async (_query, emit) => emit({ step: 3, detail: `Upstream says "${key}"; ${password}`,
      nested: { quoted: key, port: 587, known: false, text: '587' } }) });
  const response = await env.request('/scholar-api/run?q=A5126602136');
  const data = events(await response.text());
  assert.deepEqual(data, [{ step: 3, detail: 'Upstream says "[redacted]"; [redacted]',
    nested: { quoted: '[redacted]', port: 587, known: false, text: '[redacted]' } }, { done: true }]);
});

test('Agent errors are sanitized and timed-out runs retain concurrency until upstream work stops', async t => {
  const pending = deferred(), stopped = deferred();
  let calls = 0;
  const env = await setup(t, { agentTimeoutMs: 40, scholarLimits: { concurrentRuns: 1, run: 20 }, agentRun: async () => {
    if (++calls === 1) { await pending.promise; stopped.resolve(); return; }
    throw new Error('credential=secret-test-only, private server path');
  } });
  const response = await env.request('/scholar-api/run?q=Ada');
  const timedOut = events(await response.text());
  assert.match(timedOut[0].error, /超时/);
  assert.deepEqual(timedOut.at(-1), { done: true });
  assert.equal((await env.request('/scholar-api/run?q=Grace')).status, 429);
  pending.resolve();
  await stopped.promise;
  const failure = await env.request('/scholar-api/run?q=Grace');
  const bytes = await failure.text();
  assert.equal(failure.status, 200);
  assert.doesNotMatch(bytes, /secret-test-only|credential|private server/);
  assert.match(events(bytes)[0].error, /未完成/);
  assert.deepEqual(events(bytes).at(-1), { done: true });
});

test('live page is public but has no account API or secret-file access', async t => {
  const env = await setup(t);
  for (const route of ['/workbench/live/', '/workbench/live/index.html', '/workbench/live/live.js', '/workbench/live/workbench-live.css', '/live/', '/live/index.html', '/live/live.js', '/live/live.css']) {
    const response = await env.request(route);
    assert.equal(response.status, 200, route);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes(`${env.origin}/workbench/`));
    assert.ok(csp.includes(`${env.origin}/live/`));
    assert.ok(csp.includes(`${env.origin}/scholar-api/`));
    assert.equal(csp.includes(`${env.origin}/api/`), false);
  }
  for (const page of ['/workbench/live/', '/live/']) assert.equal((await env.request('/api/session', { headers: { Referer: env.origin + page } })).status, 403);
  for (const route of ['/workbench/live/.env', '/workbench/live/../.env', '/chain/.env', '/chain/agent.mjs', '/app/.runtime/aia.sqlite', '/scholar-api/wallet']) {
    assert.equal((await env.request(route)).status, 404, route);
  }
});

test('a blocking public worker leaves HTTP responsive and disconnect releases its capacity after termination', async t => {
  const workerUrl = new URL('data:text/javascript,' + encodeURIComponent(`
    import { parentPort, workerData } from 'node:worker_threads';
    parentPort.postMessage({ kind: 'event', event: { step: 1, title: 'Started' } });
    if (workerData.query === 'Ada') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    parentPort.postMessage({ kind: 'done' });
  `));
  const run = createPublicAgentRunner({ workerUrl });
  const terminated = deferred();
  const env = await setup(t, { agentTimeoutMs: 2000, scholarLimits: { concurrentRuns: 1 }, agentRun: async (...args) => {
    try { await run(...args); } finally { terminated.resolve(); }
  } });
  const controller = new AbortController();
  const first = await env.request('/scholar-api/run?q=Ada', { signal: controller.signal });
  const reader = first.body.getReader();
  await reader.read();
  const before = Date.now();
  const health = await env.request('/scholar-api/health');
  assert.equal(health.status, 200);
  assert.ok(Date.now() - before < 1000, 'health must respond while worker is blocked');
  controller.abort();
  await terminated.promise;
  const next = await env.request('/scholar-api/run?q=Grace');
  assert.equal(next.status, 200);
  assert.deepEqual(events(await next.text()).at(-1), { done: true });
});
