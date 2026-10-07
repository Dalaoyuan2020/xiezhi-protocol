import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createClaimFlow, certificateHash } from '../lib/claim-flow.mjs';
import { smtpConfigured } from '../lib/claim-mail.mjs';

test('SMTP readiness rejects invalid transport settings instead of enabling an unusable verification flow', () => {
  const valid = { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_FROM: 'Scholar <mail@example.org>', SMTP_USER: 'user', SMTP_PASS: 'secret', SMTP_SECURE: 'true' };
  assert.equal(smtpConfigured(valid), true);
  for (const invalid of [{ SMTP_PORT: 'abc' }, { SMTP_PORT: '0' }, { SMTP_PORT: '65536' }, { SMTP_SECURE: 'yes' }, { SMTP_HOST: 'smtp.example.org\n' }, { SMTP_FROM: 'sender@example.org\r\nBcc: test@example.org' }, { SMTP_PASS: '' }]) {
    assert.equal(smtpConfigured({ ...valid, ...invalid }), false);
  }
});

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-claim-test-'));
  let service, server, origin;
  async function start() {
    service = await createClaimFlow({ dataDir, requestOrigin: () => origin, ...options });
    server = http.createServer(async (req, res) => { if (!await service.handle(req, res, new URL(req.url, origin))) { res.writeHead(404); res.end(); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await start();
  t.after(async () => { await stop(); assert.equal(path.dirname(dataDir), os.tmpdir()); assert.match(path.basename(dataDir), /^aia-claim-test-/); await rm(dataDir, { recursive: true, force: true }); });
  function client() {
    let cookie = '', csrf = '', flowId = '';
    return { async request(route, body, headers = {}) {
      const writing = body !== undefined;
      const response = await fetch(origin + '/claim-api' + route, { method: writing ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}),
        ...(writing ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}), ...headers },
        ...(writing ? { body: JSON.stringify({ flowId, ...body }) } : {}) });
      const result = await response.json();
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (result.csrfToken) csrf = result.csrfToken;
      if (result.flow?.id) flowId = result.flow.id;
      return { status: response.status, result, headers: response.headers };
    }, get flowId() { return flowId; }, async init() { return this.request('/session'); },
    async start(mode = 'demo', authorId) { return this.request('/start', { mode, authorId }); },
    async select(flow) { return this.request('/selection', { decisions: flow.works.map((work, index) => ({ workId: work.id, decision: ['claim', 'exclude', 'unsure'][index % 3] })) }); } };
  }
  return { dataDir, client, async restart() { await stop(); await start(); } };
}

test('session, origin, CSRF and flowId prevent cross-session and stale-request mutations; materials server-owned', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  assert.equal((await a.start()).status, 401);
  const session = await a.init(); assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await a.request('/start', { mode: 'demo' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.request('/start', { mode: 'demo' }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const started = await a.start(); assert.equal(started.status, 200); assert.equal(started.result.flow.author.fictional, true);
  await b.init(); assert.equal((await b.request('/selection', { flowId: a.flowId, decisions: [] })).status, 409);
  assert.equal((await a.request('/finalize', {})).status, 409);
  assert.equal((await a.request('/selection', { decisions: [{ workId: 'injected-work', decision: 'claim' }] })).status, 400);
  const id = a.flowId; await a.request('/reset', {}); await a.start();
  assert.equal((await a.request('/selection', { flowId: id, decisions: [] })).status, 409);
  assert.equal((await a.request('/certificate')).status, 404);
  assert.deepEqual((await readdir(f.dataDir)).sort(), ['claim-certificates', 'claim-sessions']); // GET session never starts the EVM.
});

test('preview OTP is demo-only, expires, locks after five failures and is single-use', async t => {
  let time = Date.now(); const f = await fixture(t, { now: () => time }), a = f.client();
  await a.init(); const { flow } = (await a.start()).result; await a.select(flow);
  let sent = await a.request('/email/send', { email: 'demo@example.org', delivery: 'preview' });
  assert.equal(sent.status, 200); assert.match(sent.result.demoCode, /^\d{6}$/); assert.equal(sent.result.flow.email.verified, false);
  assert.equal((await a.request('/email/send', { email: 'demo@example.org', delivery: 'preview' })).status, 429);
  const wrong = sent.result.demoCode === '000000' ? '111111' : '000000';
  for (let n = 0; n < 5; n++) assert.equal((await a.request('/email/verify', { code: wrong })).status, 400);
  assert.equal((await a.request('/email/verify', { code: sent.result.demoCode })).status, 400);
  time += 61000; sent = await a.request('/email/send', { email: 'demo@example.org', delivery: 'preview' });
  time += 600001; assert.equal((await a.request('/email/verify', { code: sent.result.demoCode })).status, 400);
  sent = await a.request('/email/send', { email: 'demo@example.org', delivery: 'preview' });
  const verified = await a.request('/email/verify', { code: sent.result.demoCode });
  assert.equal(verified.status, 200); assert.equal(verified.result.flow.email.verified, false); assert.equal(verified.result.flow.email.previewConfirmed, true);
  assert.equal((await a.request('/email/verify', { code: sent.result.demoCode })).status, 400);
  await a.select(flow); assert.equal((await a.request('/finalize', {})).status, 409);
});

test('public claims fetch authoritative OpenAlex works; SMTP codes never returned, delivery errors sanitized', async t => {
  let delivered, time = Date.now();
  const credentials = () => ({ OPENALEX_API_KEY: 'private-oa-key', SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_FROM: 'no-reply@example.org', SMTP_USER: 'private-user', SMTP_PASS: 'private-password', SMTP_SECURE: 'true' });
  const f = await fixture(t, { now: () => time, credentials, sendMail: async data => {
    delivered = data;
    const [name] = await readdir(path.join(f.dataDir, 'claim-sessions'));
    const saved = JSON.parse(await readFile(path.join(f.dataDir, 'claim-sessions', name), 'utf8'));
    assert.equal(saved.flow.email.challenge, createHash('sha256').update(`${saved.flow.email.salt}:${data.code}`).digest('hex'), 'challenge must be durable before SMTP delivers the code');
  }, fetchImpl: async url => {
    assert.equal(url.hostname, 'api.openalex.org');
    return { ok: true, json: async () => url.pathname.startsWith('/authors/')
      ? { id: 'https://openalex.org/A123', display_name: 'Actual name', last_known_institutions: [{ display_name: 'Actual institution' }] }
      : { results: [{ id: 'https://openalex.org/W99', display_name: 'Server-owned work', publication_year: 2025 }] } };
  } });
  const a = f.client(); await a.init(); const started = await a.request('/start', { mode: 'public', authorId: 'A123', score: 100, works: [{ id: 'forged' }] });
  assert.equal(started.status, 200); assert.equal(started.result.flow.works[0].id, 'W99'); assert.equal(started.result.flow.author.name, 'Actual name');
  await a.select(started.result.flow);
  assert.equal((await a.request('/email/send', { email: 'owner@example.org', delivery: 'preview' })).status, 400);
  const sent = await a.request('/email/send', { email: 'owner@example.org', delivery: 'smtp' });
  assert.equal(sent.status, 200); assert.equal(sent.result.demoCode, undefined); assert.equal(JSON.stringify(sent.result).includes(delivered.code), false);
  const verified = await a.request('/email/verify', { code: delivered.code }); assert.equal(verified.result.flow.email.verified, true);
  assert.match(verified.result.flow.email.scope, /不代表作者身份/);
  const failed = await fixture(t, { credentials, sendMail: async () => { throw new Error('private-password secret SMTP host'); } });
  const b = failed.client(); await b.init(); const startedB = await b.start(); await b.select(startedB.result.flow);
  const failure = await b.request('/email/send', { email: 'demo@example.org', delivery: 'smtp' }); assert.equal(failure.status, 502); assert.ok(!JSON.stringify(failure.result).includes('private-password'));
});

test('actual local EVM certificate grows a block, is idempotent, rejects tampering and verifies after restart', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = f.client(); await a.init(); const started = await a.start(); await a.select(started.result.flow);
  const before = (await a.request('/chain')).result; assert.equal(before.chainId, 1337); assert.equal(before.mode, 'local');
  const sent = await a.request('/email/send', { email: 'demo@example.org', delivery: 'preview' });
  await a.request('/email/verify', { code: sent.result.demoCode });
  const final = await a.request('/finalize', {}); assert.equal(final.status, 200, JSON.stringify(final.result));
  const certificate = final.result.certificate;
  assert.equal(certificate.receipt.blockNumber, before.blockNumber + 1);
  assert.equal(certificate.payload.emailVerification.verified, false);
  assert.equal(certificate.payload.assessment.score, 67);
  assert.equal(certificate.hash, certificateHash(certificate.payload));
  assert.match(certificate.payload.emailVerification.commitment, /^0x[a-f0-9]{64}$/);
  assert.equal(certificate.receipt.contentHash, certificate.hash);
  const retries = await Promise.all([a.request('/finalize', {}), a.request('/finalize', {})]);
  for (const retry of retries) assert.equal(retry.result.certificate.receipt.transactionHash, certificate.receipt.transactionHash);
  assert.equal((await a.request('/chain')).result.blockNumber, before.blockNumber + 1);
  const verifiedCertificate = (await a.request('/certificate/verify', { certificate })).result;
  assert.equal(verifiedCertificate.valid, true);
  assert.equal(verifiedCertificate.issuedByThisService, true);
  const tampered = structuredClone(certificate); tampered.payload.author.name = 'Forged name';
  assert.equal((await a.request('/certificate/verify', { certificate: tampered })).result.valid, false);
  tampered.hash = certificateHash(tampered.payload);
  const forged = (await a.request('/certificate/verify', { certificate: tampered })).result; assert.equal(forged.hashMatches, true); assert.equal(forged.chainMatches, false);
  const tamperedReceipt = structuredClone(certificate); tamperedReceipt.receipt.contentHash = '0x' + '0'.repeat(64);
  assert.equal((await a.request('/certificate/verify', { certificate: tamperedReceipt })).result.valid, false);
  tamperedReceipt.receipt = { ...certificate.receipt, label: '主网认证' };
  assert.equal((await a.request('/certificate/verify', { certificate: tamperedReceipt })).result.valid, false);
  const file = JSON.parse(await readFile(path.join(f.dataDir, 'claim-certificates', `${certificate.payload.id}.json`), 'utf8'));
  assert.deepEqual(file, certificate); assert.equal((await a.request('/certificate')).result.hash, certificate.hash);
  const b = f.client(); await b.init(); assert.equal((await b.request('/certificate')).status, 404);
  await f.restart(); await b.init(); assert.equal((await b.request('/certificate/verify', { certificate })).result.valid, true);
  assert.equal((await b.request('/chain')).result.blockNumber, before.blockNumber + 1);
  const restored = await a.init(); assert.equal(restored.result.flow.certificate.hash, certificate.hash);
  assert.equal((await a.request('/certificate')).result.hash, certificate.hash);
  assert.equal((await a.request('/finalize', {})).result.certificate.receipt.transactionHash, certificate.receipt.transactionHash);
});

test('refresh and server restart restore selections, OTP cooldown and failed-attempt lockout without storing raw email or OTP', async t => {
  let time = Date.now(); const f = await fixture(t, { now: () => time }), a = f.client();
  await a.init(); const started = await a.start(); await a.select(started.result.flow);
  const sent = await a.request('/email/send', { email: 'private-owner@example.org', delivery: 'preview' });
  assert.equal(sent.result.flow.email.retryAfter, 60);
  assert.equal(sent.result.flow.email.challengeActive, true);
  const wrong = sent.result.demoCode === '000000' ? '111111' : '000000';
  for (let n = 0; n < 4; n++) assert.equal((await a.request('/email/verify', { code: wrong })).status, 400);
  const [file] = await readdir(path.join(f.dataDir, 'claim-sessions'));
  const savedText = await readFile(path.join(f.dataDir, 'claim-sessions', file), 'utf8');
  assert.equal(savedText.includes('private-owner@example.org'), false);
  const saved = JSON.parse(savedText);
  assert.equal(saved.flow.email.code, undefined);
  assert.equal(saved.flow.email.attempts, 4);
  time += 10000; await f.restart();
  const restored = (await a.init()).result;
  assert.equal(restored.flow.id, started.result.flow.id);
  assert.equal(restored.flow.decisions.length, 3);
  assert.equal(restored.flow.email.retryAfter, 50);
  assert.equal(restored.flow.email.expiresIn, 590);
  assert.equal((await a.request('/email/verify', { code: wrong })).status, 400);
  await f.restart(); await a.init();
  assert.equal((await a.request('/email/verify', { code: sent.result.demoCode })).status, 400);
  assert.equal((await a.init()).result.flow.email.challengeActive, false);
  time += 6 * 3600000;
  assert.equal((await a.init()).result.flow, null);
});

test('an uncertain chain response survives restart and retries the exact persisted payload instead of minting a second record', async t => {
  let time = Date.now(), f, loseResponse = true;
  const records = new Map();
  const ledger = {
    async status() { return { mode: 'local', chainId: 1337, blockNumber: records.size }; },
    async record({ contentHash }) {
      const [name] = await readdir(path.join(f.dataDir, 'claim-sessions'));
      const saved = JSON.parse(await readFile(path.join(f.dataDir, 'claim-sessions', name), 'utf8'));
      assert.equal(certificateHash(saved.flow.pendingPayload), contentHash, 'payload must be durable before issuing transaction');
      if (!records.has(contentHash)) records.set(contentHash, { mode: 'local', chainId: 1337, transactionHash: `0x${'a'.repeat(64)}`, contentHash, blockNumber: 1 });
      if (loseResponse) { loseResponse = false; throw new Error('Connection lost after chain accepted the transaction'); }
      return records.get(contentHash);
    }, async close() {},
  };
  f = await fixture(t, { ledger, now: () => time }); const a = f.client(); await a.init();
  const started = await a.start(); await a.select(started.result.flow);
  const sent = await a.request('/email/send', { email: 'demo@example.org', delivery: 'preview' });
  await a.request('/email/verify', { code: sent.result.demoCode });
  assert.equal((await a.request('/finalize', {})).status, 500);
  assert.equal(records.size, 1);
  time += 120000; await f.restart();
  assert.equal((await a.init()).result.flow.finalizing, true);
  assert.equal((await a.select(started.result.flow)).status, 409);
  const retried = await a.request('/finalize', {});
  assert.equal(retried.status, 200);
  assert.equal(retried.result.certificate.hash, [...records.keys()][0]);
  assert.equal(records.size, 1);
});

test('public wallet anchoring binds verified materials to one wallet, persists pending transactions and confirms idempotently', async t => {
  const walletAddress = `0x${'1'.repeat(40)}`, transactionHash = `0x${'b'.repeat(64)}`;
  let delivered, pending = true, prepared = 0, confirmed = 0;
  const config = { available: true, mode: 'mainnet', chainId: 677, label: 'BOT Chain 主网', contractAddress: `0x${'2'.repeat(40)}` };
  const publicLedger = {
    config: () => config,
    async prepare(binding) { prepared++; return { ...config, ...binding, transaction: { from: binding.walletAddress, to: config.contractAddress, data: '0x1234', value: '0x0', chainId: '0x2a5' } }; },
    async confirm(binding) {
      confirmed++;
      if (pending) return { pending: true, transactionHash: binding.transactionHash };
      return { ...config, network: 'BOT Chain mainnet', walletAddress: binding.walletAddress, subjectHash: binding.subjectHash,
        transactionHash: binding.transactionHash, contentHash: binding.contentHash, blockNumber: 42, blockHash: `0x${'c'.repeat(64)}` };
    },
    async verify(receipt, hash) { return receipt.transactionHash === transactionHash && receipt.contentHash === hash; },
  };
  const f = await fixture(t, {
    publicLedger,
    credentials: () => ({ SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_FROM: 'no-reply@example.org', SMTP_USER: 'user', SMTP_PASS: 'password', SMTP_SECURE: 'true' }),
    sendMail: async data => { delivered = data; },
    fetchImpl: async url => ({ ok: true, json: async () => url.pathname.startsWith('/authors/')
      ? { id: 'https://openalex.org/A123', display_name: 'Public author' }
      : { results: [{ id: 'https://openalex.org/W99', display_name: 'Public paper', publication_year: 2025 }] } }),
  });
  const a = f.client(); assert.equal((await a.init()).result.publicChain.chainId, 677);
  let started = await a.start(); await a.select(started.result.flow);
  assert.equal((await a.request('/prepare-anchor', { acknowledged: true, walletAddress })).status, 409, 'demo cannot write a public claim');
  started = await a.start('public', 'A123'); await a.select(started.result.flow);
  assert.equal((await a.request('/prepare-anchor', { acknowledged: true, walletAddress })).status, 409, 'public claim needs real mailbox verification');
  await a.request('/email/send', { email: 'owner@example.org', delivery: 'smtp' });
  await a.request('/email/verify', { code: delivered.code });
  assert.equal((await a.request('/prepare-anchor', { walletAddress })).status, 400);
  assert.equal((await a.request('/prepare-anchor', { acknowledged: true, walletAddress: `0x${'0'.repeat(40)}` })).status, 400);
  assert.equal((await a.init()).result.flow.finalizing, false, 'invalid wallet must not freeze the verified materials');
  const preparedResult = await a.request('/prepare-anchor', { acknowledged: true, walletAddress });
  assert.equal(preparedResult.status, 200);
  assert.equal(preparedResult.result.anchor.transaction.from, walletAddress);
  const hash = preparedResult.result.flow.mainnetAnchor.contentHash;
  assert.equal((await a.request('/prepare-anchor', { acknowledged: true, walletAddress })).result.anchor.contentHash, hash);
  assert.equal(prepared, 1);
  assert.equal((await a.request('/prepare-anchor', { acknowledged: true, walletAddress: `0x${'3'.repeat(40)}` })).status, 409);
  assert.equal((await a.select(started.result.flow)).status, 409);
  assert.equal((await a.request('/finalize', {})).status, 409);
  const waiting = await a.request('/confirm-anchor', { transactionHash });
  assert.equal(waiting.status, 200); assert.equal(waiting.result.pending, true);
  await f.restart();
  const restored = (await a.init()).result;
  assert.equal(restored.flow.mainnetAnchor.transactionHash, transactionHash);
  assert.equal(restored.flow.mainnetAnchor.contentHash, hash);
  pending = false;
  const result = await a.request('/confirm-anchor', { transactionHash });
  assert.equal(result.status, 200);
  const certificate = result.result.certificate;
  assert.equal(certificate.hash, hash);
  assert.equal(certificate.payload.anchor.walletAddress, walletAddress);
  assert.equal(certificate.receipt.mode, 'mainnet');
  assert.equal(certificate.payload.emailVerification.verified, true);
  assert.equal((await a.request('/confirm-anchor', { transactionHash })).result.certificate.hash, hash);
  assert.equal(confirmed, 2);
  const verifiedCertificate = (await a.request('/certificate/verify', { certificate })).result;
  assert.equal(verifiedCertificate.valid, true);
  assert.equal(verifiedCertificate.issuedByThisService, true);
  const tampered = structuredClone(certificate); tampered.receipt.walletAddress = `0x${'4'.repeat(40)}`;
  const rejected = (await a.request('/certificate/verify', { certificate: tampered })).result;
  assert.equal(rejected.valid, false);
  assert.equal(rejected.issuedByThisService, false);
  const unissued = structuredClone(certificate);
  unissued.payload.id = 'e'.repeat(32);
  unissued.hash = certificateHash(unissued.payload);
  unissued.receipt.contentHash = unissued.hash;
  unissued.issuedByThisService = true; // A client-supplied flag cannot establish service issuance.
  const external = (await a.request('/certificate/verify', { certificate: unissued })).result;
  assert.equal(external.valid, true, 'a matching chain record keeps the existing content-integrity meaning');
  assert.equal(external.issuedByThisService, false);
  assert.match(external.notice, /没有匹配的签发档案/);
  assert.equal((await readdir(f.dataDir)).includes('claim-local-chain'), false, 'wallet path never starts local EVM');
});
