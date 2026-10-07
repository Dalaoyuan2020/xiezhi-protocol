import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

const RPC = 'https://rpc.botchain.ai';
const EXPLORER = 'https://scan.botchain.ai';
const ABI = [
  'function record(bytes32 subject, bytes32 kind, bytes32 content, bytes32 org, bytes32 rule, uint16 value) returns (uint256)',
  'event Recorded(uint256 indexed id, bytes32 indexed subject, bytes32 indexed kind, bytes32 content, bytes32 org, uint16 value, address recorder)',
];
const iface = new ethers.Interface(ABI);
const KIND = ethers.encodeBytes32String('CLAIM');
const RULE = ethers.id('email-claim-material-v1');
const hex32 = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const equalHex = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
function fail(status, message) { throw Object.assign(new Error(message), { status, claimSafe: true }); }
function address(value) {
  if (typeof value !== 'string' || !ethers.isAddress(value) || equalHex(value, ethers.ZeroAddress)) fail(400, '钱包地址无效。');
  return ethers.getAddress(value);
}
function blockNumber(value) {
  if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value)) fail(503, '主网节点返回的区块信息不完整，请稍后重试。');
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) fail(503, '主网区块信息无效。');
  return number;
}

/** Prepare unsigned transactions and verify receipts. This module never signs or broadcasts. */
export function createClaimPublicChain({ fetchImpl = fetch, deployment, timeoutMs = 12000 } = {}) {
  let manifest = deployment;
  if (manifest === undefined) {
    try { manifest = JSON.parse(readFileSync(new URL('../../chain/deployments/botchain.json', import.meta.url), 'utf8')); }
    catch { manifest = null; }
  }
  const available = manifest?.chainId === 677 && ethers.isAddress(manifest?.address || '') && !equalHex(manifest.address, ethers.ZeroAddress);
  const contractAddress = available ? ethers.getAddress(manifest.address) : null;
  const network = {
    available, mode: 'mainnet', network: 'BOT Chain mainnet', chainId: 677, label: 'BOT Chain 主网',
    contractAddress, rpcUrl: RPC, explorer: EXPLORER,
    walletNetwork: { chainId: '0x2a5', chainName: 'BOT Chain', nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] },
  };
  let sequence = 0;
  const config = () => structuredClone(network);
  async function rpc(method, params = []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(RPC, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
      if (!response.ok) fail(503, 'BOT 主网节点暂时不可用，请稍后重试。');
      const data = await response.json();
      if (!data || data.error || !Object.hasOwn(data, 'result')) fail(503, 'BOT 主网节点未返回有效结果，请稍后重试。');
      return data.result;
    } catch (error) {
      if (error.claimSafe) throw error;
      fail(503, 'BOT 主网连接暂时中断，请稍后重试；不会因此重复发起交易。');
    } finally { clearTimeout(timer); }
  }
  async function ready() {
    if (!available) fail(503, 'BOT 主网合约尚未配置，暂时不能提交主网存证。');
    const chainId = await rpc('eth_chainId');
    if (blockNumber(chainId) !== 677) fail(503, '节点网络与 BOT 主网不一致，已停止本次核验。');
    const code = await rpc('eth_getCode', [contractAddress, 'latest']);
    if (typeof code !== 'string' || !/^0x[\da-f]+$/i.test(code) || /^0x0*$/i.test(code)) fail(503, '指定地址没有可用的主网登记合约。');
  }
  function input({ contentHash, subjectHash, walletAddress }) {
    if (!hex32(contentHash) || !hex32(subjectHash)) fail(400, '待存证的指纹或学者标识无效。');
    return { contentHash, subjectHash, walletAddress: address(walletAddress),
      data: iface.encodeFunctionData('record', [subjectHash, KIND, contentHash, ethers.ZeroHash, RULE, 0]) };
  }
  async function prepare(values) {
    const expected = input(values);
    await ready();
    return { ...config(), contentHash: expected.contentHash, subjectHash: expected.subjectHash, walletAddress: expected.walletAddress,
      transaction: { from: expected.walletAddress, to: contractAddress, data: expected.data, value: '0x0', chainId: '0x2a5' } };
  }
  async function confirm({ transactionHash, ...values }) {
    if (!hex32(transactionHash)) fail(400, '交易号格式无效。');
    const expected = input(values);
    await ready();
    const [receipt, transaction] = await Promise.all([
      rpc('eth_getTransactionReceipt', [transactionHash]), rpc('eth_getTransactionByHash', [transactionHash]),
    ]);
    if (transaction && (!equalHex(transaction.hash, transactionHash) || !equalHex(transaction.from, expected.walletAddress) ||
      !equalHex(transaction.to, contractAddress) || !equalHex(transaction.input, expected.data) || blockNumber(transaction.value) !== 0)) {
      fail(422, '这笔交易与当前钱包、学者或声明指纹不匹配，不能用于完成认领。');
    }
    if (!receipt || receipt.blockNumber === null || !transaction) return { pending: true, transactionHash };
    if (!equalHex(receipt.transactionHash, transactionHash) || !equalHex(receipt.to, contractAddress) ||
      !equalHex(receipt.from, expected.walletAddress)) fail(422, '主网回执与待核验交易不匹配。');
    if (blockNumber(receipt.status) !== 1) fail(422, '主网交易执行失败，没有完成存证；请检查钱包中的交易详情。');
    const minedAt = blockNumber(receipt.blockNumber);
    if (!hex32(receipt.blockHash)) fail(503, '主网回执缺少有效区块指纹，请稍后重试。');
    if ((transaction.chainId !== undefined && blockNumber(transaction.chainId) !== 677) ||
      (transaction.blockHash && !equalHex(transaction.blockHash, receipt.blockHash)) ||
      (transaction.blockNumber !== undefined && transaction.blockNumber !== null && blockNumber(transaction.blockNumber) !== minedAt)) {
      fail(422, '交易与回执的网络或区块位置不一致。');
    }
    const [canonicalBlock, latestHex] = await Promise.all([
      rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_blockNumber'),
    ]);
    const latest = blockNumber(latestHex);
    if (!canonicalBlock || !equalHex(canonicalBlock.hash, receipt.blockHash) || latest < minedAt) return { pending: true, transactionHash };
    const matched = Array.isArray(receipt.logs) && receipt.logs.map(log => {
      if (!log || log.removed || !equalHex(log.address, contractAddress)) return null;
      try { return iface.parseLog(log); } catch { return null; }
    }).find(event => event?.name === 'Recorded' && equalHex(event.args.subject, expected.subjectHash) &&
      equalHex(event.args.kind, KIND) && equalHex(event.args.content, expected.contentHash) &&
      equalHex(event.args.org, ethers.ZeroHash) && event.args.value === 0n && equalHex(event.args.recorder, expected.walletAddress));
    if (!matched) fail(422, '交易回执中没有与当前声明匹配的认领记录。');
    return { mode: 'mainnet', network: network.network, chainId: 677, label: network.label, contractAddress,
      transactionHash, blockNumber: minedAt, blockHash: receipt.blockHash, contentHash: expected.contentHash,
      subjectHash: expected.subjectHash, walletAddress: expected.walletAddress, actionId: String(matched.args.id),
      explorerUrl: `${EXPLORER}/tx/${transactionHash}`, confirmations: latest - minedAt + 1 };
  }
  async function verify(receipt, hash) {
    if (!receipt || receipt.mode !== 'mainnet' || receipt.network !== network.network || receipt.chainId !== 677 || receipt.label !== network.label ||
      !equalHex(receipt.contractAddress, contractAddress) || !equalHex(receipt.contentHash, hash) ||
      !hex32(receipt.transactionHash) || !hex32(receipt.subjectHash) || !ethers.isAddress(receipt.walletAddress || '') ||
      !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 1) return false;
    let confirmed;
    try { confirmed = await confirm({ transactionHash: receipt.transactionHash, contentHash: hash, subjectHash: receipt.subjectHash, walletAddress: receipt.walletAddress }); }
    catch (error) { if ([400, 422].includes(error.status)) return false; throw error; }
    return !confirmed.pending && equalHex(confirmed.blockHash, receipt.blockHash) && confirmed.blockNumber === receipt.blockNumber &&
      confirmed.actionId === receipt.actionId && confirmed.explorerUrl === receipt.explorerUrl && receipt.confirmations <= confirmed.confirmations;
  }
  return { config, prepare, confirm, verify };
}
