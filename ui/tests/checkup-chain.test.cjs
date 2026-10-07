const test = require('node:test');
const assert = require('node:assert/strict');
const { createReader, createSession, matchEvents } = require('../checkup-chain.js');

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

test('all five action kinds retain actual fields and non-score actions never invent points', async () => {
  const kinds = ['SCORE', 'SUBMIT', 'REVIEW', 'REPRODUCE', 'CLAIM'];
  const rows = kinds.map(kind => row({ kind: bytes32(kind), value: kind === 'SCORE' ? 70n : 0n, rule: kind === 'SCORE' ? bytes32('checkup-v0') : zero }));
  const events = rows.map((action, index) => { const { rule, time, ...args } = action; return event({ args, index }); });
  const { reader } = fixture({ contract: { actionsOf: async () => rows, queryFilter: async () => events } });
  const result = await reader.read(person);
  assert.equal(result.kind, 'ready');
  assert.deepEqual(result.records.map(action => action.kind), kinds);
  assert.deepEqual(result.records.map(action => action.kindLabel), ['评分', '投稿', '审稿', '复现', '认领']);
  assert.deepEqual(result.records.map(action => action.value), [70, 0, 0, 0, 0]);
  assert.equal(result.records[1].ruleLabel, '未指定规则');
  assert.equal(result.records.every(action => action.content === hash('3') && action.recorder === address('5')), true);
  assert.equal(result.history.matched, 5);
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

test('wrong action subject/content, unsupported kind and non-score value are rejected', async () => {
  for (const changed of [{ subject: hash('8') }, { kind: bytes32('UNKNOWN') }, { kind: bytes32('CLAIM'), value: 1n }]) {
    const { reader } = fixture({ contract: { actionsOf: async () => [row(changed)] } });
    assert.equal((await reader.read(person)).kind, 'error');
  }
  const { reader } = fixture({ contract: { actionsByContent: async () => [row({ content: hash('8') })] } });
  assert.equal((await reader.read({ contentHash: hash('3') })).kind, 'error');
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
