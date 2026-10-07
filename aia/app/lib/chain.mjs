import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Interface, JsonRpcProvider, getAddress, verifyMessage, id, encodeBytes32String, toQuantity, ZeroHash } from 'ethers';

const CHAIN_DIRECTORY = new URL('../../chain/', import.meta.url);
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
const RULE = 'aia-v1-sha256';
const KINDS = new Set(['SUBMIT', 'REVIEW', 'REPRODUCE', 'CLAIM']);
const NETWORKS = Object.freeze({
  mainnet: { chainId: 677, name: 'BOT Chain Mainnet', label: 'BOT 主网 · 677', rpcUrl: 'https://rpc.botchain.ai', explorerUrl: 'https://scan.botchain.ai', deployment: 'botchain.json' },
  testnet: { chainId: 968, name: 'BOT Chain Testnet', label: 'BOT 测试网 · 968', rpcUrl: 'https://rpc.bohr.life', explorerUrl: 'https://scan.bohr.life', deployment: 'botchain-testnet.json' }
});
const PREFIX = 'AIA Wallet Association v1\n';
const SUFFIX = '\nThis signature links wallet control to your AIA account. It does not prove academic identity, transfer funds, or approve a transaction.';
function failure(code, message) { return Object.assign(new Error(message), { code, isAiaChainError: true }); }
function networkOf(network = 'mainnet') {
  if (!Object.hasOwn(NETWORKS, network)) throw failure('INVALID_NETWORK', '仅支持 mainnet 或 testnet，不能自动切换网络。');
  return NETWORKS[network];
}
function addressOf(value) {
  if (!ADDRESS.test(value || '') || /^0x0{40}$/i.test(value)) throw failure('INVALID_ADDRESS', '钱包或合约地址无效。');
  try { return getAddress(value); } catch { throw failure('INVALID_ADDRESS', '钱包或合约地址校验失败。'); }
}
function userOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) throw failure('INVALID_USER', '缺少有效的服务端账号标识。');
  return value;
}
function hashOf(value) {
  const hash = typeof value === 'string' && /^[\da-f]{64}$/i.test(value) ? '0x' + value : value;
  if (!HASH.test(hash || '')) throw failure('INVALID_CONTENT_HASH', '内容摘要必须是服务端计算的 SHA-256（32 字节）。');
  return hash.toLowerCase();
}
function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('INVALID_ORIGIN', '签名来源必须是完整的网站 origin。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw failure('INVALID_ORIGIN', '签名来源只能包含 HTTP(S) 协议、域名及端口。');
  return { origin: url.origin, domain: url.host };
}
function same(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function iso(value, label) {
  const number = Date.parse(value);
  if (!Number.isFinite(number)) throw failure('INVALID_CHALLENGE', label + '无效。');
  return new Date(number).toISOString();
}
function challengePayload(value) {
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(value.id)) throw failure('INVALID_CHALLENGE', '签名挑战标识无效。');
  if (typeof value.nonce !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(value.nonce)) throw failure('INVALID_CHALLENGE', '签名挑战随机数无效。');
  const source = originOf(value.origin);
  if (value.domain !== undefined && value.domain !== source.domain) throw failure('CHALLENGE_CONTEXT_MISMATCH', '签名域名与来源不一致。');
  return { purpose: 'aia-wallet-association-v1', id: value.id, userId: userOf(value.userId), address: addressOf(value.address), origin: source.origin, domain: source.domain, nonce: value.nonce, issuedAt: iso(value.issuedAt, '签发时间'), expiresAt: iso(value.expiresAt, '过期时间') };
}
function messageOf(payload) { return PREFIX + JSON.stringify(payload) + SUFFIX; }
function checkTime(payload, now) {
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (issued > now + 30000 || expires <= issued || expires - issued > 10 * 60 * 1000) throw failure('INVALID_CHALLENGE_TIME', '签名挑战有效期无效。');
  if (expires <= now) throw failure('CHALLENGE_EXPIRED', '签名挑战已过期，请重新获取。');
}

/** Public config only. Missing deployment stays unavailable; never selects a different chain. */
export async function getChainConfig(network = 'mainnet', dependencies = {}) {
  const settings = networkOf(network);
  const base = { network, key: network, chainId: settings.chainId, chainIdHex: toQuantity(settings.chainId), name: settings.name, label: settings.label, rpcUrl: settings.rpcUrl, explorerUrl: settings.explorerUrl, available: false, address: null, deployBlock: null, rule: RULE, subjectScheme: 'keccak256(aia-user:<userId>)', contentHashScheme: 'sha256', proofMeaning: '公开行为声明；不证明学术身份、原创性或科研结论。', addEthereumChain: { chainId: toQuantity(settings.chainId), chainName: settings.name, nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 }, rpcUrls: [settings.rpcUrl], blockExplorerUrls: [settings.explorerUrl] } };
  const read = dependencies.readFile || readFile;
  let deployment;
  try { deployment = JSON.parse(await read(new URL('deployments/' + settings.deployment, CHAIN_DIRECTORY), 'utf8')); }
  catch (error) { return { ...base, unavailableReason: error.code === 'ENOENT' ? '所选网络尚未部署。' : '部署清单无法读取或解析。' }; }
  try {
    if (deployment.chainId !== settings.chainId || !Number.isSafeInteger(deployment.block) || deployment.block < 0) throw new Error('部署网络或区块无效');
    const address = addressOf(deployment.address);
    const artifact = JSON.parse(await read(new URL('artifacts/ActionRegistry.json', CHAIN_DIRECTORY), 'utf8'));
    if (!Array.isArray(artifact.abi)) throw new Error('ABI缺失');
    const abi = new Interface(artifact.abi);
    if (!abi.getFunction('record(bytes32,bytes32,bytes32,bytes32,bytes32,uint16)') || !abi.getEvent('Recorded(uint256,bytes32,bytes32,bytes32,bytes32,uint16,address)')) throw new Error('ABI不兼容');
    return { ...base, available: true, address, deployBlock: deployment.block, abi: artifact.abi };
  } catch { return { ...base, unavailableReason: '部署清单或 ActionRegistry ABI 校验失败。' }; }
}

/** Backend must persist this complete challenge, then enforce current user/origin and one-time consumption. */
export function createWalletChallenge(args, dependencies = {}) {
  const now = dependencies.now ? dependencies.now() : Date.now();
  const payload = challengePayload({ ...args, id: randomUUID(), nonce: args.nonce || randomBytes(32).toString('hex'), issuedAt: args.issuedAt || new Date(now).toISOString(), expiresAt: args.expiresAt || new Date(now + 5 * 60 * 1000).toISOString() });
  checkTime(payload, now);
  return { ...payload, message: messageOf(payload) };
}

/** EIP-191 personal_sign proves wallet control, never ownership of an academic identity. */
export function verifyWalletSignature(args, dependencies = {}) {
  const challenge = args.challenge;
  const message = args.message || challenge?.message;
  if (typeof message !== 'string' || !message.startsWith(PREFIX) || !message.endsWith(SUFFIX)) throw failure('INVALID_CHALLENGE', '不是 AIA 钱包关联挑战。');
  let payload;
  try { payload = challengePayload(JSON.parse(message.slice(PREFIX.length, -SUFFIX.length))); }
  catch (error) { throw failure(error.code || 'INVALID_CHALLENGE', '签名挑战格式或上下文无效。'); }
  if (message !== messageOf(payload)) throw failure('CHALLENGE_CONTEXT_MISMATCH', '签名挑战内容不匹配。');
  if (challenge && (challenge.message !== message || messageOf(challengePayload(challenge)) !== message)) throw failure('CHALLENGE_CONTEXT_MISMATCH', '签名与保存的挑战不一致。');
  if ((args.userId !== undefined && args.userId !== payload.userId) || (args.address !== undefined && addressOf(args.address) !== payload.address) || (args.origin !== undefined && originOf(args.origin).origin !== payload.origin)) throw failure('CHALLENGE_CONTEXT_MISMATCH', '签名不属于当前账号、钱包或来源。');
  checkTime(payload, dependencies.now ? dependencies.now() : Date.now());
  let recovered;
  try { recovered = getAddress(verifyMessage(message, args.signature)); } catch { throw failure('INVALID_SIGNATURE', '钱包签名无效。'); }
  if (recovered !== payload.address) throw failure('SIGNER_MISMATCH', '签名地址与挑战钱包不一致。');
  return { valid: true, address: recovered, userId: payload.userId, origin: payload.origin, challengeId: payload.id, nonce: payload.nonce };
}

function recordOf(args) {
  if (!KINDS.has(args.kind)) throw failure('INVALID_RECORD_KIND', '本版本仅支持研究提交、审阅、复现和认领声明。');
  if (args.rule !== undefined && args.rule !== RULE) throw failure('INVALID_RULE', '应用声明规则必须为 ' + RULE + '。');
  return { subject: id('aia-user:' + userOf(args.userId)), kind: args.kind, kindHash: encodeBytes32String(args.kind), contentHash: hashOf(args.contentHash), org: ZeroHash, rule: RULE, ruleHash: encodeBytes32String(RULE), value: 0 };
}
async function prepared(args, dependencies) {
  const config = await getChainConfig(args.network || 'mainnet', dependencies);
  if (!config.available) throw failure('DEPLOYMENT_UNAVAILABLE', config.unavailableReason);
  const wallet = addressOf(args.wallet || args.walletAddress);
  const record = recordOf(args);
  const abi = new Interface(config.abi);
  const data = abi.encodeFunctionData('record', [record.subject, record.kindHash, record.contentHash, record.org, record.ruleHash, 0]);
  return { transaction: { from: wallet, to: config.address, data, value: '0x0' }, network: config, record };
}
export async function buildRecordTransaction(args, dependencies = {}) { return prepared(args, dependencies); }

async function bounded(operation, timeout) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('RPC_TIMEOUT', '链上查询超时，请稍后重试确认。')), timeout); })]); }
  finally { clearTimeout(timer); }
}

/** Read-only: independently verifies exact calldata, successful canonical receipt and emitted event. */
export async function verifyRecordTransaction(args, dependencies = {}) {
  if (!HASH.test(args.txHash || '')) throw failure('INVALID_TRANSACTION_HASH', '交易哈希无效。');
  const expected = await prepared(args, dependencies);
  const config = expected.network;
  const txHash = args.txHash.toLowerCase();
  const provider = dependencies.provider || (dependencies.createProvider ? dependencies.createProvider(config) : new JsonRpcProvider(config.rpcUrl, undefined, { batchMaxCount: 1 }));
  const ownProvider = !dependencies.provider;
  const call = operation => bounded(operation, dependencies.timeoutMs || 12000);
  try {
    const actualNetwork = await call(() => provider.getNetwork());
    if (BigInt(actualNetwork.chainId) !== BigInt(config.chainId)) throw failure('NETWORK_MISMATCH', 'RPC 网络与所选网络不一致。');
    const [tx, receipt] = await Promise.all([call(() => provider.getTransaction(txHash)), call(() => provider.getTransactionReceipt(txHash))]);
    if (!tx || !receipt || receipt.blockNumber == null) throw failure('TRANSACTION_PENDING', '交易尚未确认或当前 RPC 尚未查到，请稍后重试。');
    if (Number(receipt.status) !== 1) throw failure('TRANSACTION_REVERTED', '链上交易未成功，不能确认为声明存证。');
    if (!same(tx.hash, txHash) || !same(receipt.hash || receipt.transactionHash, txHash)) throw failure('TRANSACTION_MISMATCH', 'RPC 返回了不同交易。');
    if (BigInt(tx.chainId) !== BigInt(config.chainId)) throw failure('NETWORK_MISMATCH', '交易签名使用了不同网络。');
    if (!same(tx.from, expected.transaction.from) || !same(receipt.from, expected.transaction.from)) throw failure('SENDER_MISMATCH', '交易发送者不是已关联的钱包。');
    if (!same(tx.to, config.address) || !same(receipt.to, config.address)) throw failure('CONTRACT_MISMATCH', '交易没有发往配置的登记合约。');
    if (BigInt(tx.value) !== 0n || !same(tx.data, expected.transaction.data)) throw failure('RECORD_MISMATCH', '交易内容与当前账号、记录类型、哈希或规则不一致。');
    if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < config.deployBlock || !HASH.test(receipt.blockHash || '')) throw failure('INVALID_RECEIPT', '交易区块元数据无效。');
    const [code, block] = await Promise.all([call(() => provider.getCode(config.address, receipt.blockNumber)), call(() => provider.getBlock(receipt.blockNumber))]);
    if (!/^0x[\da-f]+$/i.test(code || '') || /^0x0*$/i.test(code)) throw failure('CONTRACT_UNAVAILABLE', '交易区块中的登记地址没有合约代码。');
    if (!block || !same(block.hash, receipt.blockHash)) throw failure('RECEIPT_NOT_CANONICAL', '交易所在区块尚未能确认，请稍后重试。');
    const abi = new Interface(config.abi);
    const decoded = abi.parseTransaction({ data: tx.data, value: tx.value });
    if (!decoded || decoded.name !== 'record') throw failure('RECORD_MISMATCH', '交易不是行为登记调用。');
    const events = [];
    for (const log of receipt.logs || []) {
      if (!same(log.address, config.address)) continue;
      let parsed;
      try { parsed = abi.parseLog(log); } catch { continue; }
      if (!parsed || parsed.name !== 'Recorded') continue;
      const value = parsed.args;
      if (same(value.subject, expected.record.subject) && same(value.kind, expected.record.kindHash) && same(value.content, expected.record.contentHash) && same(value.org, ZeroHash) && BigInt(value.value) === 0n && same(value.recorder, expected.transaction.from)) events.push({ log, value });
    }
    if (events.length !== 1) throw failure('EVENT_MISMATCH', '没有唯一匹配当前声明的合约事件。');
    const { log, value } = events[0];
    const logIndex = log.index ?? log.logIndex;
    if (!Number.isSafeInteger(logIndex) || logIndex < 0 || (log.transactionHash && !same(log.transactionHash, txHash)) || (log.blockHash && !same(log.blockHash, receipt.blockHash)) || log.removed === true) throw failure('INVALID_RECEIPT', '事件定位信息无效。');
    return { verified: true, status: 'confirmed', network: config.network, chainId: config.chainId, txHash, contractAddress: config.address, wallet: expected.transaction.from, subject: expected.record.subject, kind: expected.record.kind, contentHash: expected.record.contentHash, rule: expected.record.rule, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, logIndex, actionId: value.id.toString(), explorerUrl: config.explorerUrl + '/tx/' + txHash, confirmedAt: new Date(dependencies.now ? dependencies.now() : Date.now()).toISOString() };
  } catch (error) {
    if (error.isAiaChainError) throw error;
    throw failure('RPC_UNAVAILABLE', '链上查询失败，请稍后重试确认。');
  } finally { if (ownProvider && typeof provider.destroy === 'function') provider.destroy(); }
}
