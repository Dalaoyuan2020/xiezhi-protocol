import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped functions, not a second implementation. Wallet requests never leave this VM.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'wallet source boundaries must still exist');
  return source.slice(start, end);
}
const sourceUnderTest = section('  function invalidateWalletContext()', '  function showProof(')
  + section('  async function sendAttestation()', '  function renderPendingAttestation(');
const address = '0x2222222222222222222222222222222222222222';
const otherAddress = '0x3333333333333333333333333333333333333333';
const txHash = '0x' + 'ab'.repeat(32);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(options = {}) {
  const requests = [], confirmations = [], pendingViews = [], proofs = [], cache = new Map();
  const prepared = { attestation: { id: 'attestation-test' }, transaction: { from: address, to: '0x1111111111111111111111111111111111111111', data: '0x1234', value: '0x0' }, network: { key: 'testnet', chainId: 968, chainIdHex: '0x3c8', addEthereumChain: { chainId: '0x3c8', chainName: 'Test fixture' } } };
  const context = {
    user: { id: 'user-original' }, walletEpoch: 0, walletOperation: null, renderToken: 1,
    location: { hash: '#profile' }, pendingAttestation: prepared,
    dialog: { open: true, close() { this.open = false; } },
    document: { getElementById: () => null },
    q: encodeURIComponent,
    localStorage: { setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    renderPendingAttestation: (record, message) => pendingViews.push({ record, message }),
    showProof: (title, record) => proofs.push({ title, record }),
    api: async (route, args) => {
      confirmations.push({ route, args });
      if (options.apiError) throw options.apiError;
      return { attestation: { id: 'attestation-test', txHash, status: 'confirmed' } };
    },
    window: { ethereum: { request: async request => {
      requests.push(structuredClone(request));
      const response = await options.onRequest?.(request, context);
      if (response !== undefined) return response;
      switch (request.method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [address];
        case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null;
        case 'eth_chainId': return '0x3c8';
        case 'eth_sendTransaction': return txHash;
        default: throw new Error('Unexpected wallet method: ' + request.method);
      }
    } } }
  };
  vm.createContext(context);
  vm.runInContext(sourceUnderTest, context, { filename: 'app.js:wallet-functions' });
  return { context, requests, confirmations, pendingViews, proofs, cache, prepared, sends: () => requests.filter(item => item.method === 'eth_sendTransaction') };
}

test('wallet send stops after logout, navigation or dialog close at every pre-send asynchronous boundary', async () => {
  const mutations = {
    logout: context => { context.user = null; },
    accountChange: context => { context.user = { id: 'user-another' }; },
    route: context => { context.renderToken++; },
    hash: context => { context.location.hash = '#records'; },
    close: context => context.closeDialog(),
    nativeClose: context => { context.dialog.open = false; }
  };
  for (const boundary of ['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts']) {
    for (const [name, mutate] of Object.entries(mutations)) {
      const env = harness({ onRequest: (request, context) => { if (request.method === boundary) mutate(context); } });
      await assert.rejects(env.context.sendAttestation(), error => error.code === 'WALLET_CONTEXT_CHANGED', `${name} during ${boundary}`);
      assert.equal(env.sends().length, 0, `${name} during ${boundary} must not dispatch`);
      assert.equal(env.confirmations.length, 0);
      assert.equal(env.context.walletOperation, null, 'cancelled flow releases the global operation lock');
    }
  }
});

test('final network and account checks reject a wallet changed during network switching', async () => {
  for (const [method, response, message] of [
    ['eth_chainId', '0x2a5', /网络/],
    ['eth_accounts', [otherAddress], /账户/],
    ['eth_accounts', [], /账户/]
  ]) {
    const env = harness({ onRequest: request => request.method === method ? response : undefined });
    await assert.rejects(env.context.sendAttestation(), message);
    assert.equal(env.sends().length, 0);
    assert.equal(env.confirmations.length, 0);
  }
});

test('normal wallet send is single-flight, pins chainId and never resends an already returned transaction', async () => {
  const reached = deferred(), release = deferred();
  const env = harness({ onRequest: async request => {
    if (request.method === 'eth_requestAccounts') { reached.resolve(); await release.promise; }
  } });
  const running = env.context.sendAttestation();
  await reached.promise;
  await assert.rejects(env.context.sendAttestation(), /尚未结束/);
  release.resolve();
  await running;
  assert.equal(env.sends().length, 1);
  const transaction = env.sends()[0].params[0];
  assert.equal(transaction.chainId, '0x3c8');
  assert.equal(transaction.from, address);
  assert.equal(transaction.to, env.prepared.transaction.to);
  assert.equal(transaction.value, '0x0');
  assert.equal(transaction.data, env.prepared.transaction.data);
  assert.deepEqual(env.requests.map(item => item.method), ['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  assert.equal(env.confirmations.length, 1);
  assert.equal(env.proofs.length, 1);
  assert.equal(env.cache.size, 0);
  assert.equal(env.context.pendingAttestation, null);
  await assert.rejects(env.context.sendAttestation(), /重新准备/);
  assert.equal(env.sends().length, 1);
});

test('a hash returning after logout or close is cached for its original account without reopening UI or resending', async () => {
  for (const invalidate of [
    context => { context.user = null; context.renderToken++; },
    context => { context.user = { id: 'user-next' }; },
    context => context.closeDialog()
  ]) {
    const env = harness({ onRequest: (request, context) => {
      if (request.method === 'eth_sendTransaction') invalidate(context);
    } });
    await env.context.sendAttestation();
    assert.equal(env.sends().length, 1);
    assert.equal(env.confirmations.length, 0);
    assert.equal(env.pendingViews.length, 0);
    assert.equal(env.proofs.length, 0);
    const saved = JSON.parse(env.cache.get('aia-pending-tx:user-original:attestation-test'));
    assert.equal(saved.txHash, txHash);
    assert.equal(env.cache.size, 1);
    assert.equal(env.context.pendingAttestation, null);
    assert.equal(env.context.walletOperation, null);
    await assert.rejects(env.context.sendAttestation(), /重新准备/);
    assert.equal(env.sends().length, 1);
  }
});

test('an unconfirmed transaction keeps its recovery hash and cannot trigger another send on retry', async () => {
  const env = harness({ apiError: Object.assign(new Error('尚未确认'), { code: 'TRANSACTION_PENDING' }) });
  await env.context.sendAttestation();
  assert.equal(env.sends().length, 1);
  assert.equal(env.confirmations.length, 1);
  assert.equal(env.proofs.length, 0);
  assert.equal(env.pendingViews.at(-1).message, '尚未确认');
  assert.equal(JSON.parse(env.cache.get('aia-pending-tx:user-original:attestation-test')).txHash, txHash);
  await assert.rejects(env.context.sendAttestation(), /重新准备/);
  assert.equal(env.sends().length, 1);
});

test('unknown-network setup requires the same final checks and cancellation during setup stops dispatch', async () => {
  let switchCount = 0;
  const env = harness({ onRequest: request => {
    if (request.method === 'wallet_switchEthereumChain' && ++switchCount === 1) throw Object.assign(new Error('unknown network'), { code: 4902 });
  } });
  await env.context.sendAttestation();
  assert.equal(switchCount, 2);
  assert.equal(env.requests.find(item => item.method === 'wallet_addEthereumChain').params[0].chainId, '0x3c8');
  assert.equal(env.sends()[0].params[0].chainId, '0x3c8');
  const cancelled = harness({ onRequest: (request, context) => {
    if (request.method === 'wallet_switchEthereumChain') throw Object.assign(new Error('unknown network'), { code: 4902 });
    if (request.method === 'wallet_addEthereumChain') context.closeDialog();
  } });
  await assert.rejects(cancelled.context.sendAttestation(), error => error.code === 'WALLET_CONTEXT_CHANGED');
  assert.equal(cancelled.sends().length, 0);
});
