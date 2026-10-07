const test = require('node:test');
const assert = require('node:assert/strict');
const { createReader, createSession, matchEvents, validateJournals, loadJournals, trustedJournal, getNetwork, validateDeployment } = require('../checkup-chain.js');

const hash = digit => '0x' + digit.repeat(64);
const address = digit => '0x' + digit.repeat(40);
const bytes32 = text => '0x' + Buffer.from(text).toString('hex').padEnd(64, '0');
const zero = hash('0');
const subject = hash('1');
const deployment = { chainId: 677, address: address('2'), block: 100 };
const person = { id: 'A5126602136', synthetic: false };
const row = (overrides = {}) => ({ subject, kind: bytes32('SCORE'), content: hash('3'), org: zero, rule: bytes32('checkup-v0'), value: 70n, recorder: address('5'), time: 1770000000n, ...overrides });
const event = (overrides = {}) => {
  const { rule, time, ...args } = row(); // Recorded really omits rule and time.
  return { args, transactionHash: hash('6'), blockNumber: 109, index: 0, ...overrides };
};

function fixture(overrides = {}) {
  const calls = { fetch: [], actions: [], contents: [], logs: [], network: 0, destroyed: 0, sdk: 0 };
  const provider = {
    getNetwork: async () => { calls.network += 1; return { chainId: 677n }; },
    getBlockNumber: async () => 110,
    getCode: async () => '0x60016002',
    destroy: () => { calls.destroyed += 1; },
    ...(overrides.provider || {})
  };
  const contract = {
    actionsOf: async (...args) => { calls.actions.push(args); return [row()]; },
    actionsByContent: async (...args) => { calls.contents.push(args); return [row()]; },
    filters: { Recorded: (...args) => args },
    queryFilter: async (...args) => { calls.logs.push(args); return [event()]; },
    ...(overrides.contract || {})
  };
  const reader = createReader({
    fetch: async (path, options) => {
      calls.fetch.push({ path, options });
      return { ok: true, status: 200, json: async () => path.includes('deployments') ? deployment : { abi: [] } };
    },
    loadSdk: async () => { calls.sdk += 1; return { keccak256: value => { assert.equal(value, 'openalex:' + person.id); return subject; }, toUtf8Bytes: value => value, decodeBytes32String: value => Buffer.from(value.slice(2), 'hex').toString().replace(/\0+$/, '') }; },
    createProvider: () => provider,
    createContract: () => contract,
    ...overrides.dependencies
  });
  return { reader, calls, provider, contract };
}

test('missing deployment is cached snapshot mode and reload rediscovers it without importing SDK', async () => {
  let reads = 0;
  const { reader, calls } = fixture({ dependencies: { fetch: async () => { reads += 1; return { ok: false, status: 404 }; } } });
  assert.equal((await reader.read(person)).kind, 'snapshot');
  assert.equal((await reader.read(person)).label, '未部署 · 快照演示');
  assert.equal(reads, 1);
  await reader.read(person, { retry: true });
  assert.equal(reads, 2);
  assert.equal(calls.sdk, 0);
  assert.equal(calls.network, 0);
});

test('synthetic cases never request deployment, SDK, RPC or events', async () => {
  const { reader, calls } = fixture();
  const result = await reader.read({ id: 'SYNTHETIC', synthetic: true });
  assert.equal(result.kind, 'synthetic');
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.sdk, 0);
});

test('wrong manifest network and wrong RPC network never query actions', async () => {
  const wrongManifest = fixture({ dependencies: { fetch: async () => ({ ok: true, json: async () => ({ ...deployment, chainId: 97 }) }) } });
  assert.equal((await wrongManifest.reader.read(person)).kind, 'error');
  assert.equal(wrongManifest.calls.sdk, 0);
  const wrongRpc = fixture({ provider: { getNetwork: async () => ({ chainId: 97n }) } });
  const result = await wrongRpc.reader.read(person);
  assert.equal(result.kind, 'error');
  assert.match(result.message, /期望 677，收到 97/);
  assert.equal(wrongRpc.calls.actions.length, 0);
  assert.equal(wrongRpc.calls.destroyed, 1);
});

test('address without bytecode does not become chain mode', async () => {
  const { reader, calls } = fixture({ provider: { getCode: async () => '0x' } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'error');
  assert.match(result.message, /没有合约代码/);
  assert.equal(calls.actions.length, 0);
});

test('actions and matching Recorded metadata use the same pinned block and correct subject', async () => {
  const { reader, calls } = fixture();
  const result = await reader.read(person);
  assert.equal(result.kind, 'ready');
  assert.equal(result.records[0].value, 70);
  assert.equal(result.records[0].kind, 'SCORE');
  assert.equal(Object.hasOwn(result.records[0], 'confidence'), false);
  assert.equal(result.records[0].ruleLabel, 'checkup-v0');
  assert.equal(result.records[0].transactionHash, hash('6'));
  assert.equal(result.records[0].blockNumber, 109);
  assert.deepEqual(calls.actions[0], [subject, { blockTag: 110 }]);
  assert.deepEqual(calls.logs[0], [[null, subject, null], 100, 110]);
  assert.ok(calls.fetch.some(call => call.path.endsWith('ActionRegistry.json')));
  assert.equal(result.history.complete, true);
  assert.equal(calls.destroyed, 1);
});

test('bounded event history leaves unmatched records visible and explicitly partial', async () => {
  const { reader, calls } = fixture({
    dependencies: { chunkSize: 3, maxChunks: 2 },
    contract: { queryFilter: async (...args) => { calls.logs.push(args); return []; } }
  });
  const result = await reader.read(person);
  assert.equal(result.kind, 'partial');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].transactionHash, null);
  assert.deepEqual(calls.logs.map(args => args.slice(1)), [[108, 110], [105, 107]]);
  assert.equal(result.history.fromBlock, 105);
  assert.equal(result.history.limit, 6);
});

test('failed event RPC preserves real action, never fabricates tx or block', async () => {
  const { reader } = fixture({ contract: { queryFilter: async () => { throw new Error('RPC log limit'); } } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'partial');
  assert.equal(result.records[0].value, 70);
  assert.equal(result.records[0].transactionHash, null);
  assert.equal(result.records[0].blockNumber, null);
  assert.equal(result.history.logError, 'RPC log limit');
});

test('actions RPC failure is an explicit error and closes provider', async () => {
  const { reader, calls } = fixture({ contract: { actionsOf: async () => { throw new Error('RPC unavailable'); } } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'error');
  assert.match(result.message, /RPC unavailable/);
  assert.deepEqual(result.records, []);
  assert.equal(calls.destroyed, 1);
});

test('events with no rule remain ambiguous until complete matching group is available', () => {
  const scores = [row({ transactionHash: null }), row({ transactionHash: null, rule: bytes32('checkup-v1') })];
  matchEvents(scores, [event()]);
  assert.equal(scores[0].transactionHash, null);
  assert.equal(scores[1].transactionHash, null);
  const unique = row({ transactionHash: null });
  matchEvents([unique], [event({ args: row({ content: hash('7') }) })]);
  assert.equal(unique.transactionHash, null);
  matchEvents(scores, [event(), event({ transactionHash: hash('8'), index: 1 })]);
  assert.equal(scores[0].transactionHash, hash('6'));
  assert.equal(scores[1].transactionHash, hash('8'));
});

test('all six action kinds retain actual fields and non-score actions never invent points', async () => {
  const kinds = ['SCORE', 'SUBMIT', 'CLOSE', 'REVIEW', 'REPRODUCE', 'CLAIM'];
  const rows = kinds.map(kind => row({ kind: bytes32(kind), value: kind === 'SCORE' ? 70n : 0n, rule: kind === 'SCORE' ? bytes32('checkup-v0') : zero }));
  const events = rows.map((action, index) => { const { rule, time, ...args } = action; return event({ args, index }); });
  const { reader } = fixture({ contract: { actionsOf: async () => rows, queryFilter: async () => events } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'ready');
  assert.deepEqual(result.records.map(action => action.kind), kinds);
  assert.deepEqual(result.records.map(action => action.kindLabel), ['评分', '投稿', '结案', '审稿', '复现', '认领']);
  assert.deepEqual(result.records.map(action => action.value), [70, 0, 0, 0, 0, 0]);
  assert.equal(result.records[1].ruleLabel, '未指定规则');
  assert.equal(result.records.every(action => action.content === hash('3') && action.recorder === address('5')), true);
  assert.equal(result.history.matched, 6);
});

test('content lookup calls actionsByContent and filters unindexed event content locally', async () => {
  const { reader, calls } = fixture({ contract: { queryFilter: async (...args) => {
    calls.logs.push(args);
    return [event(), event({ args: row({ content: hash('7') }), transactionHash: hash('8'), index: 1 })];
  } } });
  const result = await reader.read({ contentHash: hash('3') });
  assert.equal(result.kind, 'ready');
  assert.equal(result.subject, null);
  assert.equal(result.contentHash, hash('3'));
  assert.equal(result.records[0].transactionHash, hash('6'));
  assert.deepEqual(calls.contents[0], [hash('3'), { blockTag: 110 }]);
  assert.deepEqual(calls.logs[0], [[null, null, null], 100, 110]);
  assert.equal(calls.actions.length, 0);
});

test('wrong action subject/content and non-score value are rejected', async () => {
  for (const changed of [{ subject: hash('8') }, { kind: bytes32('CLAIM'), value: 1n }]) {
    const { reader } = fixture({ contract: { actionsOf: async () => [row(changed)] } });
    assert.equal((await reader.read(person)).kind, 'error');
  }
  const { reader } = fixture({ contract: { actionsByContent: async () => [row({ content: hash('8') })] } });
  assert.equal((await reader.read({ contentHash: hash('3') })).kind, 'error');
});

test('CLOSE reasons use Chinese labels while preserving rule bytes and unknown reasons', async () => {
  const reasons = ['REJECTED', 'WITHDRAWN', 'ACCEPTED', 'OTHER'];
  const { reader } = fixture({ contract: {
    actionsOf: async () => reasons.map(reason => row({ kind: bytes32('CLOSE'), value: 0n, rule: bytes32(reason) })),
    queryFilter: async () => []
  } });
  const result = await reader.read(person);
  assert.deepEqual(result.records.map(action => action.closeReasonLabel), ['拒稿', '撤稿', '录用', '未知结案原因']);
  assert.deepEqual(result.records.map(action => action.closeReason), ['REJECTED', 'WITHDRAWN', 'ACCEPTED', null]);
  assert.equal(result.records[0].rule, bytes32('REJECTED'));
  assert.equal(result.records[0].ruleLabel, '拒稿');
  assert.equal(result.records[0].ruleName, 'REJECTED');
  assert.equal(result.records[3].ruleName, 'OTHER');
});

test('unknown kinds preserve records and raw type without interpreting their values as scores', async () => {
  const { reader } = fixture({ contract: {
    actionsOf: async () => [row(), row({ kind: bytes32('FUTURE_KIND'), value: 99n })],
    queryFilter: async () => []
  } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'partial');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].knownKind, true);
  assert.equal(result.records[1].knownKind, false);
  assert.equal(result.records[1].kindLabel, '未知行为');
  assert.equal(result.records[1].kindHash, bytes32('FUTURE_KIND'));
  assert.equal(result.records[1].value, 99);
});

test('original sequence and matched block/log index preserve same-second lifecycle order', async () => {
  const first = row({ kind: bytes32('SUBMIT'), value: 0n, rule: zero });
  const second = row({ kind: bytes32('CLOSE'), value: 0n, rule: bytes32('REJECTED') });
  const asEvent = (action, id, index) => { const { time, rule, ...args } = action; return event({ args: { ...args, id }, index }); };
  const { reader } = fixture({ contract: {
    actionsOf: async () => [first, second],
    queryFilter: async () => [asEvent(second, 9007199254740993n, 8), asEvent(first, 9007199254740992n, 7)]
  } });
  const result = await reader.read(person);
  assert.deepEqual(result.records.map(action => action.sequence), [0, 1]);
  assert.deepEqual(result.records.map(action => action.logIndex), [7, 8]);
  assert.deepEqual(result.records.map(action => action.eventId), ['9007199254740992', '9007199254740993']);
  assert.equal(result.records[0].time, result.records[1].time);
  assert.equal(result.records[0].blockNumber, result.records[1].blockNumber);
});

const journalManifest = () => ({
  manuscript: hash('a'), demoAuthor: 'DEMO-MULTI',
  journals: [{ key: 'journalA', name: '演示期刊甲', address: address('b'), org: hash('c') }, { key: 'journalB', name: '演示期刊乙', address: address('d'), org: hash('e') }]
});

test('journal trust requires the exact recorder and organization pair, independent of case', () => {
  const manifest = validateJournals(journalManifest());
  assert.equal(trustedJournal({ recorder: address('b').toUpperCase().replace('0X', '0x'), org: hash('c') }, manifest).name, '演示期刊甲');
  assert.equal(trustedJournal({ recorder: address('b'), org: hash('e') }, manifest), null);
  assert.equal(trustedJournal({ recorder: address('f'), org: hash('c') }, manifest), null);
  assert.equal(trustedJournal({ recorder: address('b'), org: hash('c') }, { kind: 'error', ...manifest }), null);
});

test('invalid, empty, duplicated and malformed journal manifests fail closed', () => {
  for (const value of [null, { journals: [], manuscript: hash('a') }, { ...journalManifest(), manuscript: 'bad' }, { ...journalManifest(), journals: [{ name: '甲', address: address('0'), org: hash('c') }] }, { ...journalManifest(), journals: [{ name: '甲', address: address('b'), org: zero }] }]) {
    assert.throws(() => validateJournals(value));
  }
  const duplicated = journalManifest(); duplicated.journals.push({ ...duplicated.journals[0] });
  assert.throws(() => validateJournals(duplicated), /重复/);
});

test('journal load distinguishes missing, failed and ready states, and refresh rereads without cache', async () => {
  let source = null;
  const requests = [];
  const fetcher = async (path, options) => { requests.push({ path, options }); return { ok: Boolean(source), status: source ? 200 : 404, json: async () => source }; };
  const missing = await loadJournals({ fetch: fetcher });
  assert.equal(missing.kind, 'missing');
  assert.deepEqual(missing.journals, []);
  assert.equal(missing.manuscript, null);
  source = journalManifest();
  const ready = await loadJournals({ fetch: fetcher });
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.manuscript, hash('a'));
  assert.equal(ready.demoAuthor, 'DEMO-MULTI');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.cache, 'no-store');
  assert.equal(requests[1].path, '../chain/deployments/journals.json');
  const failed = await loadJournals({ fetch: async () => { throw new Error('offline'); } });
  assert.equal(failed.kind, 'error');
  assert.deepEqual(failed.journals, []);
  source = { ...source, manuscript: 'invalid' };
  assert.equal((await loadJournals({ fetch: fetcher })).kind, 'error');
});

test('journal loads support cancellation without publishing an empty successful list', async () => {
  const controller = new AbortController();
  const request = loadJournals({ signal: controller.signal, fetch: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('network selection is allowlisted and URL testnet is explicit, with mainnet remaining the default', () => {
  assert.equal(getNetwork().chainId, 677);
  assert.equal(getNetwork('testnet').chainId, 968);
  assert.equal(getNetwork('testnet').explorer, 'https://scan.bohr.life');
  assert.throws(() => getNetwork('https://evil.invalid'), /仅支持/);
  const previous = globalThis.location;
  try {
    globalThis.location = { search: '?network=testnet' };
    assert.equal(getNetwork().key, 'testnet');
    assert.equal(validateDeployment({ ...deployment, chainId: 968 }).chainId, 968);
    globalThis.location = { search: '?network=other' };
    assert.equal(getNetwork().key, 'mainnet');
  } finally { if (previous === undefined) delete globalThis.location; else globalThis.location = previous; }
  assert.throws(() => validateDeployment({ ...deployment, chainId: 968 }), /677/);
  assert.throws(() => validateDeployment(deployment, 'testnet'), /968/);
});

test('testnet reader uses its own deployment, RPC and explorer and labels chain 968', async () => {
  const paths = [];
  let actualRpc;
  const setup = fixture({
    provider: { getNetwork: async () => ({ chainId: 968n }) },
    dependencies: {
      network: 'testnet',
      fetch: async path => { paths.push(path); return { ok: true, status: 200, json: async () => path.includes('deployments') ? { ...deployment, chainId: 968 } : { abi: [] } }; },
      createProvider: rpc => { actualRpc = rpc; return setup.provider; }
    }
  });
  const state = await setup.reader.read(person);
  assert.equal(state.kind, 'ready');
  assert.equal(state.network, 'testnet');
  assert.equal(state.chainId, 968);
  assert.match(state.label, /测试网.*968/);
  assert.equal(state.explorer, 'https://scan.bohr.life');
  assert.equal(actualRpc, 'https://rpc.bohr.life');
  assert.equal(paths[0], '../chain/deployments/botchain-testnet.json');
  assert.equal(paths.includes('../chain/deployments/botchain.json'), false);
  assert.equal(state.records[0].transactionHash, hash('6'));
});

test('missing testnet deployment cannot silently fall back to mainnet', async () => {
  const paths = [];
  const { reader, calls } = fixture({ dependencies: { network: 'testnet', fetch: async path => { paths.push(path); return { ok: false, status: 404 }; } } });
  const state = await reader.read(person);
  assert.equal(state.kind, 'snapshot');
  assert.equal(state.label, '测试网未部署 · 快照演示');
  assert.deepEqual(paths, ['../chain/deployments/botchain-testnet.json']);
  assert.equal(calls.network, 0);
});

test('a mainnet RPC answering a testnet request is rejected before reading actions', async () => {
  const { reader, calls } = fixture({ dependencies: { network: 'testnet', fetch: async path => ({ ok: true, json: async () => path.includes('deployments') ? { ...deployment, chainId: 968 } : { abi: [] } }) } });
  const state = await reader.read(person);
  assert.equal(state.kind, 'error');
  assert.match(state.message, /期望 968，收到 677/);
  assert.equal(calls.actions.length, 0);
});

test('testnet journals use a separate no-store manifest with no mainnet fallback', async () => {
  const paths = [];
  const state = await loadJournals({ network: 'testnet', fetch: async path => { paths.push(path); return { ok: true, status: 200, json: async () => journalManifest() }; } });
  assert.equal(state.kind, 'ready');
  assert.equal(state.network, 'testnet');
  assert.match(state.message, /测试网.*968/);
  assert.deepEqual(paths, ['../chain/deployments/journals-testnet.json']);
});

test('unknown network request failures do not masquerade as missing deployment', async () => {
  const { reader } = fixture({ dependencies: { fetch: async () => { throw new Error('offline'); } } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'offline');
});

test('slow RPC has a deadline and closes provider', async () => {
  const { reader, calls } = fixture({ dependencies: { timeoutMs: 20 }, provider: { getNetwork: () => new Promise(() => {}) } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'error');
  assert.match(result.message, /超时/);
  assert.equal(calls.destroyed, 1);
});

test('late subject results and destroyed sessions cannot publish stale chain data', async () => {
  const pending = [];
  const published = [];
  const session = createSession({ read: () => new Promise(resolve => pending.push(resolve)) }, state => published.push(state));
  const first = session.update(person);
  const second = session.update({ id: 'A5009290031' });
  pending[1]({ kind: 'ready', label: 'second', records: [] });
  await second;
  pending[0]({ kind: 'ready', label: 'first', records: [] });
  await first;
  assert.equal(session.getStatus().label, 'second');
  const third = session.reload();
  session.destroy();
  const count = published.length;
  pending[2]({ kind: 'ready', label: 'third', records: [] });
  await third;
  assert.equal(published.length, count);
});
