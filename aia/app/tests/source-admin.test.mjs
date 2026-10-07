import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createSourceAdmin } from '../lib/source-admin.mjs';

const token = 'test-admin-only-token-which-is-long-enough';
const base = '/admin/sources/api';
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-source-admin-'));
  const env = { AIA_ADMIN_TOKEN: token, OPENALEX_API_KEY: 'env-openalex-secret', PRIVATE_KEY: 'never-export-wallet-key', ...options.env };
  let admin, server, origin;
  async function start() {
    admin = await createSourceAdmin({ dataDir, env, requestOrigin: () => origin, ...options });
    server = http.createServer(async (req, res) => { if (!await admin.handle(req, res, new URL(req.url, origin))) { res.writeHead(404); res.end(); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await admin.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await start();
  t.after(async () => { await stop(); assert.equal(path.dirname(dataDir), os.tmpdir()); assert.match(path.basename(dataDir), /^aia-source-admin-/); await rm(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = '', csrf = '';
    return { async request(route, method = 'GET', body, headers = {}) {
      const response = await fetch(origin + base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (result.csrfToken) csrf = result.csrfToken;
      return { status: response.status, result, headers: response.headers };
    }, async login(value = token) { return this.request('/login', 'POST', { token: value }); } };
  }
  return { dataDir, env, client, get admin() { return admin; }, async restart() { await stop(); await start(); } };
}

test('independent administrator auth denies ordinary users and protects login, mutations and secret reads', async t => {
  const f = await fixture(t); const user = f.client();
  assert.deepEqual((await user.request('/session')).result, { authenticated: false });
  assert.equal((await user.request('/sources', 'GET', undefined, { Cookie: 'aia_session=ordinary-user-session' })).status, 401);
  assert.equal((await user.request('/sources/sciverse', 'PUT', { values: { SCIVERSE_API_TOKEN: 'forbidden' } })).status, 401);
  assert.equal((await user.request('/login', 'POST', { token }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await user.request('/login', 'POST', { token }, { Origin: '' })).status, 403);
  const login = await user.login(); assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /Path=\/admin\/sources\/; HttpOnly; SameSite=Strict/);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.equal((await user.request('/sources/sciverse', 'PUT', { values: { SCIVERSE_API_TOKEN: 'new-secret' } }, { 'X-CSRF-Token': 'forged' })).status, 403);
  assert.equal((await user.request('/sources/sciverse', 'PUT', { values: { SCIVERSE_API_TOKEN: 'new-secret' } }, { Origin: 'https://evil.example' })).status, 403);
  const sources = await user.request('/sources'); assert.equal(sources.status, 200);
  const text = JSON.stringify(sources.result);
  assert.ok(!text.includes(f.env.OPENALEX_API_KEY)); assert.ok(!text.includes(token)); assert.ok(!text.includes(f.env.PRIVATE_KEY));
  assert.equal(f.admin.credentials().PRIVATE_KEY, undefined); assert.equal(f.admin.credentials().AIA_ADMIN_TOKEN, undefined);
  assert.equal((await user.request('/logout', 'POST', {})).status, 200);
  assert.equal((await user.request('/sources')).status, 401);
});

test('two model slots encrypt credentials, expose editable endpoint/model only, and retain independent access control', async t => {
  const f = await fixture(t, { providerDefinitions: [] }); const user = f.client(); await user.login();
  const fields = { LLM_A_BASE_URL: 'https://api.deepseek.com/', LLM_A_MODEL: 'deepseek-flash', LLM_A_API_KEY: 'model-secret-must-never-be-echoed' };
  const saved = await user.request('/sources/llm_a', 'PUT', { values: fields });
  assert.equal(saved.status, 200);
  const slot = saved.result.sources.find(source => source.id === 'llm_a');
  assert.equal(slot.supported, true); assert.equal(slot.kind, 'model');
  assert.equal(slot.fields.find(field => field.name === 'LLM_A_BASE_URL').value, 'https://api.deepseek.com');
  assert.equal(slot.fields.find(field => field.name === 'LLM_A_MODEL').value, 'deepseek-flash');
  assert.equal(slot.fields.find(field => field.name === 'LLM_A_API_KEY').value, undefined);
  assert.ok(!JSON.stringify(saved.result).includes(fields.LLM_A_API_KEY));
  for (const filename of await readdir(f.dataDir)) assert.ok(!(await readFile(path.join(f.dataDir, filename))).includes(Buffer.from(fields.LLM_A_API_KEY)));
  await f.restart(); assert.equal(f.admin.credentials().LLM_A_API_KEY, fields.LLM_A_API_KEY);
  const next = f.client(); await next.login();
  assert.equal((await next.request('/sources/llm_a', 'PUT', { values: { LLM_B_MODEL: 'other' } })).status, 400);
  for (const value of ['https://127.0.0.1', 'https://example.com/?key=secret', 'http://example.com']) {
    assert.equal((await next.request('/sources/llm_a', 'PUT', { values: { LLM_A_BASE_URL: value } })).status, 400);
  }
  await next.request('/sources/llm_a', 'DELETE', { mode: 'disable' });
  assert.equal(f.admin.credentials().LLM_A_API_KEY, ''); assert.equal(f.admin.credentials().LLM_A_MODEL, '');
});

test('saves only allowed fields, encrypts persisted overrides, reloads and distinguishes clear from disable', async t => {
  let changes = 0;
  const f = await fixture(t, { onChange: () => { changes++; } }); let user = f.client(); await user.login();
  const secret = 'new-openalex-very-private-secret';
  const saved = await user.request('/sources/openalex', 'PUT', { values: { OPENALEX_API_KEY: secret } });
  assert.equal(saved.status, 200); assert.equal(f.admin.credentials().OPENALEX_API_KEY, secret); assert.equal(changes, 1);
  assert.equal(saved.result.sources.find(s => s.id === 'openalex').fields[0].origin, 'saved');
  assert.ok(!JSON.stringify(saved.result).includes(secret));
  for (const filename of await readdir(f.dataDir)) { const bytes = await readFile(path.join(f.dataDir, filename)); assert.ok(!bytes.includes(Buffer.from(secret))); }
  assert.equal((await user.request('/sources/openalex', 'PUT', { values: { OPENALEX_API_KEY: '' } })).status, 200);
  assert.equal(f.admin.credentials().OPENALEX_API_KEY, secret); assert.equal(changes, 1);
  for (const values of [{ PRIVATE_KEY: 'evil' }, { SCIVERSE_API_TOKEN: 'wrong-provider' }, { OPENALEX_API_KEY: 'header\r\ninjection' }, { OPENALEX_API_KEY: 'white space' }]) {
    assert.equal((await user.request('/sources/openalex', 'PUT', { values })).status, 400);
  }
  assert.equal((await user.request('/sources/openalex', 'PUT', { values: { OPENALEX_API_KEY: 'x'.repeat(10000) } })).status, 413);
  await f.restart(); assert.equal(f.admin.credentials().OPENALEX_API_KEY, secret);
  assert.equal((await user.request('/sources')).status, 401); user = f.client(); await user.login();
  assert.equal((await user.request('/sources/openalex', 'DELETE', { mode: 'disable' })).status, 200);
  assert.equal(f.admin.credentials().OPENALEX_API_KEY, ''); assert.deepEqual(f.admin.disabledSources(), ['openalex']);
  await f.restart(); user = f.client(); await user.login();
  assert.equal(f.admin.credentials().OPENALEX_API_KEY, '');
  await user.request('/sources/openalex', 'PUT', { values: { OPENALEX_API_KEY: '' } });
  assert.equal(f.admin.credentials().OPENALEX_API_KEY, ''); assert.deepEqual(f.admin.disabledSources(), ['openalex']);
  assert.equal((await user.request('/sources/openalex', 'PUT', { values: {}, enabled: 'true' })).status, 400);
  const enabled = await user.request('/sources/openalex', 'PUT', { values: {}, enabled: true });
  assert.equal(enabled.status, 200); assert.equal(f.admin.credentials().OPENALEX_API_KEY, secret); assert.deepEqual(f.admin.disabledSources(), []);
  assert.equal(enabled.result.sources.find(s => s.id === 'openalex').fields[0].origin, 'saved');
  assert.equal(enabled.result.sources.find(s => s.id === 'openalex').enabled, true);
  await f.restart(); user = f.client(); await user.login(); assert.equal(f.admin.credentials().OPENALEX_API_KEY, secret);
  const cleared = await user.request('/sources/openalex', 'DELETE', { mode: 'clear' }); assert.equal(cleared.status, 200);
  assert.equal(f.admin.credentials().OPENALEX_API_KEY, 'env-openalex-secret'); assert.deepEqual(f.admin.disabledSources(), []);
  assert.equal(cleared.result.sources.find(s => s.id === 'openalex').fields[0].origin, 'environment');
  await user.request('/sources/arxiv', 'DELETE', { mode: 'disable' }); assert.deepEqual(f.admin.disabledSources(), ['arxiv']);
  await user.request('/sources/arxiv', 'DELETE', { mode: 'clear' }); assert.deepEqual(f.admin.disabledSources(), []);
});

test('generated token stays local; login attempts and sessions are bounded and expired', async t => {
  let time = 100000;
  const f = await fixture(t, { env: {}, now: () => time, secureCookies: true });
  const generated = (await readFile(path.join(f.dataDir, 'admin-access.txt'), 'utf8')).trim();
  assert.ok(generated.length >= 32);
  const user = f.client();
  for (let i = 0; i < 5; i++) assert.equal((await user.login('wrong-token')).status, 401);
  assert.equal((await user.login(generated)).status, 429);
  time += 15 * 60 * 1000;
  const login = await user.login(generated); assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /; Secure/);
  assert.ok(!JSON.stringify(login.result).includes(generated));
  time += 2 * 60 * 60 * 1000;
  assert.equal((await user.request('/sources')).status, 401);
  await f.restart(); assert.equal((await readFile(path.join(f.dataDir, 'admin-access.txt'), 'utf8')).trim(), generated);
});

test('callback failures are sanitized and corrupted encrypted state fails closed', async t => {
  const secret = 'do-not-return-this-private-key';
  const f = await fixture(t, { onChange: () => { const error = new Error(secret); error.status = 400; throw error; } });
  const user = f.client(); await user.login();
  const response = await user.request('/sources/sciverse', 'PUT', { values: { SCIVERSE_API_TOKEN: secret } });
  assert.equal(response.status, 500); assert.ok(!JSON.stringify(response.result).includes(secret));
  await writeFile(path.join(f.dataDir, 'source-config.enc'), '{"v":1,"ciphertext":"corrupted"}');
  await assert.rejects(createSourceAdmin({ dataDir: f.dataDir, env: { AIA_ADMIN_TOKEN: token }, requestOrigin: () => 'http://localhost' }), /could not be decrypted/);
});

test('SMTP configuration is separate from literature, encrypted, validated and never sends mail on save', async t => {
  const f = await fixture(t, { providerDefinitions: [] }), user = f.client(); await user.login();
  const values = { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_FROM: 'research@example.org', SMTP_USER: 'research@example.org', SMTP_PASS: 'mail password with spaces', SMTP_SECURE: 'true' };
  const saved = await user.request('/sources/smtp', 'PUT', { values }); assert.equal(saved.status, 200);
  const provider = saved.result.sources.find(item => item.id === 'smtp');
  assert.equal(provider.supported, true); assert.equal(provider.kind, 'mail');
  assert.equal(provider.fields.find(item => item.name === 'SMTP_PASS').secret, true);
  assert.equal(provider.fields.find(item => item.name === 'SMTP_HOST').secret, false);
  assert.equal(f.admin.credentials().SMTP_PASS, values.SMTP_PASS);
  assert.ok(!JSON.stringify(saved.result).includes(values.SMTP_PASS));
  assert.ok(!(await readFile(path.join(f.dataDir, 'source-config.enc'))).includes(Buffer.from(values.SMTP_PASS)));
  for (const invalid of [{ SMTP_PORT: '65536' }, { SMTP_PORT: 'not-number' }, { SMTP_HOST: 'https://smtp.example.org/path' }, { SMTP_FROM: 'A <a@example.org>' }, { SMTP_SECURE: 'yes' }, { SMTP_PASS: 'injected\r\nsecret' }]) {
    assert.equal((await user.request('/sources/smtp', 'PUT', { values: invalid })).status, 400);
  }
  await f.restart(); assert.equal(f.admin.credentials().SMTP_PASS, values.SMTP_PASS);
  const after = f.client(); await after.login(); await after.request('/sources/smtp', 'DELETE', { mode: 'disable' });
  assert.equal(f.admin.credentials().SMTP_HOST, ''); assert.equal(f.admin.credentials().SMTP_PASS, '');
});
