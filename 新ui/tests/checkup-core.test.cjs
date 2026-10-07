'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const core = require('../checkup-core.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../aia/product/mock_cases.json'), 'utf8'));
const now = '2026-10-07T03:00:00.000Z';
const normalized = index => core.normalizeCase(data.cases[index], data);
const copy = value => JSON.parse(JSON.stringify(value));

test('all repository cases keep exact evidence and use independently summed dimensions', () => {
  assert.equal(Object.isFrozen(core), true);
  assert.equal(core.DIMENSIONS.length, 5);
  assert.deepEqual(data.cases.map((_, index) => normalized(index).score), [70, 78, 83, 9]);
  const synthetic = normalized(3);
  assert.equal(synthetic.reportedScore, 21);
  assert.equal(synthetic.scoreMismatch, true);
  assert.equal(synthetic.synthetic, true);
  assert.equal(synthetic.orcid, null);
  assert.ok(synthetic.dims.every(dim => dim.sourceUrl === null));
  assert.equal(normalized(0).dims[0].evidence, 'ORCID 有；主领域 Engineering 占 100%');
  assert.ok(normalized(0).dims.every(dim => /^https:\/\/api\.openalex\.org\//.test(dim.sourceUrl)));
});

test('rejects missing, additional, malformed and out-of-range dimensions', () => {
  for (const bad of ['21/20（不合法）', '-1/20（不合法）', '1.5/20（不合法）', '10oops/20（不合法）',
    '10/20', '10/20（）', '10/20（ ）', ' 10/20（说明）', '10/20（说明）尾巴', '01/20（说明）']) {
    const raw = copy(data.cases[0]);
    raw.dims['身份清晰度'] = bad;
    assert.throws(() => core.normalizeCase(raw), /整数分数/);
  }
  const missing = copy(data.cases[0]);
  delete missing.dims['身份清晰度'];
  assert.throws(() => core.normalizeCase(missing), /五个维度/);
  const additional = copy(data.cases[0]);
  additional.dims['未知维度'] = '10/20（说明）';
  assert.throws(() => core.normalizeCase(additional), /五个维度/);
});

test('only constructs allowlisted real-source URLs and preserves raw snapshot', () => {
  const raw = copy(data.cases[0]);
  raw.orcid = 'javascript:alert(1)';
  raw.sourceUrl = 'https://attacker.example/';
  const item = core.normalizeCase(raw);
  assert.equal(item.orcid, null);
  assert.ok(item.dims.every(dim => new URL(dim.sourceUrl).host === 'api.openalex.org'));
  assert.deepEqual(item.raw, raw);
  raw.name = 'Changed later';
  assert.equal(item.name, data.cases[0].name);
  assert.equal(item.raw.name, data.cases[0].name);
  assert.ok(Object.isFrozen(item.raw));
  assert.throws(() => core.normalizeCase({ ...raw, openalex: 'https://attacker.example/A1' }), /OpenAlex/);
});

test('canonical JSON and real SHA-256 are deterministic across key ordering', async () => {
  assert.equal(core.canonicalJSON({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(await core.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await core.sha256(core.canonicalJSON({ b: 2, a: 1 })), await core.sha256(core.canonicalJSON({ a: 1, b: 2 })));
  assert.throws(() => core.canonicalJSON({ bad: NaN }), /非有限/);
  assert.throws(() => core.canonicalJSON({ bad: undefined }), /JSON/);
  assert.throws(() => core.canonicalJSON(Array(2)), /稀疏/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => core.canonicalJSON(cycle), /循环/);
});

test('receipts bind actual snapshots and published rules, without fake chain identifiers', async () => {
  const item = normalized(0);
  const receipt = await core.createReceipt(item, { now });
  assert.deepEqual(receipt, await core.createReceipt(item, { now }));
  assert.equal(receipt.simulation, true);
  assert.equal(receipt.chainStatus, 'not-submitted');
  assert.equal(receipt.score, 70);
  assert.equal(receipt.rulesHash, createHash('sha256').update(core.canonicalJSON(core.RULES)).digest('hex'));
  assert.equal(receipt.snapshotHash, createHash('sha256').update(core.canonicalJSON({
    case: item.raw, generated: item.generated, source: item.source, claim: null
  })).digest('hex'));
  assert.equal((await core.verifyReceipt(receipt, item)).valid, true);
  assert.ok(!Object.keys(receipt).some(key => /transaction|block|wallet|signature|txHash/i.test(key)));
  const changedRaw = copy(data.cases[0]);
  changedRaw.note += ' extra source text';
  const changed = core.normalizeCase(changedRaw, data);
  const newReceipt = await core.createReceipt(changed, { now });
  assert.notEqual(receipt.snapshotHash, newReceipt.snapshotHash);
  assert.equal((await core.verifyReceipt(receipt, changed)).checks.snapshotHash, false);
  assert.equal((await core.verifyReceipt(receipt, normalized(1))).valid, false);
});

test('tampered receipt values, even rehashed, fail comparison to reference snapshot', async () => {
  const item = normalized(0);
  const receipt = await core.createReceipt(item, { now });
  const tampered = { ...receipt, score: 100 };
  let check = await core.verifyReceipt(tampered, item);
  assert.equal(check.valid, false);
  assert.equal(check.checks.score, false);
  assert.equal(check.checks.receiptHash, false);
  const { receiptHash: ignored, ...unsigned } = tampered;
  tampered.receiptHash = await core.sha256(core.canonicalJSON(unsigned));
  check = await core.verifyReceipt(tampered, item);
  assert.equal(check.checks.receiptHash, true);
  assert.equal(check.valid, false);
  const spoofed = { ...receipt, chainStatus: 'confirmed', block: 123 };
  assert.equal((await core.verifyReceipt(spoofed, item)).valid, false);
  assert.equal((await core.verifyReceipt(null, item)).valid, false);
  const inconsistent = { ...item, score: 100 };
  await assert.rejects(core.createReceipt(inconsistent, { now }), /原始快照不一致/);
});

test('local claim is idempotent, leaves source unchanged, and binds a new snapshot hash', async () => {
  const item = normalized(0);
  const before = copy(item);
  const claimed = core.recomputeAfterClaim(item);
  assert.equal(claimed.score, 70);
  assert.equal(claimed.baseScore, 70);
  assert.equal(claimed.works, 2);
  assert.equal(claimed.localWorks, 3);
  assert.equal(claimed.claimSimulation, true);
  assert.match(claimed.recalculationNotice, /不是重新运行完整 v0/);
  assert.deepEqual(item, before);
  assert.deepEqual(claimed.raw, item.raw);
  assert.deepEqual(core.recomputeAfterClaim(claimed), claimed);
  const originalReceipt = await core.createReceipt(item, { now });
  const claimReceipt = await core.createReceipt(claimed, { now });
  assert.notEqual(originalReceipt.snapshotHash, claimReceipt.snapshotHash);
  assert.equal(claimReceipt.subjectIdHash, originalReceipt.subjectIdHash);
  assert.equal((await core.verifyReceipt(claimReceipt, claimed)).valid, true);
  assert.equal((await core.verifyReceipt(originalReceipt, claimed)).valid, false);
  assert.equal((await core.verifyReceipt(claimReceipt, item, { claim: claimed.claim })).valid, true);
  await assert.rejects(core.createReceipt(item, { claim: { ...claimed.claim, paper: 'another paper' }, now }), /认领声明/);
  assert.throws(() => core.recomputeAfterClaim(normalized(1)), /没有可演示认领/);
  assert.throws(() => core.recomputeAfterClaim(normalized(3)), /没有可演示认领/);
});

test('a missing Web Crypto implementation fails clearly instead of inventing hashes', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../checkup-core.js'), 'utf8');
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(source, context);
  await assert.rejects(context.ScholarCheckupCore.sha256('hello'), /缺少 Web Crypto SHA-256/);
  context.crypto = webcrypto;
  assert.equal(await context.ScholarCheckupCore.sha256('abc'), await core.sha256('abc'));
});
