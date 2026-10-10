const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
const { ethers } = require('ethers');
const ganache = require('ganache');
const onchain = require('../onchain.js');

const root = path.join(__dirname, '..', '..');
const artifact = JSON.parse(readFileSync(path.join(root, 'aia/chain/artifacts/ActionRegistry.json'), 'utf8'));

test('network selection defaults to mainnet 677 and matches deployment files', () => {
  assert.equal(onchain.pickNetwork('').chainId, 677);
  assert.equal(onchain.pickNetwork('?network=testnet').chainId, 968);
  assert.equal(onchain.pickNetwork('?network=other').key, 'mainnet');
  for (const network of Object.values(onchain.NETWORKS)) {
    const deployment = JSON.parse(readFileSync(path.join(root, 'aia', network.deployment), 'utf8'));
    assert.equal(deployment.chainId, network.chainId);
    assert.equal(BigInt(network.hex), BigInt(network.chainId));
  }
});

test('embedded ABI matches the deployed ActionRegistry artifact', () => {
  const page = new ethers.Interface(onchain.ABI);
  const full = new ethers.Interface(artifact.abi);
  for (const name of ['record', 'actionsByContent']) assert.equal(page.getFunction(name).format('full'), full.getFunction(name).format('full'));
  assert.equal(page.getEvent('Recorded').topicHash, full.getEvent('Recorded').topicHash);
});

test('fingerprint is the SHA-256 of the exact bytes', async () => {
  const bytes = new TextEncoder().encode('10.1000/xyz123 示例论文');
  const expected = '0x' + require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  assert.equal(await onchain.sha256(bytes, webcrypto.subtle), expected);
});

test('ORCID is optional and checksum-validated', () => {
  assert.equal(onchain.normalizeOrcid(''), '');
  assert.equal(onchain.normalizeOrcid(' https://orcid.org/0009-0008-5473-5367 '), '0009-0008-5473-5367');
  assert.equal(onchain.normalizeOrcid('0000-0002-1694-233x'), '0000-0002-1694-233X');
  assert.throws(() => onchain.normalizeOrcid('0009-0008-5473-5368'), /ORCID/);
  assert.throws(() => onchain.normalizeOrcid('12345'), /ORCID/);
  assert.equal(onchain.subjectSeed('0xABCDEF', ''), 'wallet:0xabcdef');
  assert.equal(onchain.subjectSeed('0xABCDEF', '0009-0008-5473-5367'), 'orcid:0009-0008-5473-5367');
});

test('wallet errors become plain Chinese guidance', () => {
  assert.match(onchain.explain({ code: 4001, message: 'User rejected the request.' }), /取消/);
  assert.match(onchain.explain({ code: 'ACTION_REJECTED' }), /取消/);
  assert.match(onchain.explain({ code: 'INSUFFICIENT_FUNDS' }), /0\.005 BOT/);
  assert.match(onchain.explain({ info: { error: { code: -32000, message: 'insufficient funds for gas * price + value' } } }), /gas/);
  assert.match(onchain.explain({ code: -32002 }), /待处理/);
  assert.equal(onchain.formatBot(4445524200000000000n / 10n), '0.4445 BOT');
});

test('a user wallet can record a CLAIM and read it back by content (ganache, chain 677)', async () => {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { chainId: 677, hardfork: 'merge' }, wallet: { totalAccounts: 2 } }));
  const [deployer, other] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const registry = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy();
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  const content = await onchain.sha256(new TextEncoder().encode('同一份稿件'), webcrypto.subtle);

  for (const [signer, orcid] of [[deployer, ''], [other, '0009-0008-5473-5367']]) {
    const contract = new ethers.Contract(address, onchain.ABI, signer);
    const receipt = await (await contract.record(...onchain.buildRecordArgs(ethers, signer.address, orcid, content))).wait();
    assert.equal(receipt.status, 1);
    const recorded = receipt.logs.map(entry => contract.interface.parseLog(entry)).find(entry => entry?.name === 'Recorded');
    assert.equal(recorded.args.recorder, signer.address);
  }
  const actions = await new ethers.Contract(address, onchain.ABI, provider).actionsByContent(content);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map(action => action.recorder), [deployer.address, other.address]);
  assert.equal(ethers.decodeBytes32String(actions[0].kind), 'CLAIM');
  assert.equal(ethers.decodeBytes32String(actions[0].rule), 'wallet-web-v1');
  assert.equal(actions[1].subject, ethers.keccak256(ethers.toUtf8Bytes('orcid:0009-0008-5473-5367')));
  assert.throws(() => onchain.buildRecordArgs(ethers, deployer.address, '', 'not-a-hash'), /指纹/);
});
