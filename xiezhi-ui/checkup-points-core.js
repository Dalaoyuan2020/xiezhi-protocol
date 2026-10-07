(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarCheckupPointsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const NETWORKS = Object.freeze({
    mainnet: Object.freeze({ key: 'mainnet', chainId: 677, label: 'BOT 主网 · 677', rpc: 'https://rpc.botchain.ai', explorer: 'https://scan.botchain.ai', deploymentPath: '../chain/deployments/points.json' }),
    testnet: Object.freeze({ key: 'testnet', chainId: 968, label: 'BOT 测试网 · 968', rpc: 'https://rpc.bohr.life', explorer: 'https://scan.bohr.life', deploymentPath: '../chain/deployments/points-testnet.json' })
  });
  const ARTIFACT = '../chain/artifacts/PointsLedger.json';
  const SDK = 'https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm';
  const HASH = /^0x[0-9a-f]{64}$/i;
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const ZERO = '0x' + '0'.repeat(64);
  const UINT_MAX = (1n << 256n) - 1n;
  const errorText = error => error && error.message ? error.message : String(error);
  const aborted = () => Object.assign(new Error('积分读取已取消。'), { name: 'AbortError' });
  function getNetwork(name) {
    if (name === undefined) name = typeof location === 'object' ? new URLSearchParams(location.search).get('network') || 'mainnet' : 'mainnet';
    if (!Object.hasOwn(NETWORKS, name)) throw new Error('积分网络仅支持 mainnet 或 testnet。');
    return NETWORKS[name];
  }
  function integer(value, label, min = 0) {
    if (!Number.isSafeInteger(value) || value < min) throw new Error(label + '无效。');
    return value;
  }
  function uint(value, label) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(label + '不能使用失真的浮点数。');
    if (!/^\d+$/.test(String(value))) throw new Error(label + '不是无符号整数。');
    const number = BigInt(value);
    if (number > UINT_MAX) throw new Error(label + '超过 uint256 范围。');
    return number.toString();
  }
  function validateDeployment(value, network) {
    const config = getNetwork(network);
    if (!value || value.chainId !== config.chainId) throw new Error('积分部署清单网络与 ' + config.label + ' 不一致。');
    if (!ADDRESS.test(value.address || '') || /^0x0{40}$/i.test(value.address)) throw new Error('积分合约地址无效。');
    integer(value.block, '积分部署区块');
    return { chainId: config.chainId, address: value.address, block: value.block, rules: typeof value.rules === 'string' ? value.rules : null, explorer: config.explorer + '/address/' + value.address };
  }
  function deadline(operation, ms, signal) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let done = false, timer;
      const finish = (fn, value) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
        controller.abort(); fn(value);
      };
      const cancel = () => finish(reject, aborted());
      if (signal && signal.aborted) return cancel();
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish(reject, new Error('积分链上读取超时，请重试。')), ms);
      Promise.resolve().then(() => operation(controller.signal)).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  function blockRecord(block, expectedNumber) {
    if (!block || block.number !== expectedNumber || !HASH.test(block.hash || '')) throw new Error('RPC 返回的积分查询区块无效。');
    return { number: expectedNumber, hash: block.hash.toLowerCase(), timestamp: integer(block.timestamp, '积分查询区块时间') };
  }
  function eventRecord(log, kind, subject, deployment, from, to, abi, sdk, network) {
    if (!log || typeof log.address !== 'string' || log.address.toLowerCase() !== deployment.address.toLowerCase() || log.removed === true) throw new Error('积分流水的合约或区块状态无效。');
    const parsed = abi.parseLog(log);
    if (!parsed || parsed.name !== (kind === 'award' ? 'Awarded' : 'Spent')) throw new Error('积分流水事件类型不匹配。');
    const row = parsed.args;
    if (row.subject.toLowerCase() !== subject.toLowerCase()) throw new Error('积分流水属于其他学者。');
    const blockNumber = integer(log.blockNumber, '积分流水区块');
    if (blockNumber < from || blockNumber > to || !HASH.test(log.blockHash || '') || !HASH.test(log.transactionHash || '')) throw new Error('积分流水的区块范围或交易定位无效。');
    const logIndex = integer(log.index ?? log.logIndex, '积分流水日志序号');
    const transactionIndex = integer(log.transactionIndex, '积分流水交易序号');
    if (!HASH.test(row.reason || '') || !HASH.test(row.evidence || '') || !ADDRESS.test(row.issuer || '') || /^0x0{40}$/i.test(row.issuer)) throw new Error('积分流水的原因、证据或发放地址无效。');
    const amount = uint(row.amount, '积分变动');
    if (amount === '0') throw new Error('积分流水含零额变动。');
    let reason = null;
    try { reason = sdk.decodeBytes32String(row.reason) || null; } catch (_) { /* Preserve unfamiliar rules as the original bytes32. */ }
    return { kind, amount, change: (kind === 'spend' ? '-' : '+') + amount, balance: uint(row.balance, '流水后余额'), reason, reasonHash: row.reason, evidence: row.evidence, evidenceAvailable: row.evidence.toLowerCase() !== ZERO, issuer: row.issuer, transactionHash: log.transactionHash.toLowerCase(), blockNumber, blockHash: log.blockHash.toLowerCase(), logIndex, transactionIndex, explorerUrl: network.explorer + '/tx/' + log.transactionHash.toLowerCase() };
  }
  const chronological = (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
  function deduplicate(events) {
    const map = new Map(), blocks = new Map();
    for (const event of events) {
      if (blocks.has(event.blockNumber) && blocks.get(event.blockNumber) !== event.blockHash) throw new Error('同一区块的积分事件指向了不同区块哈希。');
      blocks.set(event.blockNumber, event.blockHash);
      const key = event.transactionHash + ':' + event.logIndex;
      if (map.has(key) && JSON.stringify(map.get(key)) !== JSON.stringify(event)) throw new Error('同一积分事件返回了相互矛盾的内容。');
      map.set(key, event);
    }
    return [...map.values()].sort(chronological);
  }
  function consistent(events, balance, complete) {
    let running = complete ? 0n : null;
    for (const event of events) {
      const delta = BigInt(event.amount) * (event.kind === 'award' ? 1n : -1n);
      if (running !== null && (running + delta < 0n || running + delta !== BigInt(event.balance))) return false;
      running = BigInt(event.balance);
    }
    return running === null || running === BigInt(balance);
  }

  /** Decimal strings are intentional: points are uint256, never a floating-point display balance. */
  function createReader(options) {
    const opts = options || {};
    const network = getNetwork(opts.network);
    const timeout = integer(opts.timeoutMs ?? 12000, '读取超时', 1);
    const chunkSize = integer(opts.chunkSize ?? 2000, '流水分页区块数', 1);
    const maxChunks = integer(opts.maxChunks ?? 20, '流水页数', 1);
    const maxEvents = integer(opts.maxEvents ?? 1000, '流水条数上限', 1);
    const historyTimeout = integer(opts.historyTimeoutMs ?? 20000, '流水读取时限', 1);
    if (timeout > 60000 || chunkSize > 10000 || maxChunks > 50 || maxEvents > 5000 || historyTimeout > 60000) throw new Error('积分读取参数超过允许的有界范围。');
    const fetcher = opts.fetch || ((...args) => fetch(...args));
    const active = new Set();
    let destroyed = false, sdkPromise;
    const base = () => ({ network, deployment: null, subject: null, balance: null, events: [], asOf: null, history: { complete: false, fromBlock: null, toBlock: null, scannedFromBlock: null, reason: null } });
    async function json(path, signal, optional) {
      return deadline(async fetchSignal => {
        const response = await fetcher(path, { signal: fetchSignal, cache: 'no-store' });
        if (optional && response.status === 404) return null;
        if (!response.ok) throw new Error('积分配置读取失败（HTTP ' + response.status + '）。');
        return response.json();
      }, timeout, signal);
    }
    async function execute(query, readOptions) {
      const readOpts = readOptions || {};
      const state = base();
      if (destroyed || readOpts.signal?.aborted) throw aborted();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      readOpts.signal?.addEventListener('abort', cancel, { once: true });
      active.add(controller);
      let provider;
      const signal = controller.signal;
      const call = operation => deadline(operation, timeout, signal);
      try {
        const raw = await json(network.deploymentPath, signal, true);
        if (!raw) return { ...state, kind: 'missing', message: network.label + ' 尚未部署积分账本；当前没有可读取的链上余额。' };
        const deployment = validateDeployment(raw, network.key);
        state.deployment = deployment;
        const artifact = await json(ARTIFACT, signal, false);
        if (!Array.isArray(artifact.abi)) throw new Error('PointsLedger ABI 缺失。');
        if (!sdkPromise) sdkPromise = Promise.resolve().then(() => (opts.loadEthers || opts.loadSdk || (() => import(SDK)))()).catch(error => { sdkPromise = null; throw error; });
        let loaded;
        try { loaded = await call(() => sdkPromise); }
        catch (error) { sdkPromise = null; throw error; }
        const sdk = loaded.ethers || loaded;
        const abi = new sdk.Interface(artifact.abi);
        if (!abi.getFunction('balanceOf(bytes32)') || !abi.getEvent('Awarded(bytes32,uint256,bytes32,bytes32,address,uint256)') || !abi.getEvent('Spent(bytes32,uint256,bytes32,bytes32,address,uint256)')) throw new Error('PointsLedger ABI 不兼容。');
        const subject = query.subject || sdk.keccak256(sdk.toUtf8Bytes('openalex:' + query.id));
        if (!HASH.test(subject || '')) throw new Error('积分主体指纹无效。');
        state.subject = subject.toLowerCase();
        provider = opts.createProvider ? opts.createProvider(network.rpc, sdk) : new sdk.JsonRpcProvider(network.rpc, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
        if (signal.aborted) throw aborted();
        const actualNetwork = await call(() => provider.getNetwork());
        if (BigInt(actualNetwork.chainId) !== BigInt(network.chainId)) throw new Error('积分 RPC 网络错误：期望 ' + network.chainId + '，收到 ' + actualNetwork.chainId + '。');
        const head = integer(await call(() => provider.getBlockNumber()), '最新积分区块');
        if (head < deployment.block) throw new Error('RPC 最新区块早于积分部署区块。');
        const [block, code] = await Promise.all([call(() => provider.getBlock(head)), call(() => provider.getCode(deployment.address, head))]);
        state.asOf = blockRecord(block, head);
        if (!/^0x[0-9a-f]+$/i.test(code || '') || /^0x0*$/i.test(code)) throw new Error('积分登记地址在查询区块没有合约代码。');
        const contract = opts.createContract ? opts.createContract(deployment.address, artifact.abi, provider, sdk) : new sdk.Contract(deployment.address, artifact.abi, provider);
        const balance = uint(await call(() => contract.balanceOf(state.subject, { blockTag: head })), '链上积分余额');
        let events = [], cursor = head, count = 0, scannedFrom = null, reason = null;
        const until = Date.now() + historyTimeout;
        while (cursor >= deployment.block && count < maxChunks) {
          const from = Math.max(deployment.block, cursor - chunkSize + 1);
          const remaining = until - Date.now();
          if (remaining <= 0) { reason = '流水读取达到时限，早期记录尚未完整加载。'; break; }
          try {
            const [awards, spends] = await Promise.all([
              deadline(() => contract.queryFilter(contract.filters.Awarded(state.subject), from, cursor), Math.min(timeout, remaining), signal),
              deadline(() => contract.queryFilter(contract.filters.Spent(state.subject), from, cursor), Math.min(timeout, remaining), signal)
            ]);
            if (!Array.isArray(awards) || !Array.isArray(spends) || awards.length + spends.length > 10000) throw new Error('单页积分流水返回不合理，不能确认完整性。');
            const batch = awards.map(log => eventRecord(log, 'award', state.subject, deployment, from, cursor, abi, sdk, network)).concat(spends.map(log => eventRecord(log, 'spend', state.subject, deployment, from, cursor, abi, sdk, network)));
            if (batch.some(event => event.blockNumber === head && event.blockHash !== state.asOf.hash)) throw new Error('最新区块积分事件与查询区块不一致。');
            events = deduplicate(events.concat(batch));
            scannedFrom = from; count++; cursor = from - 1;
            if (events.length > maxEvents) { events = events.slice(-maxEvents); reason = '流水达到条数上限，仅展示最近 ' + maxEvents + ' 条。'; break; }
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            reason = '部分积分流水未能读取：' + errorText(error); break;
          }
        }
        if (cursor >= deployment.block && !reason) reason = '流水达到分页上限，更早的记录尚未加载。';
        let complete = cursor < deployment.block && !reason;
        if (!consistent(events, balance, complete)) { complete = false; reason = '已读取流水与该区块余额不能完整核对，请重试或到浏览器核查。'; }
        const checked = blockRecord(await call(() => provider.getBlock(head)), head);
        if (checked.hash !== state.asOf.hash) throw new Error('积分查询期间区块发生变化，请重新读取；本次余额尚未确认。');
        return { ...state, kind: complete ? 'ready' : 'partial', balance, events, history: { complete, fromBlock: deployment.block, toBlock: head, scannedFromBlock: scannedFrom, reason, chunks: count, limit: chunkSize * maxChunks }, message: complete ? '已读取 ' + network.label + ' 的积分余额与完整流水。' : '已读取 ' + network.label + ' 的余额；' + reason };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        return { ...state, balance: null, events: [], kind: 'error', message: errorText(error) };
      } finally {
        active.delete(controller);
        readOpts.signal?.removeEventListener('abort', cancel);
        if (provider && typeof provider.destroy === 'function') { try { provider.destroy(); } catch (_) { /* Already closed providers do not change the result. */ } }
      }
    }
    function read(record, readOptions) {
      const value = typeof record === 'string' ? record : record?.id || record?.openalex;
      if (value === 'SYNTHETIC' || record?.synthetic === true) return Promise.resolve({ ...base(), kind: 'synthetic', message: '虚构案例没有链上学者身份，不读取或推算积分余额。' });
      const id = typeof value === 'string' ? value.replace(/^https:\/\/openalex\.org\//, '') : '';
      if (!/^A\d+$/.test(id)) return Promise.resolve({ ...base(), kind: 'error', message: '读取积分需要有效的 OpenAlex 作者编号。' });
      return execute({ id }, readOptions);
    }
    function readSubject(subject, readOptions) {
      if (!HASH.test(subject || '')) return Promise.resolve({ ...base(), kind: 'error', message: '读取积分需要有效的 bytes32 主体指纹。' });
      return execute({ subject: subject.toLowerCase() }, readOptions);
    }
    return { read, readSubject, destroy() { destroyed = true; for (const controller of active) controller.abort(); }, network };
  }
  return { createReader, getNetwork, validateDeployment };
});
