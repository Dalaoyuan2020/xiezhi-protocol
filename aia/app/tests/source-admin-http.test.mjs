import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-source-admin-http-'));
  const app = await createApp({ dataDir, sourceAdminOptions: { env: { AIA_ADMIN_TOKEN: 'test-administrator-token-long-enough', OPENALEX_API_KEY: 'server-key-must-not-appear' } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); assert.ok(path.basename(dataDir).startsWith('aia-source-admin-http-')); await rm(dataDir, { recursive: true, force: true }); });
  return { origin, request: (route, options) => fetch(origin + route, options) };
}

test('source management has a separate, unlinked, restricted page and authenticated API', async t => {
  const env = await setup(t);
  for (const route of ['/admin/sources/', '/admin/sources/admin.js', '/admin/sources/admin.css']) {
    const response = await env.request(route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(await response.text(), /server-key-must-not-appear|test-administrator-token-long-enough/);
  }
  for (const route of ['/ui/', '/ui/cases.html', '/ui/papers.html']) {
    const html = await (await env.request(route)).text();
    assert.doesNotMatch(html, /href=["'][^"']*admin\/sources|server-key-must-not-appear/);
  }
  assert.equal((await env.request('/admin/sources/api/sources')).status, 401);
  for (const route of ['/admin/sources/source-config.enc', '/admin/sources/source-config.key', '/admin/sources/admin-access.txt', '/.runtime/admin-access.txt', '/aia/app/.env']) {
    assert.equal((await env.request(route)).status, 404, route);
  }
  const csrfAttempt = await env.request('/admin/sources/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: JSON.stringify({ token: 'test-administrator-token-long-enough' }) });
  assert.equal(csrfAttempt.status, 403);
});

test('managed source changes take effect on public health without exposing a secret', async t => {
  const env = await setup(t);
  const login = await env.request('/admin/sources/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.origin }, body: JSON.stringify({ token: 'test-administrator-token-long-enough' }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = { 'Content-Type': 'application/json', Origin: env.origin, Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken };
  assert.equal((await (await env.request('/scholar-api/health')).json()).apiKeyConfigured, true);
  const disabled = await env.request('/admin/sources/api/sources/openalex', { method: 'DELETE', headers, body: JSON.stringify({ mode: 'disable' }) });
  assert.equal(disabled.status, 200);
  const search = await env.request('/scholar-api/search?q=Ada');
  assert.equal(search.status, 503);
  assert.doesNotMatch(await search.text(), /server-key-must-not-appear/);
  const sources = await env.request('/admin/sources/api/sources', { headers });
  assert.equal(sources.status, 200);
  assert.doesNotMatch(await sources.text(), /server-key-must-not-appear|test-administrator-token-long-enough/);
});
