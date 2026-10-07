(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarCheckupChain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const NETWORKS = Object.freeze({
    mainnet: Object.freeze({ key: 'mainnet', chainId: 677, rpc: 'https://rpc.botchain.ai', explorer: 'https://scan.botchain.ai', label: 'BOT 主网 · 677', deploymentPath: '../chain/deployments/botchain.json', journalsPath: '../chain/deployments/journals.json' }),
    testnet: Object.freeze({ key: 'testnet', chainId: 968, rpc: 'https://rpc.bohr.life', explorer: 'https://scan.bohr.life', label: 'BOT 测试网 · 968', deploymentPath: '../chain/deployments/botchain-testnet.json', journalsPath: '../chain/deployments/journals-testnet.json' })
  });
  function getNetwork(name) {
    if (name === undefined) {
      const requested = typeof location === 'object' ? new URLSearchParams(location.search).get('network') : null;
      name = requested === 'testnet' ? 'testnet' : 'mainnet';
    }
    if (!Object.hasOwn(NETWORKS, name)) throw new Error('网络仅支持 mainnet 或 testnet。');
    return NETWORKS[name];
  }
  const SDK = 'https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm';
  const HASH = /^0x[0-9a-f]{64}$/i;
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const ZERO = '0x' + '0'.repeat(64);
  const KINDS = { SCORE: '评分', SUBMIT: '投稿', CLOSE: '结案', REVIEW: '审稿', REPRODUCE: '复现', CLAIM: '认领' };
  const CLOSE_REASONS = { REJECTED: '拒稿', WITHDRAWN: '撤稿', ACCEPTED: '录用' };
  const errorText = error => error && error.message ? error.message : String(error);
  const aborted = () => Object.assign(new Error('读取已取消'), { name: 'AbortError' });

  // A deadline bounds CDN, HTTP and RPC calls. Fetch also receives an abort signal.
  function deadline(operation, ms, signal) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
        controller.abort();
        fn(value);
      };
      const cancel = () => finish(reject, aborted());
      if (signal && signal.aborted) return cancel();
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish(reject, new Error('连接超时，请稍后重试。')), ms);
      Promise.resolve().then(() => operation(controller.signal)).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  function validateDeployment(value, network) {
    const config = getNetwork(network);
    if (!value || value.chainId !== config.chainId) throw new Error('部署清单的 chainId 必须为 ' + config.label + '。');
    if (!ADDRESS.test(value.address || '') || /^0x0{40}$/i.test(value.address)) throw new Error('部署清单中的合约地址无效。');
    if (!Number.isSafeInteger(value.block) || value.block < 0) throw new Error('部署清单缺少有效的部署区块。');
    return { chainId: config.chainId, address: value.address, block: value.block };
  }

  function validateJournals(value) {
    if (!value || !Array.isArray(value.journals) || !value.journals.length) throw new Error('可信期刊名单为空或格式无效。');
    if (!HASH.test(value.manuscript || '') || value.manuscript.toLowerCase() === ZERO) throw new Error('可信期刊名单缺少有效的演示稿件指纹。');
    const pairs = new Set();
    const journals = value.journals.map(row => {
      if (!row || typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 160) throw new Error('可信期刊名称无效。');
      if (!ADDRESS.test(row.address || '') || /^0x0{40}$/i.test(row.address)) throw new Error('可信期刊登记地址无效。');
      if (!HASH.test(row.org || '') || row.org.toLowerCase() === ZERO) throw new Error('可信期刊机构指纹无效。');
      const address = row.address.toLowerCase();
      const org = row.org.toLowerCase();
      const key = address + ':' + org;
      if (pairs.has(key)) throw new Error('可信期刊名单包含重复的地址与机构指纹。');
      pairs.add(key);
      return { name: row.name.trim(), address, org, ...(typeof row.key === 'string' ? { key: row.key } : {}) };
    });
    return { journals, manuscript: value.manuscript.toLowerCase(), ...(typeof value.demoAuthor === 'string' ? { demoAuthor: value.demoAuthor } : {}) };
  }

  async function loadJournals(options) {
    const opts = options || {};
    const fetcher = opts.fetch || ((...args) => fetch(...args));
    try {
      const network = getNetwork(opts.network);
      const value = await deadline(async signal => {
        const response = await fetcher(network.journalsPath, { signal, cache: 'no-store' });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error('可信期刊名单读取失败（HTTP ' + response.status + '）。');
        return validateJournals(await response.json());
      }, opts.timeoutMs || 12000, opts.signal);
      if (!value) return { kind: 'missing', network: network.key, journals: [], manuscript: null, message: network.label + '尚未发布可信期刊名单，暂不进行机构风险判断。' };
      return { kind: 'ready', network: network.key, ...value, message: '已读取' + network.label + '的演示可信期刊名单；同时核对登记地址和机构指纹。' };
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return { kind: 'error', journals: [], manuscript: null, message: errorText(error) };
    }
  }

  function trustedJournal(record, manifestOrList) {
    if (!record || !ADDRESS.test(record.recorder || '') || !HASH.test(record.org || '')) return null;
    if (!Array.isArray(manifestOrList) && (!manifestOrList || (manifestOrList.kind && manifestOrList.kind !== 'ready'))) return null;
    const list = Array.isArray(manifestOrList) ? manifestOrList : manifestOrList.journals;
    if (!Array.isArray(list)) return null;
    return list.find(journal => ADDRESS.test(journal.address || '') && HASH.test(journal.org || '') && journal.address.toLowerCase() === record.recorder.toLowerCase() && journal.org.toLowerCase() === record.org.toLowerCase()) || null;
  }

  function asNumber(value, label, min, max) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('链上返回的' + label + '无效。');
    return number;
  }

  function actionRecord(row, query, sdk, sequence) {
    if (!HASH.test(row.subject || '') || (query.subject && row.subject.toLowerCase() !== query.subject.toLowerCase())) throw new Error('链上行为的主体不匹配。');
    if (!HASH.test(row.content || '') || !HASH.test(row.org || '') || !HASH.test(row.rule || '') || !HASH.test(row.kind || '') || !ADDRESS.test(row.recorder || '')) throw new Error('链上行为的哈希或登记人地址无效。');
    if (query.contentHash && row.content.toLowerCase() !== query.contentHash.toLowerCase()) throw new Error('链上行为的内容指纹不匹配。');
    let kind = 'UNKNOWN';
    try { kind = sdk.decodeBytes32String(row.kind) || 'UNKNOWN'; } catch (_) { /* Retain unrecognized records with their original bytes32 value. */ }
    const knownKind = Object.hasOwn(KINDS, kind);
    const value = asNumber(row.value, '行为数值', 0, knownKind ? kind === 'SCORE' ? 100 : 0 : 65535);
    let ruleName = null;
    let ruleLabel = row.rule;
    try { ruleName = sdk.decodeBytes32String(row.rule) || null; ruleLabel = ruleName || row.rule; } catch (_) { /* Non-text rules retain their original hash. */ }
    if (row.rule.toLowerCase() === ZERO) ruleLabel = '未指定规则';
    const closeReason = kind === 'CLOSE' && Object.hasOwn(CLOSE_REASONS, ruleName) ? ruleName : null;
    const closeReasonLabel = kind === 'CLOSE' ? closeReason ? CLOSE_REASONS[closeReason] : '未知结案原因' : null;
    if (closeReason) ruleLabel = closeReasonLabel;
    return {
      subject: row.subject, kind, kindHash: row.kind, kindLabel: knownKind ? KINDS[kind] : '未知行为', knownKind,
      content: row.content, org: row.org, value,
      rule: row.rule, ruleName, ruleLabel, closeReason, closeReasonLabel, recorder: row.recorder,
      sequence, time: asNumber(row.time, '时间', 0, 8640000000000), transactionHash: null, blockNumber: null, logIndex: null, eventId: null
    };
  }

  function scorePresentation(row) {
    if (!row || row.kind !== 'SCORE' || !Number.isInteger(row.value) || row.value < 0 || row.value > 100) return null;
    if (row.ruleName === 'checkup-v2') return { value: 350 + 6 * row.value, suffix: '分', label: 'checkup-v2 · 350–950 分', note: '链上原值 ' + row.value + '/100；按该版本显示公式 350 + 6 × 原值换算。' };
    if (row.ruleName === 'checkup-v0') return { value: row.value, suffix: '/100', label: 'checkup-v0 · 0–100 分', note: '旧版评分量尺，与 checkup-v2 分数不能直接比较。' };
    return { value: row.value, suffix: '原值', label: '尚未识别评分量尺', note: '保留合约中的原始数值；未识别规则版本，不推断显示分数或档位。' };
  }

  function recordKey(row) {
    // Recorded does not include rule or time. Never manufacture them from logs.
    return [row.subject, row.kindHash || row.kind, row.content, row.org, row.value, row.recorder].join('|').toLowerCase();
  }

  // Action[] has no transaction metadata. Only attach a proven Recorded event.
  // Repeated identical tuples remain unlinked when the event history is incomplete.
  function matchEvents(records, events) {
    const rows = new Map();
    const logs = new Map();
    records.forEach(row => { const key = recordKey(row); if (!rows.has(key)) rows.set(key, []); rows.get(key).push(row); });
    const seen = new Set();
    events.slice().sort((a, b) => a.blockNumber - b.blockNumber || Number(a.index) - Number(b.index)).forEach(event => {
      if (!event.args || !HASH.test(event.transactionHash || '') || !Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0 || !Number.isSafeInteger(event.index) || event.index < 0) return;
      const identity = event.transactionHash + ':' + event.index;
      if (seen.has(identity)) return;
      seen.add(identity);
      const key = recordKey(event.args);
      if (!logs.has(key)) logs.set(key, []);
      logs.get(key).push(event);
    });
    rows.forEach((group, key) => {
      const matches = logs.get(key) || [];
      if (matches.length !== group.length) return;
      group.forEach((row, index) => {
        row.transactionHash = matches[index].transactionHash;
        row.blockNumber = matches[index].blockNumber;
        row.logIndex = matches[index].index;
        row.eventId = /^\d+$/.test(String(matches[index].args.id)) ? String(matches[index].args.id) : null;
      });
    });
    return records;
  }

  function createReader(dependencies) {
    const deps = dependencies || {};
    const network = getNetwork(deps.network);
    const identity = { network: network.key, chainId: network.chainId, networkLabel: network.label, explorer: network.explorer };
    const fetcher = deps.fetch || ((...args) => fetch(...args));
    const timeout = deps.timeoutMs || 12000;
    const chunk = deps.chunkSize || 1000;
    const maxChunks = deps.maxChunks || 20;
    const logBudget = deps.logBudgetMs || 15000;
    let manifestPromise;
    let sdkPromise;
    async function json(path, optional) {
      return deadline(async signal => {
        const response = await fetcher(path, { signal, cache: 'no-store' });
        if (optional && response.status === 404) return null;
        if (!response.ok) throw new Error('读取 ' + path.split('/').pop() + ' 失败（HTTP ' + response.status + '）。');
        return response.json();
      }, timeout);
    }
    function manifest(retry) {
      if (retry) manifestPromise = undefined;
      if (!manifestPromise) {
        const pending = json(network.deploymentPath, true).then(value => value === null ? null : validateDeployment(value, network.key));
        manifestPromise = pending;
        pending.catch(() => { if (manifestPromise === pending) manifestPromise = undefined; });
      }
      return manifestPromise;
    }
    function sdk() {
      if (!sdkPromise) {
        const pending = deadline(() => deps.loadSdk ? deps.loadSdk() : import(SDK), timeout).then(value => value.ethers || value);
        sdkPromise = pending;
        pending.catch(() => { if (sdkPromise === pending) sdkPromise = undefined; });
      }
      return sdkPromise;
    }
    async function read(normalized, options) {
      const opts = options || {};
      if (normalized.synthetic || normalized.id === 'SYNTHETIC') {
        return { ...identity, kind: 'synthetic', label: '虚构案例 · 快照演示', message: '这个案例只用于说明规则，不对应真实学者，不查询或生成链上记录。', records: [] };
      }
      let provider;
      try {
        const byContent = normalized.contentHash !== undefined;
        if (byContent ? !HASH.test(normalized.contentHash || '') : !/^A\d+$/.test(normalized.id || '')) throw new Error('需要有效的 OpenAlex 作者 ID 或 32 字节内容指纹。');
        const deployment = await deadline(() => manifest(opts.retry), timeout, opts.signal);
        if (!deployment) return { ...identity, kind: 'snapshot', label: network.key === 'testnet' ? '测试网未部署 · 快照演示' : '未部署 · 快照演示', message: '尚未发现' + network.label + '部署清单，当前没有可读取的已部署合约。页面中的快照演示不代表任何记录已上链；不会自动切换到另一网络。', records: [] };
        const [library, artifact] = await Promise.all([deadline(sdk, timeout, opts.signal), deadline(() => json('../chain/artifacts/ActionRegistry.json'), timeout, opts.signal)]);
        if (!artifact || !Array.isArray(artifact.abi)) throw new Error('合约 ABI 文件无效。');
        provider = deps.createProvider ? deps.createProvider(network.rpc, library) : new library.JsonRpcProvider(network.rpc, undefined, { batchMaxCount: 1 });
        const actualNetwork = await deadline(() => provider.getNetwork(), timeout, opts.signal);
        if (BigInt(actualNetwork.chainId) !== BigInt(network.chainId)) throw new Error('RPC 网络不匹配：期望 ' + network.chainId + '，收到 ' + String(actualNetwork.chainId) + '。');
        const latest = asNumber(await deadline(() => provider.getBlockNumber(), timeout, opts.signal), '区块号', 0, Number.MAX_SAFE_INTEGER);
        if (latest < deployment.block) throw new Error('RPC 当前区块早于部署区块，请检查部署清单或稍后重试。');
        const code = await deadline(() => provider.getCode(deployment.address, latest), timeout, opts.signal);
        if (!/^0x[0-9a-f]+$/i.test(code || '') || /^0x0*$/i.test(code)) throw new Error('部署地址没有合约代码，当前不能展示为链上模式。');
        const contract = deps.createContract ? deps.createContract(deployment.address, artifact.abi, provider, library) : new library.Contract(deployment.address, artifact.abi, provider);
        const subject = byContent ? null : library.keccak256(library.toUtf8Bytes('openalex:' + normalized.id));
        const contentHash = byContent ? normalized.contentHash.toLowerCase() : null;
        const values = await deadline(() => byContent ? contract.actionsByContent(contentHash, { blockTag: latest }) : contract.actionsOf(subject, { blockTag: latest }), timeout, opts.signal);
        if (!Array.isArray(values)) throw new Error('链上行为列表格式无效。');
        const records = values.map((value, sequence) => actionRecord(value, { subject, contentHash }, library, sequence));
        const events = [];
        let cursor = latest;
        let count = 0;
        let logError = '';
        const logDeadline = Date.now() + logBudget;
        // Scan backwards, in bounded chunks; a failed chunk stops the contiguous history.
        while (records.length && cursor >= deployment.block && count < maxChunks) {
          const from = Math.max(deployment.block, cursor - chunk + 1);
          try {
            const remaining = logDeadline - Date.now();
            if (remaining <= 0) throw new Error('本次事件查询已达到时间上限，可刷新重试。');
            const batch = await deadline(() => contract.queryFilter(contract.filters.Recorded(null, subject, null), from, cursor), Math.min(timeout, remaining), opts.signal);
            // content is not indexed: content lookup must filter the bounded result locally.
            events.push(...batch.filter(event => !contentHash || (event.args && String(event.args.content).toLowerCase() === contentHash)));
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            logError = errorText(error);
            break;
          }
          cursor = from - 1;
          count += 1;
        }
        matchEvents(records, events);
        const matched = records.filter(value => value.transactionHash).length;
        const partial = records.length > 0 && (cursor >= deployment.block || matched !== records.length || Boolean(logError));
        return {
          ...identity, kind: partial ? 'partial' : 'ready', label: '链上只读 · ' + network.label + (partial ? ' · 交易历史未齐' : ''),
          message: partial ? matched === records.length ? '行为及对应交易已取得；事件查询只覆盖部分区块，尚未回溯部署以来的完整历史。' : '行为已从合约读取。部分交易事件未取得或无法唯一对应，缺失的交易哈希与区块号不会补写。' : records.length ? '来自 BOT Chain ActionRegistry 的公开行为记录，按登记顺序呈现。链上登记与行为核实是两个步骤。' : '已连接部署合约，但这个查询在当前读取区块没有行为记录。',
          records, deployment, subject, contentHash, readBlock: latest, checkedAt: new Date().toISOString(),
          history: { complete: !partial, fromBlock: count ? cursor + 1 : null, toBlock: latest, matched, count: records.length, logError, limit: chunk * maxChunks }
        };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        return { ...identity, kind: 'error', label: network.label + '读取失败 · 快照可用', message: errorText(error), records: [] };
      } finally {
        if (provider && typeof provider.destroy === 'function') provider.destroy();
      }
    }
    return { read, network };
  }

  // Subject switches must never let a slower, older RPC response repaint a newer case.
  function createSession(reader, onStatus) {
    let controller;
    let serial = 0;
    let destroyed = false;
    let current;
    let state = { kind: 'loading', label: '检查链上部署', message: '正在检查部署清单…', records: [] };
    function publish(value) { state = value; if (onStatus) onStatus(state); }
    async function update(normalized, retry) {
      if (destroyed) return;
      current = normalized;
      const own = ++serial;
      if (controller) controller.abort();
      controller = new AbortController();
      publish({ kind: 'loading', label: '检查链上部署', message: '正在检查部署清单与链上记录…', records: [] });
      try {
        const value = await reader.read(normalized, { signal: controller.signal, retry: Boolean(retry) });
        if (!destroyed && own === serial) publish(value);
      } catch (error) {
        if (!destroyed && own === serial && error.name !== 'AbortError') publish({ kind: 'error', label: '链上读取失败 · 快照可用', message: errorText(error), records: [] });
      }
    }
    return { update, reload: () => current && update(current, true), getStatus: () => state, destroy() { destroyed = true; serial += 1; if (controller) controller.abort(); } };
  }

  const sharedReader = createReader();
  function mount(container, normalized, options) {
    if (!container || !container.ownerDocument) throw new TypeError('链上面板需要 DOM 容器。');
    const opts = options || {};
    const doc = container.ownerDocument;
    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    let recorder = '';
    let rule = '';
    let kind = '';
    function render(state) {
      container.replaceChildren();
      const panel = el('section', 'sc-chain');
      panel.setAttribute('aria-label', '真实链上行为查询');
      panel.dataset.state = state.kind;
      const top = el('div', 'sc-chain__head');
      const title = el('div');
      title.append(el('p', 'sc-chain__eyebrow', 'PUBLIC LEDGER / 只读查询'), el('h2', '', '链上行为与评分'));
      const status = el('span', 'sc-chain__status', state.label);
      status.setAttribute('role', 'status');
      top.append(title, status);
      panel.append(top, el('p', 'sc-chain__message', state.message));
      if (state.deployment) {
        const metadata = el('dl', 'sc-chain__metadata');
        [['网络', state.networkLabel || 'BOT 主网 · 677'], ['读取区块', '#' + state.readBlock.toLocaleString('en-US')], ['合约地址', state.deployment.address]].forEach(([label, value]) => {
          const group = el('div'); group.append(el('dt', '', label), el('dd', '', value)); metadata.append(group);
        });
        panel.append(metadata, el('p', 'sc-chain__trust', '任何地址都能登记行为。链上存证说明这条记录存在，不代表行为已经核实；请按信任的登记人、行为和规则筛选。机构指纹不等于机构身份认证，认领或复现记录也不会自动加分。这里的评分不会覆盖体检卡。'));
      }
      if (state.records.length) {
        const filters = el('div', 'sc-chain__filters');
        const list = el('div', 'sc-chain__timeline');
        const count = el('p', 'sc-chain__count');
        function drawRecords() {
          list.replaceChildren();
          const visible = state.records.filter(row => (!recorder || row.recorder === recorder) && (!rule || row.rule === rule) && (!kind || row.kind === kind));
          const scoreCount = state.records.filter(row => row.kind === 'SCORE').length;
          count.textContent = '显示 ' + visible.length + ' / ' + state.records.length + ' 条行为 · 其中 ' + scoreCount + ' 次评分 · 由新到旧';
          visible.slice().reverse().forEach(row => {
            const item = el('article', 'sc-chain__entry');
            if (!row.knownKind) item.dataset.unknown = 'true';
            const lead = el('div', 'sc-chain__entry-head');
            const score = el('div', row.kind === 'SCORE' ? 'sc-chain__score' : 'sc-chain__kind');
            const presentation = scorePresentation(row);
            if (presentation) score.append(el('strong', '', String(presentation.value)), el('span', '', presentation.suffix));
            else score.append(el('strong', '', row.kindLabel));
            const heading = el('div'); heading.append(el('h3', '', row.kind === 'SCORE' ? '评分 · ' + row.ruleLabel : row.kind === 'CLOSE' ? '结案 · ' + row.closeReasonLabel : row.knownKind ? row.kind + ' / 已登记' : '未知行为 / 尚未支持'), el('p', '', new Date(row.time * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + ' UTC+8 · 记录序号 ' + (row.sequence + 1)));
            lead.append(score, heading); item.append(lead);
            if (presentation) item.append(el('p', 'sc-chain__message', presentation.label + '。' + presentation.note));
            if (!row.knownKind) item.append(el('p', 'sc-chain__warning', '当前版本不解释这类行为，不参与规则判断。原始类型：' + row.kindHash));
            const details = el('dl', 'sc-chain__fields');
            [['登记人', row.recorder], ['内容指纹', row.content], ['主体指纹', row.subject], ['机构指纹', row.org.toLowerCase() === ZERO ? '未指定机构（零值）' : row.org], ['规则原值', row.rule]].forEach(([label, value]) => {
              const group = el('div'); group.append(el('dt', '', label), el('dd', '', value)); details.append(group);
            });
            const tx = el('div'); tx.append(el('dt', '', '交易凭据'));
            const receipt = el('dd');
            if (row.transactionHash) {
              const link = el('a', '', row.transactionHash); link.href = getNetwork(state.network || 'mainnet').explorer + '/tx/' + row.transactionHash; link.target = '_blank'; link.rel = 'noopener noreferrer';
              receipt.append(link, el('span', 'sc-chain__block', '区块 #' + row.blockNumber.toLocaleString('en-US') + ' · 日志序号 ' + row.logIndex));
            } else receipt.textContent = '未取得可唯一对应的事件，暂不展示交易哈希或区块号。';
            tx.append(receipt); details.append(tx); item.append(details); list.append(item);
          });
          if (!visible.length) list.append(el('p', 'sc-chain__message', '当前筛选下没有行为记录。'));
        }
        function filter(label, values, selected, onChange) {
          const wrapper = el('label', 'sc-chain__filter'); wrapper.append(el('span', '', label));
          const select = el('select');
          select.setAttribute('aria-label', label);
          const all = el('option', '', '全部' + label); all.value = ''; select.append(all);
          values.forEach(([value, text]) => { const option = el('option', '', text); option.value = value; select.append(option); });
          select.value = values.some(([value]) => value === selected) ? selected : '';
          onChange(select.value);
          select.addEventListener('change', () => { onChange(select.value); drawRecords(); });
          wrapper.append(select); return wrapper;
        }
        filters.append(filter('登记人', [...new Set(state.records.map(row => row.recorder))].map(value => [value, value]), recorder, value => { recorder = value; }), filter('行为类型', [...new Map(state.records.map(row => [row.kind, row.kindLabel]))], kind, value => { kind = value; }), filter('规则版本', [...new Map(state.records.map(row => [row.rule, row.ruleLabel]))], rule, value => { rule = value; }));
        panel.append(filters, count, list); drawRecords();
      }
      if (state.history && !state.history.complete) {
        let note = '事件查询每次最多回溯 ' + state.history.limit.toLocaleString('zh-CN') + ' 个区块；已对应 ' + state.history.matched + '/' + state.history.count + ' 条交易。';
        if (state.history.fromBlock !== null) note += ' 本次查到区间 #' + state.history.fromBlock + '–#' + state.history.toBlock + '。';
        if (state.history.logError) note += ' 事件查询中断：' + state.history.logError;
        panel.append(el('p', 'sc-chain__warning', note));
      }
      const footer = el('div', 'sc-chain__footer');
      footer.append(el('p', '', '只读查询不需要钱包或 Gas。链上只存行为类型、评分与指纹，不存论文或稿件内容。'));
      const retry = el('button', 'sc-chain__reload', state.kind === 'error' ? '重新连接' : state.kind === 'loading' ? '读取中…' : '刷新链上状态');
      retry.type = 'button'; retry.disabled = state.kind === 'loading' || state.kind === 'synthetic'; retry.addEventListener('click', () => session.reload());
      footer.append(retry); panel.append(footer); container.append(panel);
      if (opts.onStatus) opts.onStatus(state);
    }
    const session = createSession(opts.reader || sharedReader, render);
    session.update(normalized);
    return { update(value) { recorder = ''; rule = ''; kind = ''; return session.update(value); }, reload: session.reload, getStatus: session.getStatus, destroy() { session.destroy(); container.replaceChildren(); } };
  }
  return { mount, createReader, createSession, validateDeployment, matchEvents, validateJournals, loadJournals, trustedJournal, getNetwork, scorePresentation };
});
