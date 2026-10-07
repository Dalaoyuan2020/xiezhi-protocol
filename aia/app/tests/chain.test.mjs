import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface, Wallet, id, encodeBytes32String, ZeroHash } from 'ethers';
import { getChainConfig, createWalletChallenge, verifyWalletSignature, buildRecordTransaction, verifyRecordTransaction } from '../lib/chain.mjs';

const artifact = JSON.parse(await readFile(new URL('../../chain/artifacts/ActionRegistry.json', import.meta.url), 'utf8'));
const abi = new Interface(artifact.abi);
const address = '0x1111111111111111111111111111111111111111';
const wallet = '0x2222222222222222222222222222222222222222';
const otherWallet = '0x3333333333333333333333333333333333333333';
const txHash = id('unit-test-transaction');
const blockHash = id('unit-test-canonical-block');
const contentHash = 'a'.repeat(64);
const args = { network: 'testnet', wallet, userId: 'user-unit-1', kind: 'SUBMIT', contentHash };
const deployment = { chainId: 968, address, block: 100 };
const readFixture = async path => {
  if (String(path).endsWith('ActionRegistry.json')) return JSON.stringify(artifact);
  if (String(path).endsWith('botchain-testnet.json')) return JSON.stringify(deployment);
  throw Object.assign(new Error('not deployed'), { code: 'ENOENT' });
};
const deps = { readFile: readFixture };
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('network config is explicit, public and unavailable deployments never fall back across networks', async () => {
  const configured = await getChainConfig('testnet', deps);
  assert.equal(configured.available, true);
  assert.equal(configured.chainId, 968);
  assert.equal(configured.chainIdHex, '0x3c8');
  assert.equal(configured.rpcUrl, 'https://rpc.bohr.life');
  assert.equal(configured.explorerUrl, 'https://scan.bohr.life');
  assert.equal(configured.addEthereumChain.nativeCurrency.symbol, 'BOT');
  const missing = await getChainConfig('mainnet', deps);
  assert.equal(missing.available, false);
  assert.equal(missing.chainId, 677);
  assert.equal(missing.address, null);
  await rejectsCode(getChainConfig('evil', deps), 'INVALID_NETWORK');
  const invalid = await getChainConfig('testnet', { readFile: async path => String(path).endsWith('ActionRegistry.json') ? JSON.stringify(artifact) : JSON.stringify({ ...deployment, chainId: 677 }) });
  assert.equal(invalid.available, false);
});

test('wallet challenge binds account, origin/domain, wallet, nonce, id and time to actual EIP-191 signature', async () => {
  const signer = Wallet.createRandom();
  const now = Date.parse('2026-10-07T00:00:00Z');
  const challenge = createWalletChallenge({ userId: args.userId, address: signer.address, origin: 'http://127.0.0.1:8879' }, { now: () => now });
  assert.equal(challenge.domain, '127.0.0.1:8879');
  assert.equal(challenge.nonce.length, 64);
  assert.equal(Date.parse(challenge.expiresAt) - now, 300000);
  const signature = await signer.signMessage(challenge.message);
  const verified = verifyWalletSignature({ challenge, signature, userId: args.userId, address: signer.address, origin: challenge.origin }, { now: () => now + 1000 });
  assert.equal(verified.valid, true);
  assert.equal(verified.challengeId, challenge.id);
  assert.equal(verified.address, signer.address);
  for (const wrong of [{ userId: 'user-other' }, { origin: 'https://another.example' }, { address: otherWallet }]) {
    assert.throws(() => verifyWalletSignature({ challenge, signature, ...wrong }, { now: () => now + 1000 }), error => error.code === 'CHALLENGE_CONTEXT_MISMATCH');
  }
  assert.throws(() => verifyWalletSignature({ challenge, signature }, { now: () => now + 300000 }), error => error.code === 'CHALLENGE_EXPIRED');
  assert.throws(() => verifyWalletSignature({ challenge: { ...challenge, nonce: 'x'.repeat(64) }, signature }, { now: () => now }), error => error.code === 'CHALLENGE_CONTEXT_MISMATCH');
  const next = createWalletChallenge({ userId: args.userId, address: signer.address, origin: challenge.origin }, { now: () => now });
  assert.notEqual(next.id, challenge.id);
  assert.notEqual(next.nonce, challenge.nonce);
  assert.throws(() => verifyWalletSignature({ challenge: next, signature }, { now: () => now }), error => error.code === 'SIGNER_MISMATCH');
});

test('foreign-wallet signatures and arbitrary signing text are rejected', async () => {
  const signer = Wallet.createRandom();
  const challenge = createWalletChallenge({ userId: args.userId, address: wallet, origin: 'https://app.example' });
  const signature = await signer.signMessage(challenge.message);
  assert.throws(() => verifyWalletSignature({ challenge, signature }), error => error.code === 'SIGNER_MISMATCH');
  assert.throws(() => verifyWalletSignature({ message: 'approve spending', signature, address: signer.address }), error => error.code === 'INVALID_CHALLENGE');
  assert.throws(() => createWalletChallenge({ userId: args.userId, address: wallet, origin: 'https://user:secret@app.example' }), error => error.code === 'INVALID_ORIGIN');
});

test('transaction preparation binds app user, actual SHA-256 digest and rule without sending value', async () => {
  const prepared = await buildRecordTransaction(args, deps);
  assert.equal(prepared.transaction.value, '0x0');
  assert.equal(prepared.transaction.from, wallet);
  assert.equal(prepared.transaction.to, address);
  assert.equal(prepared.record.subject, id('aia-user:user-unit-1'));
  assert.equal(prepared.record.contentHash, '0x' + contentHash);
  const parsed = abi.parseTransaction({ data: prepared.transaction.data });
  assert.equal(parsed.name, 'record');
  assert.equal(parsed.args[0], id('aia-user:user-unit-1'));
  assert.equal(parsed.args[1], encodeBytes32String('SUBMIT'));
  assert.equal(parsed.args[2], '0x' + contentHash);
  assert.equal(parsed.args[3], ZeroHash);
  assert.equal(parsed.args[4], encodeBytes32String('aia-v1-sha256'));
  assert.equal(parsed.args[5], 0n);
  await rejectsCode(buildRecordTransaction({ ...args, kind: 'SCORE' }, deps), 'INVALID_RECORD_KIND');
  await rejectsCode(buildRecordTransaction({ ...args, contentHash: 'not-a-hash' }, deps), 'INVALID_CONTENT_HASH');
  await rejectsCode(buildRecordTransaction({ ...args, rule: 'checkup-v0' }, deps), 'INVALID_RULE');
  await rejectsCode(buildRecordTransaction({ ...args, network: 'mainnet' }, deps), 'DEPLOYMENT_UNAVAILABLE');
});

async function rpcFixture() {
  const prepared = await buildRecordTransaction(args, deps);
  const event = abi.encodeEventLog(abi.getEvent('Recorded'), [99n, prepared.record.subject, prepared.record.kindHash, prepared.record.contentHash, ZeroHash, 0, wallet]);
  const tx = { hash: txHash, chainId: 968n, from: wallet, to: address, value: 0n, data: prepared.transaction.data };
  const receipt = { hash: txHash, status: 1, from: wallet, to: address, blockNumber: 110, blockHash, logs: [{ ...event, address, index: 3, transactionHash: txHash, blockHash, removed: false }] };
  const calls = [];
  const provider = {
    getNetwork: async () => { calls.push('network'); return { chainId: 968n }; },
    getTransaction: async () => { calls.push('transaction'); return tx; },
    getTransactionReceipt: async () => { calls.push('receipt'); return receipt; },
    getCode: async () => { calls.push('code'); return '0x60016002'; },
    getBlock: async () => { calls.push('block'); return { hash: blockHash }; },
    destroy: () => calls.push('destroy')
  };
  return { tx, receipt, provider, calls, dependencies: { ...deps, createProvider: () => provider } };
}

test('confirmation independently checks receipt, calldata, canonical block and exact contract event', async () => {
  const fixture = await rpcFixture();
  const result = await verifyRecordTransaction({ ...args, txHash }, fixture.dependencies);
  assert.equal(result.verified, true);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.chainId, 968);
  assert.equal(result.blockNumber, 110);
  assert.equal(result.logIndex, 3);
  assert.equal(result.actionId, '99');
  assert.equal(result.txHash, txHash);
  assert.equal(result.contentHash, '0x' + contentHash);
  assert.equal(result.explorerUrl, 'https://scan.bohr.life/tx/' + txHash);
  assert.deepEqual(fixture.calls.sort(), ['network', 'transaction', 'receipt', 'code', 'block', 'destroy'].sort());
});

test('wrong chain, sender, contract, context, content and payment value cannot become confirmed', async () => {
  const scenarios = [
    ['NETWORK_MISMATCH', f => { f.provider.getNetwork = async () => ({ chainId: 677n }); }],
    ['NETWORK_MISMATCH', f => { f.tx.chainId = 677n; }],
    ['SENDER_MISMATCH', f => { f.tx.from = otherWallet; }],
    ['CONTRACT_MISMATCH', f => { f.receipt.to = otherWallet; }],
    ['RECORD_MISMATCH', f => { f.tx.value = 1n; }],
    ['RECORD_MISMATCH', async f => { f.tx.data = (await buildRecordTransaction({ ...args, contentHash: 'b'.repeat(64) }, deps)).transaction.data; }],
    ['TRANSACTION_REVERTED', f => { f.receipt.status = 0; }],
    ['TRANSACTION_MISMATCH', f => { f.receipt.hash = id('wrong-tx'); }],
    ['CONTRACT_UNAVAILABLE', f => { f.provider.getCode = async () => '0x'; }],
    ['RECEIPT_NOT_CANONICAL', f => { f.provider.getBlock = async () => ({ hash: id('another-fork') }); }],
    ['EVENT_MISMATCH', f => { f.receipt.logs[0].address = otherWallet; }],
    ['EVENT_MISMATCH', f => { Object.assign(f.receipt.logs[0], abi.encodeEventLog(abi.getEvent('Recorded'), [99n, id('aia-user:' + args.userId), encodeBytes32String('SUBMIT'), '0x' + 'b'.repeat(64), ZeroHash, 0, wallet])); }],
    ['EVENT_MISMATCH', f => { f.receipt.logs.push({ ...f.receipt.logs[0], index: 4 }); }],
    ['INVALID_RECEIPT', f => { f.receipt.logs[0].removed = true; }]
  ];
  for (const [code, mutate] of scenarios) {
    const fixture = await rpcFixture();
    await mutate(fixture);
    await rejectsCode(verifyRecordTransaction({ ...args, txHash }, fixture.dependencies), code);
  }
  for (const changed of [{ userId: 'different-user' }, { kind: 'REVIEW' }, { contentHash: 'f'.repeat(64) }]) {
    const fixture = await rpcFixture();
    await rejectsCode(verifyRecordTransaction({ ...args, ...changed, txHash }, fixture.dependencies), 'RECORD_MISMATCH');
  }
});

test('missing, reverted and unavailable RPC states remain retryable or failed, never fabricated receipts', async () => {
  const pending = await rpcFixture(); pending.provider.getTransactionReceipt = async () => null;
  await rejectsCode(verifyRecordTransaction({ ...args, txHash }, pending.dependencies), 'TRANSACTION_PENDING');
  const offline = await rpcFixture(); offline.provider.getNetwork = async () => { throw new Error('network offline'); };
  await rejectsCode(verifyRecordTransaction({ ...args, txHash }, offline.dependencies), 'RPC_UNAVAILABLE');
  const slow = await rpcFixture(); slow.provider.getNetwork = () => new Promise(() => {});
  await rejectsCode(verifyRecordTransaction({ ...args, txHash }, { ...slow.dependencies, timeoutMs: 20 }), 'RPC_TIMEOUT');
  assert.equal(slow.calls.at(-1), 'destroy');
});
