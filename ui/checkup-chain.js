(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarCheckupChain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RPC = 'https://rpc.botchain.ai';
  const SDK = 'https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm';
  const HASH = /^0x[0-9a-f]{64}$/i;
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const ZERO = '0x' + '0'.repeat(64);
  const KINDS = { SCORE: '评分', SUBMIT: '投稿', REVIEW: '审稿', REPRODUCE: '复现', CLAIM: '认领' };
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

  function validateDeployment(value) {
    if (!value || value.chainId !== 677) throw new Error('部署清单的 chainId 必须为 BOT Chain 主网 677。');
    if (!ADDRESS.test(value.address || '') || /^0x0{40}$/i.test(value.address)) throw new Error('部署清单中的合约地址无效。');
    if (!Number.isSafeInteger(value.block) || value.block < 0) throw new Error('部署清单缺少有效的部署区块。');
    return { chainId: 677, address: value.address, block: value.block };
  }

  function asNumber(value, label, min, max) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('链上返回的' + label + '无效。');
    return number;
  }

  function actionRecord(row, query, sdk) {
    if (!HASH.test(row.subject || '') || (query.subject && row.subject.toLowerCase() !== query.subject.toLowerCase())) throw new Error('链上行为的主体不匹配。');
    if (!HASH.test(row.content || '') || !HASH.test(row.org || '') || !HASH.test(row.rule || '') || !HASH.test(row.kind || '') || !ADDRESS.test(row.recorder || '')) throw new Error('链上行为的哈希或登记人地址无效。');
    if (query.contentHash && row.content.toLowerCase() !== query.contentHash.toLowerCase()) throw new Error('链上行为的内容指纹不匹配。');
    let kind;
    try { kind = sdk.decodeBytes32String(row.kind); } catch (_) { throw new Error('链上行为类型无法识别。'); }
    if (!Object.hasOwn(KINDS, kind)) throw new Error('链上返回了未知的行为类型。');
    const value = asNumber(row.value, '行为数值', 0, kind === 'SCORE' ? 100 : 0);
    let ruleLabel = row.rule;
    try { ruleLabel = sdk.decodeBytes32String(row.rule) || row.rule; } catch (_) { /* Non-text rules retain their original hash. */ }
    if (row.rule.toLowerCase() === ZERO) ruleLabel = '未指定规则';
    return {
      subject: row.subject, kind, kindHash: row.kind, kindLabel: KINDS[kind],
      content: row.content, org: row.org, value,
      rule: row.rule, ruleLabel, recorder: row.recorder,
      time: asNumber(row.time, '时间', 0, 8640000000000), transactionHash: null, blockNumber: null
    };
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
      if (!event.args || !HASH.test(event.transactionHash || '') || !Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0) return;
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
      });
    });
    return records;
  }

  function createReader(dependencies) {
    const deps = dependencies || {};
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
        const pending = json('../chain/deployments/botchain.json', true).then(value => value === null ? null : validateDeployment(value));
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
        return { kind: 'synthetic', label: '虚构案例 · 快照演示', message: '这个案例只用于说明规则，不对应真实学者，不查询或生成链上记录。', records: [] };
      }
      let provider;
      try {
        const byContent = normalized.contentHash !== undefined;
        if (byContent ? !HASH.test(normalized.contentHash || '') : !/^A\d+$/.test(normalized.id || '')) throw new Error('需要有效的 OpenAlex 作者 ID 或 32 字节内容指纹。');
        const deployment = await deadline(() => manifest(opts.retry), timeout, opts.signal);
        if (!deployment) return { kind: 'snapshot', label: '未部署 · 快照演示', message: '尚未发现 BOT Chain 部署清单，当前没有可读取的已部署合约。页面中的快照演示不代表任何记录已上链。', records: [] };
        const [library, artifact] = await Promise.all([deadline(sdk, timeout, opts.signal), deadline(() => json('../chain/artifacts/ActionRegistry.json'), timeout, opts.signal)]);
        if (!artifact || !Array.isArray(artifact.abi)) throw new Error('合约 ABI 文件无效。');
        provider = deps.createProvider ? deps.createProvider(RPC, library) : new library.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
        const network = await deadline(() => provider.getNetwork(), timeout, opts.signal);
        if (BigInt(network.chainId) !== 677n) throw new Error('RPC 网络不匹配：期望 677，收到 ' + String(network.chainId) + '。');
        const latest = asNumber(await deadline(() => provider.getBlockNumber(), timeout, opts.signal), '区块号', 0, Number.MAX_SAFE_INTEGER);
        if (latest < deployment.block) throw new Error('RPC 当前区块早于部署区块，请检查部署清单或稍后重试。');
        const code = await deadline(() => provider.getCode(deployment.address, latest), timeout, opts.signal);
        if (!/^0x[0-9a-f]+$/i.test(code || '') || /^0x0*$/i.test(code)) throw new Error('部署地址没有合约代码，当前不能展示为链上模式。');
        const contract = deps.createContract ? deps.createContract(deployment.address, artifact.abi, provider, library) : new library.Contract(deployment.address, artifact.abi, provider);
        const subject = byContent ? null : library.keccak256(library.toUtf8Bytes('openalex:' + normalized.id));
        const contentHash = byContent ? normalized.contentHash.toLowerCase() : null;
        const values = await deadline(() => byContent ? contract.actionsByContent(contentHash, { blockTag: latest }) : contract.actionsOf(subject, { blockTag: latest }), timeout, opts.signal);
        if (!Array.isArray(values)) throw new Error('链上行为列表格式无效。');
        const records = values.map(value => actionRecord(value, { subject, contentHash }, library));
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
          kind: partial ? 'partial' : 'ready', label: partial ? '链上只读 · 交易历史未齐' : '链上只读 · BOT Chain',
          message: partial ? matched === records.length ? '行为及对应交易已取得；事件查询只覆盖部分区块，尚未回溯部署以来的完整历史。' : '行为已从合约读取。部分交易事件未取得或无法唯一对应，缺失的交易哈希与区块号不会补写。' : records.length ? '来自 BOT Chain ActionRegistry 的公开行为记录，按登记顺序呈现。链上登记与行为核实是两个步骤。' : '已连接部署合约，但这个查询在当前读取区块没有行为记录。',
          records, deployment, subject, contentHash, readBlock: latest, checkedAt: new Date().toISOString(),
          history: { complete: !partial, fromBlock: count ? cursor + 1 : null, toBlock: latest, matched, count: records.length, logError, limit: chunk * maxChunks }
        };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        return { kind: 'error', label: '链上读取失败 · 快照可用', message: errorText(error), records: [] };
      } finally {
        if (provider && typeof provider.destroy === 'function') provider.destroy();
      }
    }
    return { read };
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
        [['网络', 'BOT Chain · 677'], ['读取区块', '#' + state.readBlock.toLocaleString('en-US')], ['合约地址', state.deployment.address]].forEach(([label, value]) => {
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
            const lead = el('div', 'sc-chain__entry-head');
            const score = el('div', row.kind === 'SCORE' ? 'sc-chain__score' : 'sc-chain__kind');
            if (row.kind === 'SCORE') score.append(el('strong', '', String(row.value)), el('span', '', '/100'));
            else score.append(el('strong', '', row.kindLabel));
            const heading = el('div'); heading.append(el('h3', '', row.kind === 'SCORE' ? '评分 · ' + row.ruleLabel : row.kind + ' / 已登记'), el('p', '', new Date(row.time * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + ' UTC+8'));
            lead.append(score, heading); item.append(lead);
            const details = el('dl', 'sc-chain__fields');
            [['登记人', row.recorder], ['内容指纹', row.content], ['主体指纹', row.subject], ['机构指纹', row.org.toLowerCase() === ZERO ? '未指定机构（零值）' : row.org], ['规则原值', row.rule]].forEach(([label, value]) => {
              const group = el('div'); group.append(el('dt', '', label), el('dd', '', value)); details.append(group);
            });
            const tx = el('div'); tx.append(el('dt', '', '交易凭据'));
            const receipt = el('dd');
            if (row.transactionHash) {
              const link = el('a', '', row.transactionHash); link.href = 'https://scan.botchain.ai/tx/' + row.transactionHash; link.target = '_blank'; link.rel = 'noopener noreferrer';
              receipt.append(link, el('span', 'sc-chain__block', '区块 #' + row.blockNumber.toLocaleString('en-US')));
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
  return { mount, createReader, createSession, validateDeployment, matchEvents };
});
