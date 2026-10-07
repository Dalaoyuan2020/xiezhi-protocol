import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';

export const LOCAL_CHAIN = Object.freeze({ mode: 'local', label: '本地模拟链 · 非主网', chainId: 1337 });
async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function save(file, value) { const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`; await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file); }

/** Private in-process EVM. No HTTP RPC, no external network, no mainnet wallet or funds. */
export function createClaimLedger({ dataDir }) {
  const folder = path.join(dataDir, 'claim-local-chain');
  let ready, ganacheProvider, provider, contract, manifest, queue = Promise.resolve();
  async function initialize() {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    let identity = await json(path.join(folder, 'development-wallet.json'));
    if (!identity) { identity = { seed: randomBytes(32).toString('hex'), purpose: 'local-development-only' }; await save(path.join(folder, 'development-wallet.json'), identity); }
    const ganache = (await import('ganache')).default;
    ganacheProvider = ganache.provider({ chain: { chainId: 1337, networkId: 1337, hardfork: 'shanghai' },
      wallet: { seed: identity.seed, totalAccounts: 1, defaultBalance: 1000 },
      database: { dbPath: path.join(folder, 'database') }, logging: { quiet: true }, miner: { instamine: 'eager' },
    });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const signer = await provider.getSigner();
    const artifact = JSON.parse(await readFile(new URL('../../chain/artifacts/ActionRegistry.json', import.meta.url), 'utf8'));
    manifest = await json(path.join(folder, 'registry.json'));
    if (manifest) {
      if (manifest.chainId !== 1337 || await provider.getCode(manifest.contractAddress) === '0x') throw new Error('Local chain registry unavailable; stored data preserved');
      contract = new ethers.Contract(manifest.contractAddress, artifact.abi, signer);
    } else {
      contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy();
      await contract.waitForDeployment();
      const receipt = await contract.deploymentTransaction().wait();
      manifest = { ...LOCAL_CHAIN, contractAddress: await contract.getAddress(), deploymentBlock: receipt.blockNumber };
      await save(path.join(folder, 'registry.json'), manifest);
    }
  }
  async function ensure() { if (!ready) ready = initialize(); await ready; }
  function serialized(fn) { const next = queue.then(fn); queue = next.catch(() => {}); return next; }
  async function status() {
    await ensure();
    const latest = Number(await ganacheProvider.request({ method: 'eth_blockNumber', params: [] }));
    const blocks = [];
    for (let n = latest; n >= Math.max(0, latest - 5); n--) {
      const block = await ganacheProvider.request({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] });
      blocks.push({ number: n, hash: block.hash, timestamp: Number(block.timestamp), transactionCount: block.transactions.length });
    }
    const logs = await contract.queryFilter(contract.filters.Recorded(), Math.max(manifest.deploymentBlock, latest - 100), latest);
    const transactions = logs.slice(-12).reverse().map(log => ({ hash: log.transactionHash, blockNumber: log.blockNumber, contentHash: log.args.content }));
    return { ...LOCAL_CHAIN, contractAddress: manifest.contractAddress, blockNumber: latest, blocks, transactions };
  }
  async function find(contentHash) {
    const logs = await contract.queryFilter(contract.filters.Recorded(), manifest.deploymentBlock, 'latest');
    return logs.find(log => log.args.content === contentHash);
  }
  async function record({ contentHash, subjectHash }) {
    return serialized(async () => {
      await ensure();
      // Retrying after a dropped response or a process restart must not add a duplicate action.
      let log = await find(contentHash), receipt;
      if (log) receipt = await provider.getTransactionReceipt(log.transactionHash);
      else {
        const transaction = await contract.record(subjectHash, ethers.encodeBytes32String('CLAIM'), contentHash,
          ethers.ZeroHash, ethers.id('email-claim-material-v1'), 0);
        receipt = await transaction.wait();
      }
      return { ...LOCAL_CHAIN, contractAddress: manifest.contractAddress, transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, contentHash };
    });
  }
  async function verify(receipt, hash) {
    await ensure();
    if (!receipt || receipt.chainId !== 1337 || receipt.mode !== 'local' || receipt.label !== LOCAL_CHAIN.label || receipt.contentHash !== hash || receipt.contractAddress !== manifest.contractAddress || !ethers.isHexString(receipt.transactionHash, 32)) return false;
    const transaction = await provider.getTransactionReceipt(receipt.transactionHash);
    if (!transaction || transaction.status !== 1 || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber) return false;
    return transaction.logs.some(log => {
      if (log.address.toLowerCase() !== manifest.contractAddress.toLowerCase()) return false;
      try { const event = contract.interface.parseLog(log); return event?.name === 'Recorded' && event.args.content === hash && event.args.kind === ethers.encodeBytes32String('CLAIM'); } catch { return false; }
    });
  }
  return { status, record, verify, close: async () => { await queue; if (ready) { await ready.catch(() => {}); provider?.destroy(); await ganacheProvider?.disconnect(); } } };
}
