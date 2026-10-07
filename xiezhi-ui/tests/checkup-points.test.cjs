const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ethers = require('ethers');
const { createReader, getNetwork, validateDeployment } = require('../checkup-points-core.js');

const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '../../aia/chain/artifacts/PointsLedger.json'), 'utf8'));
const abi = new ethers.Interface(artifact.abi);
const address = '0x1111111111111111111111111111111111111111';
const issuer = '0x2222222222222222222222222222222222222222';
const author = 'A5126602136';
const subject = ethers.id('openalex:' + author);
const hash = label => ethers.id('points test ' + label);
const headHash = hash('head');
const deployment = { chainId: 968, address, block: 100, rules: 'points-v0' };
function event(kind, amount, balance, overrides = {}) {
  const name = kind === 'award' ? 'Awarded' : 'Spent';
  const reason = overrides.reason || ethers.encodeBytes32String(kind === 'award' ? 'NEWCOMER' : 'SUBMIT_LOW');
  const encoded = abi.encodeEventLog(abi.getEvent(name), [overrides.subject || subject, amount, reason, overrides.evidence || hash('evidence'), issuer, balance]);
  return { ...encoded, address, blockNumber: 109, blockHash: hash('block109'), transactionHash: hash(name + ' transaction'), transactionIndex: 1, index: kind === 'award' ? 0 : 1, removed: false, ...overrides };
}
function fixture(options = {}) {
  const calls = { fetch: [], balances: [], logs: [], blocks: [], code: [], sdk: 0, destroy: 0, provider: [] };
  const data = { balance: 20n, awards: [event('award', 20n, 20n)], spends: [], ...options.data };
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(options.network === 'mainnet' ? 677 : 968) }),
    getBlockNumber: async () => 110,
    getBlock: async number => { calls.blocks.push(number); return { number, hash: number === 110 ? headHash : hash('block' + number), timestamp: 1770000000 }; },
    getCode: async (...args) => { calls.code.push(args); return '0x60016002'; },
    destroy: () => { calls.destroy++; }, ...options.provider
  };
  const contract = {
    balanceOf: async (...args) => { calls.balances.push(args); return data.balance; },
    filters: { Awarded: target => ({ kind: 'award', subject: target }), Spent: target => ({ kind: 'spend', subject: target }) },
    queryFilter: async (filter, from, to) => { calls.logs.push({ filter, from, to }); return (filter.kind === 'award' ? data.awards : data.spends).filter(log => log.blockNumber >= from && log.blockNumber <= to); },
    ...options.contract
  };
  const reader = createReader({
    network: options.network || 'testnet',
    fetch: async (file, config) => {
      calls.fetch.push({ file, signal: config.signal });
      return { ok: true, status: 200, json: async () => file.includes('deployments') ? { ...deployment, ...(options.network === 'mainnet' ? { chainId: 677 } : {}), ...options.deployment } : artifact };
    },
    loadEthers: async () => { calls.sdk++; return ethers; },
    createProvider: (...args) => { calls.provider.push(args); return provider; },
    createContract: () => contract,
    ...options.dependencies
  });
  return { reader, calls, provider, contract, data };
}

test('synthetic/invalid authors make no requests; missing deployment is unknown balance, never zero', async () => {
  const env = fixture();
  assert.equal((await env.reader.read({ id: 'SYNTHETIC', synthetic: true })).kind, 'synthetic');
  assert.equal((await env.reader.read('SYNTHETIC')).balance, null);
  assert.equal((await env.reader.read('garbage')).kind, 'error');
  assert.equal((await env.reader.readSubject('not a subject')).kind, 'error');
  assert.equal(env.calls.fetch.length, 0);
  assert.equal(env.calls.sdk, 0);
  const missing = fixture({ dependencies: { fetch: async () => ({ ok: false, status: 404 }) } });
  const result = await missing.reader.read(author);
  assert.equal(result.kind, 'missing');
  assert.equal(result.balance, null);
  assert.deepEqual(result.events, []);
  assert.match(result.message, /未部署/);
  assert.equal(missing.calls.sdk, 0);
  assert.equal(missing.calls.provider.length, 0);
});

test('network selection uses separate points deployments, RPC and explorer, with no cross-chain fallback', async () => {
  assert.equal(getNetwork().chainId, 677);
  assert.throws(() => getNetwork('968'), /仅支持/);
  assert.throws(() => createReader({ network: 'unknown' }), /仅支持/);
  assert.throws(() => createReader({ maxChunks: 51 }), /有界范围/);
  assert.throws(() => validateDeployment(deployment, 'mainnet'), /不一致/);
  assert.throws(() => validateDeployment({ ...deployment, block: -1 }, 'testnet'), /部署区块/);
  for (const network of ['mainnet', 'testnet']) {
    const env = fixture({ network });
    const result = await env.reader.read(author);
    const expected = getNetwork(network);
    assert.equal(result.kind, 'ready');
    assert.equal(result.network.key, network);
    assert.equal(result.network.chainId, expected.chainId);
    assert.equal(env.calls.fetch[0].file, expected.deploymentPath);
    assert.equal(env.calls.provider[0][0], expected.rpc);
    assert.equal(result.events[0].explorerUrl, expected.explorer + '/tx/' + result.events[0].transactionHash);
    assert.equal(result.deployment.explorer, expected.explorer + '/address/' + address);
  }
});

test('actual ABI events and uint256 balances stay exact and share a verified block snapshot', async () => {
  const huge = 9007199254740993000000000000n;
  const env = fixture({ data: { balance: huge - 10n, awards: [event('award', huge, huge, { evidence: ethers.ZeroHash })], spends: [event('spend', 10n, huge - 10n, { blockNumber: 110, blockHash: headHash })] } });
  const result = await env.reader.read({ id: author });
  assert.equal(result.kind, 'ready');
  assert.equal(result.subject, '0x673410059aa95dad11248457254c3ced7c8b585e56d57662ef753cef6dc3c867');
  assert.equal(result.balance, (huge - 10n).toString());
  assert.equal(result.events[0].amount, huge.toString());
  assert.equal(result.events[0].change, '+' + huge.toString());
  assert.equal(result.events[0].evidenceAvailable, false);
  assert.equal(result.events[1].change, '-10');
  assert.equal(result.events[1].reason, 'SUBMIT_LOW');
  assert.equal(result.events[1].issuer, issuer);
  assert.equal(result.events[1].evidence, hash('evidence'));
  assert.deepEqual(env.calls.balances[0], [subject, { blockTag: 110 }]);
  assert.deepEqual(env.calls.code[0], [address, 110]);
  assert.deepEqual(env.calls.blocks, [110, 110]);
  assert.ok(env.calls.logs.every(call => call.to === 110 && call.filter.subject === subject));
  assert.equal(result.history.complete, true);
  assert.equal(result.asOf.hash, headHash);
  assert.equal(env.calls.destroy, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('zero is shown only after successful balanceOf; unknown reason remains an explicit original hash', async () => {
  const empty = fixture({ data: { balance: 0n, awards: [] } });
  const zero = await empty.reader.readSubject(subject);
  assert.equal(zero.kind, 'ready');
  assert.equal(zero.balance, '0');
  assert.deepEqual(zero.events, []);
  const reasonHash = '0x' + 'ff'.repeat(32);
  const env = fixture({ data: { awards: [event('award', 20n, 20n, { reason: reasonHash })] } });
  const result = await env.reader.read(author);
  assert.equal(result.kind, 'ready');
  assert.equal(result.events[0].reason, null);
  assert.equal(result.events[0].reasonHash, reasonHash);
});

test('wrong manifest, wrong RPC network, missing code and balance failures are errors rather than zero', async () => {
  const cases = [
    { deployment: { chainId: 677 } },
    { provider: { getNetwork: async () => ({ chainId: 1n }) } },
    { provider: { getCode: async () => '0x' } },
    { contract: { balanceOf: async () => { throw new Error('RPC offline'); } } },
    { contract: { balanceOf: async () => Number.MAX_SAFE_INTEGER + 1 } },
    { dependencies: { fetch: async () => ({ ok: false, status: 503 }) } }
  ];
  for (const options of cases) {
    const env = fixture(options);
    const result = await env.reader.read(author);
    assert.equal(result.kind, 'error');
    assert.equal(result.balance, null);
    assert.deepEqual(result.events, []);
    assert.ok(result.message);
    assert.equal(env.calls.destroy, env.calls.provider.length);
  }
});

test('bounded pagination and log failure retain verified balance and explicitly incomplete history', async () => {
  const bounded = fixture({ dependencies: { chunkSize: 3, maxChunks: 2 } });
  const result = await bounded.reader.read(author);
  assert.equal(result.kind, 'partial');
  assert.equal(result.balance, '20');
  assert.equal(result.history.complete, false);
  assert.equal(result.history.scannedFromBlock, 105);
  assert.match(result.history.reason, /分页上限/);
  assert.deepEqual(bounded.calls.logs.map(call => [call.from, call.to]), [[108, 110], [108, 110], [105, 107], [105, 107]]);
  const failed = fixture({ contract: { queryFilter: async () => { throw new Error('logs unavailable'); } } });
  const partial = await failed.reader.read(author);
  assert.equal(partial.kind, 'partial');
  assert.equal(partial.balance, '20');
  assert.deepEqual(partial.events, []);
  assert.match(partial.history.reason, /logs unavailable/);
  assert.equal(failed.calls.destroy, 1);
});

test('event truncation, inconsistent balances and invalid metadata never claim complete history', async () => {
  const first = event('award', 20n, 20n, { index: 0, transactionHash: hash('first') });
  const second = event('award', 5n, 25n, { index: 1, transactionHash: hash('second') });
  const limited = fixture({ data: { balance: 25n, awards: [second, first] }, dependencies: { maxEvents: 1 } });
  const truncated = await limited.reader.read(author);
  assert.equal(truncated.kind, 'partial');
  assert.equal(truncated.events.length, 1);
  assert.equal(truncated.events[0].amount, '5');
  assert.match(truncated.history.reason, /条数上限/);
  const wrongBalance = await fixture({ data: { balance: 21n } }).reader.read(author);
  assert.equal(wrongBalance.kind, 'partial');
  assert.match(wrongBalance.history.reason, /不能完整核对/);
  for (const log of [
    event('award', 20n, 20n, { transactionHash: 'not-a-hash' }),
    event('award', 20n, 20n, { removed: true }),
    event('award', 20n, 20n, { address: issuer }),
    event('award', 20n, 20n, { subject: hash('another person') }),
    event('award', 20n, 20n, { blockNumber: 110, blockHash: hash('orphan') })
  ]) {
    const malformed = await fixture({ data: { awards: [log] } }).reader.read(author);
    assert.equal(malformed.kind, 'partial');
    assert.deepEqual(malformed.events, []);
    assert.equal(malformed.history.complete, false);
  }
});

test('duplicate logs are not counted twice and a changed head invalidates the balance snapshot', async () => {
  const row = event('award', 20n, 20n);
  const duplicate = await fixture({ data: { awards: [row, row] } }).reader.read(author);
  assert.equal(duplicate.kind, 'ready');
  assert.equal(duplicate.events.length, 1);
  let checks = 0;
  const reorg = fixture({ provider: { getBlock: async number => ({ number, timestamp: 1770000000, hash: ++checks === 1 ? headHash : hash('replacement') }) } });
  const result = await reorg.reader.read(author);
  assert.equal(result.kind, 'error');
  assert.equal(result.balance, null);
  assert.deepEqual(result.events, []);
  assert.match(result.message, /区块发生变化/);
  assert.equal(reorg.calls.destroy, 1);
});

test('abort, reader disposal and RPC deadlines always close allocated providers', async () => {
  for (const mode of ['abort', 'destroy', 'timeout']) {
    let reached;
    const waiting = new Promise(resolve => { reached = resolve; });
    const env = fixture({ dependencies: { timeoutMs: 30 }, contract: { balanceOf: () => { reached(); return new Promise(() => {}); } } });
    const controller = new AbortController();
    const reading = env.reader.read(author, { signal: controller.signal });
    await waiting;
    if (mode === 'abort') controller.abort();
    if (mode === 'destroy') env.reader.destroy();
    if (mode === 'timeout') {
      const result = await reading;
      assert.equal(result.kind, 'error');
      assert.equal(result.balance, null);
      assert.match(result.message, /超时/);
    } else await assert.rejects(reading, error => error.name === 'AbortError');
    assert.equal(env.calls.destroy, 1);
    if (mode === 'destroy') await assert.rejects(env.reader.read(author), error => error.name === 'AbortError');
  }
});

test('fetch and SDK failures are bounded, do not create providers, and remain retryable', async () => {
  let fetchSignal;
  const stalled = fixture({ dependencies: { timeoutMs: 10, fetch: async (_file, options) => { fetchSignal = options.signal; return new Promise(() => {}); } } });
  const result = await stalled.reader.read(author);
  assert.equal(result.kind, 'error');
  assert.equal(fetchSignal.aborted, true);
  assert.equal(stalled.calls.provider.length, 0);
  let attempts = 0;
  const retry = fixture({ dependencies: { loadEthers: async () => { if (++attempts === 1) throw new Error('CDN offline'); return ethers; } } });
  assert.equal((await retry.reader.read(author)).kind, 'error');
  assert.equal((await retry.reader.read(author, { retry: true })).kind, 'ready');
  assert.equal(attempts, 2);
  let imports = 0;
  const hungImport = fixture({ dependencies: { timeoutMs: 10, loadEthers: () => ++imports === 1 ? new Promise(() => {}) : Promise.resolve(ethers) } });
  assert.equal((await hungImport.reader.read(author)).kind, 'error');
  assert.equal((await hungImport.reader.read(author, { retry: true })).kind, 'ready');
  assert.equal(imports, 2, 'a timed-out SDK promise must not trap every subsequent retry');
});
