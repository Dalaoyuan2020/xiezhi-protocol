import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet, id, encodeBytes32String } from 'ethers';
import { createApp } from '../server.mjs';
import * as chain from '../lib/chain.mjs';
import { digest } from '../lib/store.mjs';

// Local HTTP, ephemeral wallets and an in-memory RPC fixture only: no network calls or broadcasts.
const artifact = JSON.parse(await readFile(new URL('../../chain/artifacts/ActionRegistry.json', import.meta.url), 'utf8'));
const abi = new Interface(artifact.abi);
const contract = '0x1111111111111111111111111111111111111111';
const blockHash = id('local-http-test-block');
const deployment = { chainId: 968, address: contract, block: 100 };
const readFixture = async file => {
  if (String(file).endsWith('ActionRegistry.json')) return JSON.stringify(artifact);
  if (String(file).endsWith('botchain-testnet.json')) return JSON.stringify(deployment);
  throw Object.assign(new Error('not deployed in fixture'), { code: 'ENOENT' });
};
const manuscript = { title: 'Private supplied research', files: [{ path: 'paper.md', text: '# Research note\n\nThese supplied observations are limited to the documented method and recorded sample.\n' }] };
const report = { originality: 'I compared the supplied claims with the stated prior work.', methodology: 'The methods were read and no external experiment was executed.', evidence: 'I inspected the supplied materials and the explicit limitations.', limitations: 'The review does not establish reproducibility or scientific truth.', conflictOfInterest: false, verdict: 'revise' };

async function setup(t) {
  const tempRoot = await realpath(os.tmpdir());
  const dataDir = await mkdtemp(path.join(tempRoot, 'aia-chain-http-'));
  const transactions = new Map();
  const calls = { builds: [], confirmations: [] };
  const provider = {
    getNetwork: async () => ({ chainId: 968n }),
    getTransaction: async hash => transactions.get(hash)?.tx || null,
    getTransactionReceipt: async hash => transactions.get(hash)?.receipt || null,
    getCode: async () => '0x60016002',
    getBlock: async () => ({ hash: blockHash })
  };
  const adapter = {
    getChainConfig: network => chain.getChainConfig(network, { readFile: readFixture }),
    createWalletChallenge: chain.createWalletChallenge,
    verifyWalletSignature: async args => {
      // Force concurrent HTTP requests across the asynchronous signature-verifier boundary.
      await new Promise(resolve => setTimeout(resolve, 20));
      return chain.verifyWalletSignature(args);
    },
    buildRecordTransaction: async args => {
      calls.builds.push(args);
      return chain.buildRecordTransaction(args, { readFile: readFixture });
    },
    verifyRecordTransaction: async args => {
      calls.confirmations.push(args);
      await new Promise(resolve => setTimeout(resolve, 20));
      return chain.verifyRecordTransaction(args, { readFile: readFixture, provider });
    }
  };
  const app = await createApp({ dataDir, chain: adapter });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    const resolved = await realpath(dataDir);
    assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('aia-chain-http-'));
    await rm(resolved, { recursive: true, force: true });
  });
  function client() {
    let cookie = '', csrf = '';
    return { async request(route, method = 'GET', payload, headers = {}) {
      const response = await fetch(origin + route, { method, headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}), ...headers
      }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const data = await response.json();
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    } };
  }
  async function register(username) {
    const c = client();
    const result = await ok(c, '/api/auth/register', 'POST', { username, displayName: username, password: 'local test password, never deployed' });
    c.user = result.user;
    c.wallet = Wallet.createRandom();
    return c;
  }
  function addTransaction(transaction, label, mutate) {
    const hash = id('local HTTP transaction ' + label);
    const record = abi.decodeFunctionData('record', transaction.data);
    const event = abi.encodeEventLog(abi.getEvent('Recorded'), [99n, record[0], record[1], record[2], record[3], record[5], transaction.from]);
    const fixture = {
      tx: { hash, chainId: 968n, from: transaction.from, to: transaction.to, value: 0n, data: transaction.data },
      receipt: { hash, status: 1, from: transaction.from, to: transaction.to, blockNumber: 110, blockHash,
        logs: [{ ...event, address: contract, index: 3, transactionHash: hash, blockHash, removed: false }] }
    };
    if (mutate) mutate(fixture);
    transactions.set(hash, fixture);
    return hash;
  }
  return { app, register, client, calls, addTransaction, transactions };
}
async function ok(c, route, method = 'GET', payload) {
  const result = await c.request(route, method, payload);
  assert.equal(result.status, 200, `${route}: ${result.data.error || 'request failed'}`);
  return result.data;
}
async function signedChallenge(c, wallet = c.wallet) {
  const challenge = await ok(c, '/api/wallet/challenge', 'POST', { address: wallet.address });
  return { challengeId: challenge.id, signature: await wallet.signMessage(challenge.message) };
}
async function link(c) { return ok(c, '/api/wallet/verify', 'POST', await signedChallenge(c)); }
async function prepare(c, recordType, recordId, extra = {}) {
  return ok(c, '/api/attestations/prepare', 'POST', { network: 'testnet', recordType, recordId, ...extra });
}

test('wallet HTTP challenge belongs to one authenticated account and is consumed once even concurrently', async t => {
  const env = await setup(t);
  const a = await env.register('wallet-owner'), b = await env.register('wallet-other');
  assert.equal((await env.client().request('/api/wallet/challenge', 'POST', { address: a.wallet.address })).status, 401);
  assert.equal((await a.request('/api/wallet/challenge', 'POST', { address: a.wallet.address }, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await a.request('/api/wallet/challenge', 'POST', { address: a.wallet.address }, { 'X-CSRF-Token': 'forged' })).status, 403);
  const profile = await ok(a, '/api/profile', 'PUT', { displayName: 'Wallet owner', walletVerified: true, walletAddress: a.wallet.address, identityStatus: 'verified' });
  assert.equal(profile.user.profile.walletVerified, false);
  assert.equal(profile.user.profile.walletAddress, null);
  assert.equal(profile.user.profile.identityStatus, 'user-declared');
  const signed = await signedChallenge(a);
  assert.equal((await b.request('/api/wallet/verify', 'POST', signed)).status, 409);
  const attempts = await Promise.all([a.request('/api/wallet/verify', 'POST', signed), a.request('/api/wallet/verify', 'POST', signed)]);
  assert.deepEqual(attempts.map(v => v.status).sort(), [200, 409]);
  assert.equal((await a.request('/api/wallet/verify', 'POST', signed)).status, 409);
  const account = (await ok(a, '/api/session')).user;
  assert.equal(account.profile.walletAddress, a.wallet.address);
  assert.equal(account.profile.walletVerified, true);
  assert.equal(account.profile.identityStatus, 'user-declared');
  assert.equal((await b.request('/api/wallet/verify', 'POST', await signedChallenge(b, a.wallet))).status, 409);
  assert.equal((await ok(b, '/api/session')).user.profile.walletAddress, null);
  const consumed = env.app.store.one('SELECT consumed_at FROM wallet_challenges WHERE id=?', signed.challengeId);
  assert.ok(consumed.consumed_at);
});

test('HTTP preparation binds the server-owned research version, submitted review and accepted contribution', async t => {
  const env = await setup(t);
  const a = await env.register('research-author'), b = await env.register('research-worker'), c = await env.register('research-verifier');
  await link(a); await link(b); await link(c);
  const research = (await ok(a, '/api/research/import', 'POST', manuscript)).research;
  const submission = await prepare(a, 'research', research.id, { userId: b.user.id, wallet: b.wallet.address, contentHash: 'f'.repeat(64), kind: 'CLAIM' });
  const decoded = abi.decodeFunctionData('record', submission.transaction.data);
  assert.equal(submission.transaction.from, a.wallet.address);
  assert.equal(decoded[0], id('aia-user:' + a.user.id));
  assert.equal(decoded[1], encodeBytes32String('SUBMIT'));
  assert.equal(decoded[2], '0x' + research.rootHash);
  assert.equal(submission.attestation.contentHash, research.rootHash);
  assert.equal(submission.transaction.value, '0x0');
  assert.equal((await b.request('/api/attestations/prepare', 'POST', { network: 'testnet', recordType: 'research', recordId: research.id })).status, 403);
  const review = (await ok(a, `/api/research/${research.id}/review-requests`, 'POST', { reviewerId: b.user.id, focus: 'Examine the supplied evidence' })).review;
  assert.equal((await b.request('/api/attestations/prepare', 'POST', { network: 'testnet', recordType: 'review', recordId: review.id })).status, 403);
  const submitted = (await ok(b, `/api/reviews/${review.id}/submit`, 'POST', report)).review;
  const reviewPreparation = await prepare(b, 'review', review.id);
  assert.equal(reviewPreparation.attestation.contentHash, digest(submitted));
  assert.equal(abi.decodeFunctionData('record', reviewPreparation.transaction.data)[1], encodeBytes32String('REVIEW'));
  assert.equal((await a.request('/api/attestations/prepare', 'POST', { network: 'testnet', recordType: 'review', recordId: review.id })).status, 403);
  const task = (await ok(a, '/api/tasks', 'POST', { researchId: research.id, title: 'Check documented observations', kind: 'reproduction', requirements: 'Submit actual output and an explanation of differences.', acceptanceCriteria: 'Independent verifier inspects the supplied output and explanation.', executorId: b.user.id, verifierId: c.user.id })).task;
  await ok(b, `/api/tasks/${task.id}/claim`, 'POST', {});
  const delivery = (await ok(b, `/api/tasks/${task.id}/deliver`, 'POST', { summary: 'Local test work record reporting a reproducible difference.', environment: 'Explicitly documented external execution environment', commands: 'Submitter-declared external steps', outcome: 'differs', files: [{ path: 'results.txt', text: 'Observed difference and investigation evidence.\n' }] })).delivery;
  const acceptance = await ok(c, `/api/tasks/${task.id}/verify`, 'POST', { deliveryId: delivery.id, decision: 'accept', finding: 'differs', note: 'I inspected the delivered output and its explanation of differences.', checkedFiles: ['results.txt'] });
  const contribution = await prepare(b, 'contribution', acceptance.contribution.id);
  assert.equal(contribution.attestation.contentHash, acceptance.contribution.receiptHash);
  assert.equal(abi.decodeFunctionData('record', contribution.transaction.data)[1], encodeBytes32String('REPRODUCE'));
  assert.equal((await c.request('/api/attestations/prepare', 'POST', { network: 'testnet', recordType: 'contribution', recordId: acceptance.contribution.id })).status, 403);
  const mine = (await ok(a, '/api/attestations')).attestations;
  assert.deepEqual(mine.map(v => v.id), [submission.attestation.id]);
  assert.equal((await ok(c, '/api/export')).attestations.length, 0);
});

test('profile CLAIM hashes a fixed self-declared snapshot and cannot attest another account', async t => {
  const env = await setup(t);
  const a = await env.register('profile-owner'), b = await env.register('profile-other');
  await link(a); await link(b);
  assert.equal((await a.request('/api/attestations/prepare', 'POST', { network: 'testnet', recordType: 'profile', recordId: a.user.id })).status, 409);
  await ok(a, '/api/profile', 'PUT', { displayName: 'Original profile', institution: 'User supplied institution', openalexId: 'A5126602136', bio: 'This text is not part of the chain identity statement.' });
  const prepared = await prepare(a, 'profile', a.user.id, { contentHash: '0'.repeat(64), identityStatus: 'certified', kind: 'SCORE' });
  const snapshot = prepared.attestation.profileStatement;
  assert.equal(snapshot.id, a.user.id);
  assert.equal(snapshot.openalexId, 'A5126602136');
  assert.equal(snapshot.walletAddress, a.wallet.address);
  assert.equal(snapshot.identityStatus, 'user-declared');
  assert.equal(Object.hasOwn(snapshot, 'bio'), false);
  assert.equal(prepared.attestation.contentHash, digest(snapshot));
  const record = abi.decodeFunctionData('record', prepared.transaction.data);
  assert.equal(record[0], id('aia-user:' + a.user.id));
  assert.equal(record[1], encodeBytes32String('CLAIM'));
  assert.equal(record[2], '0x' + digest(snapshot));
  assert.equal((await b.request('/api/attestations/prepare', 'POST', { network: 'testnet', recordType: 'profile', recordId: a.user.id })).status, 403);
  await ok(a, '/api/profile', 'PUT', { displayName: 'Changed profile', openalexId: 'A5126602136' });
  const txHash = env.addTransaction(prepared.transaction, 'profile-snapshot');
  const confirmed = (await ok(a, `/api/attestations/${prepared.attestation.id}/confirm`, 'POST', { txHash })).attestation;
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.profileStatement.displayName, 'Original profile');
  assert.equal(confirmed.profileStatement.identityStatus, 'user-declared');
  assert.equal(confirmed.contentHash, '0x' + digest(snapshot));
  assert.equal((await ok(a, '/api/session')).user.profile.identityStatus, 'user-declared');
  assert.equal(env.app.store.one('SELECT count(*) AS count FROM events').count, 0, 'profile confirmation does not create an event with a fabricated research id');
});

test('real ABI receipt verification over HTTP persists pending hashes, retries, confirms once and blocks replay', async t => {
  const env = await setup(t);
  const a = await env.register('receipt-owner'), b = await env.register('receipt-other');
  await link(a); await link(b);
  const research = (await ok(a, '/api/research/import', 'POST', manuscript)).research;
  const first = await prepare(a, 'research', research.id);
  const second = await prepare(a, 'research', research.id);
  const route = `/api/attestations/${first.attestation.id}/confirm`;
  const hash = id('local HTTP transaction eventually-mined');
  const pending = await a.request(route, 'POST', { txHash: hash });
  assert.equal(pending.status, 409);
  assert.equal(pending.data.code, 'TRANSACTION_PENDING');
  const pendingRecord = (await ok(a, '/api/attestations')).attestations.find(v => v.id === first.attestation.id);
  assert.equal(pendingRecord.status, 'pending');
  assert.equal(pendingRecord.txHash, hash);
  assert.ok(pendingRecord.submittedAt);
  assert.equal((await b.request(route, 'POST', { txHash: hash })).status, 404);
  assert.equal(env.addTransaction(first.transaction, 'eventually-mined'), hash);
  const confirmations = await Promise.all([a.request(route, 'POST', { txHash: hash }), a.request(route, 'POST', { txHash: hash })]);
  assert.deepEqual(confirmations.map(v => v.status), [200, 200]);
  assert.deepEqual(confirmations[0].data, confirmations[1].data);
  const receipt = confirmations[0].data.attestation;
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.chainId, 968);
  assert.equal(receipt.blockNumber, 110);
  assert.equal(receipt.logIndex, 3);
  assert.equal(receipt.actionId, '99');
  assert.equal(receipt.explorerUrl, 'https://scan.bohr.life/tx/' + hash);
  assert.equal(receipt.contentHash, '0x' + research.rootHash);
  const count = env.calls.confirmations.length;
  assert.equal((await a.request(route, 'POST', { txHash: hash })).status, 200);
  assert.equal(env.calls.confirmations.length, count, 'already confirmed same hash does not repeat RPC');
  assert.equal((await a.request(route, 'POST', { txHash: id('different-transaction') })).status, 409);
  const replay = await a.request(`/api/attestations/${second.attestation.id}/confirm`, 'POST', { txHash: hash });
  assert.equal(replay.status, 409);
  const replayRecord = (await ok(a, '/api/attestations')).attestations.find(v => v.id === second.attestation.id);
  assert.equal(replayRecord.status, 'verification_failed');
  assert.ok(replayRecord.lastError, 'a known duplicate must not remain pending without an explanation');
  assert.notEqual(replayRecord.verified, true);
  const events = env.app.store.all("SELECT data FROM events WHERE json_extract(data,'$.action')='chain-attestation-confirmed'");
  assert.equal(events.length, 1, 'only one successful chain confirmation enters the research event stream');
  const third = await prepare(a, 'research', research.id);
  const forged = env.addTransaction(third.transaction, 'wrong-wallet', fixture => { fixture.tx.from = b.wallet.address; });
  const rejected = await a.request(`/api/attestations/${third.attestation.id}/confirm`, 'POST', { txHash: forged });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.code, 'SENDER_MISMATCH');
  const failed = (await ok(a, '/api/attestations')).attestations.find(v => v.id === third.attestation.id);
  assert.equal(failed.status, 'verification_failed');
  assert.notEqual(failed.verified, true);
  assert.equal(env.app.store.one('SELECT count(*) AS count FROM attestations WHERE tx_hash IS NOT NULL').count, 1);
});
