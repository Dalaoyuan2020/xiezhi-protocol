import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createClaimPublicChain } from '../lib/claim-public-chain.mjs';

const CONTRACT = '0x1234567890123456789012345678901234567890';
const WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const CONTENT = ethers.id('accepted-claim-content');
const SUBJECT = ethers.id('openalex:A5126602136');
const TX = ethers.id('wallet-transaction');
const BLOCK = ethers.id('canonical-block-100');
const KIND = ethers.encodeBytes32String('CLAIM');
const RULE = ethers.id('email-claim-material-v1');
const iface = new ethers.Interface([
  'function record(bytes32 subject, bytes32 kind, bytes32 content, bytes32 org, bytes32 rule, uint16 value) returns (uint256)',
  'event Recorded(uint256 indexed id, bytes32 indexed subject, bytes32 indexed kind, bytes32 content, bytes32 org, uint16 value, address recorder)',
]);
const values = { contentHash: CONTENT, subjectHash: SUBJECT, walletAddress: WALLET };
const calldata = (patch = {}) => {
  const args = { subject: SUBJECT, kind: KIND, content: CONTENT, org: ethers.ZeroHash, rule: RULE, value: 0, ...patch };
  return iface.encodeFunctionData('record', [args.subject, args.kind, args.content, args.org, args.rule, args.value]);
};
function eventLog(patch = {}) {
  const args = { id: 7, subject: SUBJECT, kind: KIND, content: CONTENT, org: ethers.ZeroHash, value: 0, recorder: WALLET, ...patch };
  return {
    address: CONTRACT, blockNumber: '0x64', blockHash: BLOCK, transactionHash: TX,
    transactionIndex: '0x0', logIndex: '0x0', removed: false,
    ...iface.encodeEventLog(iface.getEvent('Recorded'), [args.id, args.subject, args.kind, args.content, args.org, args.value, args.recorder]),
  };
}
function fixture() {
  return {
    eth_chainId: '0x2a5', eth_getCode: '0x6001600055',
    eth_getTransactionReceipt: {
      transactionHash: TX, from: WALLET, to: CONTRACT, blockHash: BLOCK,
      blockNumber: '0x64', status: '0x1', logs: [eventLog()],
    },
    eth_getTransactionByHash: {
      hash: TX, from: WALLET, to: CONTRACT, input: calldata(), value: '0x0',
      blockHash: BLOCK, blockNumber: '0x64', chainId: '0x2a5',
    },
    eth_getBlockByNumber: { number: '0x64', hash: BLOCK }, eth_blockNumber: '0x66',
  };
}
function setup(mutate = () => {}) {
  const responses = fixture();
  mutate(responses);
  const calls = [];
  const chain = createClaimPublicChain({
    deployment: { chainId: 677, address: CONTRACT }, timeoutMs: 100,
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      calls.push({ url, ...request });
      assert.equal(options.method, 'POST');
      assert.ok(Object.hasOwn(responses, request.method), 'unexpected RPC method: ' + request.method);
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: structuredClone(responses[request.method]) }) };
    },
  });
  return { chain, responses, calls };
}
const confirm = chain => chain.confirm({ transactionHash: TX, ...values });
const rejected = (operation, status) => assert.rejects(operation, error => error.status === status && error.claimSafe === true);

test('prepare returns only an unsigned zero-value BOT transaction and makes read-only RPC calls', async () => {
  const { chain, calls } = setup();
  const prepared = await chain.prepare(values);
  assert.equal(prepared.chainId, 677);
  assert.deepEqual(prepared.transaction, { from: WALLET, to: CONTRACT, data: calldata(), value: '0x0', chainId: '0x2a5' });
  const decoded = iface.decodeFunctionData('record', prepared.transaction.data);
  assert.deepEqual(Array.from(decoded), [SUBJECT, KIND, CONTENT, ethers.ZeroHash, RULE, 0n]);
  assert.deepEqual(calls.map(call => call.method), ['eth_chainId', 'eth_getCode']);
  assert.ok(calls.every(call => call.url === 'https://rpc.botchain.ai'));
  assert.deepEqual(calls[1].params, [CONTRACT, 'latest']);
  const publicConfig = chain.config();
  publicConfig.walletNetwork.rpcUrls.push('https://untrusted.invalid');
  assert.deepEqual(chain.config().walletNetwork.rpcUrls, ['https://rpc.botchain.ai']);
});

test('missing deployment, invalid identities, wrong network and missing code cannot prepare', async t => {
  await t.test('unconfigured deployment makes no RPC request', async () => {
    const chain = createClaimPublicChain({ deployment: null, fetchImpl: () => { throw new Error('Must not call RPC'); } });
    assert.equal(chain.config().available, false);
    await rejected(chain.prepare(values), 503);
  });
  for (const patch of [{ contentHash: 'not-a-hash' }, { subjectHash: '0x12' }, { walletAddress: ethers.ZeroAddress }, { walletAddress: 'invalid' }]) {
    await t.test('invalid input: ' + Object.keys(patch)[0] + JSON.stringify(patch), async () => {
      const { chain, calls } = setup();
      await rejected(chain.prepare({ ...values, ...patch }), 400);
      assert.equal(calls.length, 0);
    });
  }
  for (const [method, value] of [['eth_chainId', '0x1'], ['eth_chainId', '677'], ['eth_getCode', '0x'], ['eth_getCode', '0x0000'], ['eth_getCode', null]]) {
    await t.test(method + '=' + value, async () => {
      const { chain } = setup(responses => { responses[method] = value; });
      await rejected(chain.prepare(values), 503);
    });
  }
});

test('a canonical matching receipt confirms and independently verifies without signing or sending', async () => {
  const { chain, calls } = setup();
  const result = await confirm(chain);
  assert.equal(result.actionId, '7');
  assert.equal(result.blockNumber, 100);
  assert.equal(result.confirmations, 3);
  assert.equal(result.contentHash, CONTENT);
  assert.equal(result.subjectHash, SUBJECT);
  assert.equal(result.explorerUrl, 'https://scan.botchain.ai/tx/' + TX);
  assert.equal(await chain.verify(result, CONTENT), true);
  assert.ok(calls.every(call => !/send|sign/i.test(call.method)));
});

test('unmined, unavailable and reorganized transactions remain pending', async t => {
  const cases = {
    'no receipt': responses => { responses.eth_getTransactionReceipt = null; },
    'no transaction': responses => { responses.eth_getTransactionByHash = null; },
    'unmined receipt': responses => { responses.eth_getTransactionReceipt.blockNumber = null; },
    'canonical block unavailable': responses => { responses.eth_getBlockByNumber = null; },
    'reorg changed block hash': responses => { responses.eth_getBlockByNumber.hash = ethers.id('replacement-block'); },
    'node behind receipt': responses => { responses.eth_blockNumber = '0x63'; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const { chain } = setup(mutate);
    assert.deepEqual(await confirm(chain), { pending: true, transactionHash: TX });
  });
});

test('reverted and malformed receipts never confirm', async t => {
  for (const [field, value, status] of [['status', '0x0', 422], ['blockHash', '0x12', 503], ['blockNumber', '100', 503]]) {
    await t.test(field, async () => {
      const { chain } = setup(responses => { responses.eth_getTransactionReceipt[field] = value; });
      await rejected(confirm(chain), status);
    });
  }
});

test('transaction hash, wallet, contract, value and all record arguments are bound to the claim', async t => {
  const mutations = [
    ['hash', ethers.id('other-transaction')], ['from', OTHER], ['to', OTHER], ['value', '0x1'], ['input', '0x12345678'],
    ['chainId', '0x1'], ['blockHash', ethers.id('another-block')], ['blockNumber', '0x63'],
    ...Object.entries({ subject: ethers.id('other-subject'), kind: ethers.encodeBytes32String('REVIEW'), content: ethers.id('other-content'), org: ethers.id('other-org'), rule: ethers.id('other-rule'), value: 5 })
      .map(([field, value]) => ['input', calldata({ [field]: value }), field]),
  ];
  for (const [field, value, detail] of mutations) await t.test(field + (detail ? ':' + detail : ''), async () => {
    const { chain } = setup(responses => { responses.eth_getTransactionByHash[field] = value; });
    await rejected(confirm(chain), 422);
  });
  const { chain, calls } = setup();
  await rejected(chain.confirm({ ...values, transactionHash: '0x1234' }), 400);
  assert.equal(calls.length, 0);
});

test('receipt transaction binding rejects a mismatched hash, sender or contract', async t => {
  for (const [field, value] of [['transactionHash', ethers.id('other')], ['from', OTHER], ['to', OTHER]]) {
    await t.test(field, async () => {
      const { chain } = setup(responses => { responses.eth_getTransactionReceipt[field] = value; });
      await rejected(confirm(chain), 422);
    });
  }
});

test('a genuine Recorded signature with the matching contract and full claim fields is mandatory', async t => {
  const events = {
    'no logs': [], 'null log': [null], 'unrelated emitter': [{ ...eventLog(), address: OTHER }],
    'wrong event signature': [{ ...eventLog(), topics: [ethers.id('Other(uint256)'), ...eventLog().topics.slice(1)] }],
    'malformed data': [{ ...eventLog(), data: '0x01' }],
    'wrong subject': [eventLog({ subject: ethers.id('other-subject') })],
    'wrong kind': [eventLog({ kind: ethers.encodeBytes32String('REVIEW') })],
    'wrong content': [eventLog({ content: ethers.id('other-content') })],
    'wrong organization': [eventLog({ org: ethers.id('other-org') })],
    'nonzero score': [eventLog({ value: 1 })], 'wrong recorder': [eventLog({ recorder: OTHER })],
    'removed event': [{ ...eventLog(), removed: true }],
  };
  for (const [name, logs] of Object.entries(events)) await t.test(name, async () => {
    const { chain } = setup(responses => { responses.eth_getTransactionReceipt.logs = logs; });
    await rejected(confirm(chain), 422);
  });
  const { chain } = setup(responses => { responses.eth_getTransactionReceipt.logs.unshift({ address: OTHER, topics: [], data: '0x' }); });
  assert.equal((await confirm(chain)).actionId, '7');
});

test('certificate verification rejects tampering and pending transactions', async t => {
  const { chain, responses } = setup();
  const certificate = await confirm(chain);
  const mutations = {
    mode: 'local', chainId: 1, label: 'Another chain', network: 'False network', contractAddress: OTHER,
    contentHash: ethers.id('other-content'), subjectHash: ethers.id('other-subject'), walletAddress: OTHER,
    transactionHash: ethers.id('other-transaction'), blockHash: ethers.id('other-block'), blockNumber: 101,
    actionId: '8', explorerUrl: 'https://untrusted.invalid/' + TX,
  };
  for (const [field, value] of Object.entries(mutations)) await t.test(field, async () => {
    assert.equal(await chain.verify({ ...certificate, [field]: value }, CONTENT), false);
  });
  assert.equal(await chain.verify(certificate, ethers.id('changed-document')), false);
  assert.equal(await chain.verify(null, CONTENT), false);
  for (const confirmations of [0, -1, 1.5, '3', 4, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await chain.verify({ ...certificate, confirmations }, CONTENT), false, 'reject invalid confirmation count: ' + confirmations);
  }
  responses.eth_blockNumber = '0x67';
  assert.equal(await chain.verify(certificate, CONTENT), true, 'later confirmations do not invalidate a previously issued certificate');
  responses.eth_getTransactionReceipt = null;
  assert.equal(await chain.verify(certificate, CONTENT), false);
});

test('RPC failures and timeout return safe retryable messages without exposing upstream secrets', async t => {
  const secret = 'private-upstream-key-do-not-disclose';
  const badFetches = {
    'network rejection': async () => { throw new Error('https://upstream.invalid/?key=' + secret); },
    'non-OK response': async () => ({ ok: false, json: async () => ({ error: secret }) }),
    'JSON-RPC error': async () => ({ ok: true, json: async () => ({ error: { message: secret } }) }),
    'bad JSON body': async () => ({ ok: true, json: async () => { throw new SyntaxError(secret); } }),
    'aborted timeout': (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timeout ' + secret)), { once: true });
    }),
  };
  for (const [name, fetchImpl] of Object.entries(badFetches)) await t.test(name, async () => {
    const chain = createClaimPublicChain({ deployment: { chainId: 677, address: CONTRACT }, timeoutMs: 15, fetchImpl });
    await assert.rejects(chain.prepare(values), error => {
      assert.equal(error.status, 503);
      assert.equal(error.claimSafe, true);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('https://upstream.invalid'), false);
      return true;
    });
  });
});
