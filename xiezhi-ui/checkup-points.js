(function (host, factory) {
  'use strict';
  const api = factory(host);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host) host.ScholarCheckupPoints = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (host) {
  'use strict';
  const instances = new WeakMap();
  let sequence = 0;
  const tierNames = { LOW: '低分档', MID: '中分档', HIGH: '高分档' };
  const zeroHash = /^0x0{64}$/i;

  function integer(value, signed) {
    const text = typeof value === 'bigint' ? value.toString() : String(value == null ? '' : value);
    if (!(signed ? /^[+-]?\d+$/ : /^\d+$/).test(text)) return null;
    return BigInt(text).toString();
  }
  function amount(value, signed) {
    const text = integer(value, signed);
    if (text === null) return '—';
    const negative = text[0] === '-';
    const digits = negative ? text.slice(1) : text;
    return (negative ? '−' : signed && BigInt(text) > 0n ? '+' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function short(value) {
    const text = String(value || '');
    return text.length > 24 ? text.slice(0, 12) + '…' + text.slice(-8) : text;
  }
  function safeURL(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }
  function networkLabel(network) {
    if (network && typeof network === 'object') return network.label || network.name || (network.key === 'testnet' ? 'BOT Chain 测试网' : network.key === 'mainnet' ? 'BOT Chain 主网' : '当前网络');
    return network === 'testnet' ? 'BOT Chain 测试网' : network === 'mainnet' ? 'BOT Chain 主网' : '当前网络';
  }
  function readMessage(result, fallback) {
    return result && (result.message || result.error && (result.error.message || typeof result.error === 'string' && result.error)) || fallback;
  }

  function mount(root, record, options) {
    if (!root || !root.ownerDocument || typeof root.replaceChildren !== 'function') throw new TypeError('ScholarCheckupPoints.mount requires a root element.');
    if (instances.has(root)) instances.get(root).destroy();
    options = options || {};
    const doc = root.ownerDocument;
    const id = 'sc-points-' + (++sequence);
    let current = record || {};
    let result = null;
    let state = 'loading';
    let reader = options.reader || null;
    let ownsReader = false;
    let controller = null;
    let request = 0;
    let destroyed = false;
    let focusRefresh = false;

    function node(tag, className, text) {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = String(text);
      return element;
    }
    function link(text, href, className) {
      const valid = safeURL(href);
      const element = node(valid ? 'a' : 'span', className, text);
      if (valid) { element.href = valid; element.target = '_blank'; element.rel = 'noopener noreferrer'; }
      return element;
    }
    function explorerLink(type, value) {
      const network = result && result.network || options.network;
      const base = network && typeof network === 'object' && (network.explorer || network.explorerUrl);
      if (!base || !/^0x[0-9a-f]+$/i.test(String(value || ''))) return '';
      return safeURL(String(base).replace(/\/$/, '') + '/' + type + '/' + value);
    }
    function rules() { return options.rules || host && host.ScholarPointsRules; }
    function statusMessage() {
      if (state === 'loading') return '正在从当前网络读取余额与账本事件…';
      if (state === 'synthetic') return '虚构案例不对应真实学者，不查询或生成链上积分。';
      if (state === 'missing') return readMessage(result, '当前网络尚未配置积分账本，不能据此认为余额为零。');
      if (state === 'error') return readMessage(result, '暂时无法读取积分，请稍后刷新；读取失败不等于零积分。');
      if (state === 'partial') return result.history && result.history.reason || readMessage(result, '余额已读取，流水未全部取得。下方仅展示本次查询到的事件。');
      return '余额与流水来自链上读取；本页不会发放、扣除或转移积分。';
    }
    function summary() {
      const section = node('div', 'sc-points__summary');
      const balance = node('div', 'sc-points__balance');
      balance.append(node('p', 'sc-points__eyebrow', 'CONTRIBUTION LEDGER / 贡献账本'));
      balance.append(node('h3', 'sc-points__metric-label', '当前链上积分'));
      const figure = node('div', 'sc-points__figure');
      const value = (state === 'ready' || state === 'partial') && integer(result && result.balance, false) !== null ? amount(result.balance) : '—';
      figure.append(node('strong', 'sc-points__number', value), node('span', 'sc-points__unit', 'POINTS'));
      balance.append(figure);
      const flags = node('div', 'sc-points__flags');
      flags.append(node('span', 'sc-points__chip', state === 'synthetic' ? '虚构样例 · 不查询网络' : networkLabel(result && result.network || options.network)));
      if (result && result.network && result.network.chainId != null) flags.append(node('span', 'sc-points__chip', 'Chain ' + result.network.chainId));
      balance.append(flags);
      balance.append(node('p', 'sc-points__balance-note', '贡献积分 · 无转账功能'));
      balance.append(node('p', 'sc-points__balance-note', '积分不能转让、不能买卖。'));
      const meta = node('p', 'sc-points__read-meta');
      if (result && result.asOf && result.asOf.number != null) {
        meta.append(node('span', '', '读取至区块 ' + result.asOf.number));
        const stamp = Number(result.asOf.timestamp);
        if (Number.isFinite(stamp) && stamp > 0) meta.append(node('span', '', new Date(stamp < 1e12 ? stamp * 1000 : stamp).toLocaleString('zh-CN', { hour12: false }) + ' · 区块时间'));
      } else meta.textContent = state === 'synthetic' ? '虚构样例 / 不读取真实账本' : state === 'loading' ? '等待链上读取结果' : '本次未取得可用链上余额';
      balance.append(meta);
      section.append(balance, tiers());
      return section;
    }
    function tiers() {
      const column = node('div', 'sc-points__tiers-column');
      const shared = rules();
      const score = typeof current.score === 'number' && Number.isFinite(current.score) && current.score >= 0 && current.score <= 100 ? current.score : null;
      const selected = shared && typeof shared.tierOf === 'function' && score !== null ? shared.tierOf(score) : null;
      const top = node('div', 'sc-points__tier-heading');
      top.append(node('h3', '', '档位看可核查度，积分记贡献'));
      column.append(top);
      column.append(node('p', 'sc-points__score-source', (state === 'synthetic' ? '虚构样例 · 当前体检快照' : '分档依据：当前体检快照') + ' · 可核查度 ' + (score === null ? '未取得' : score + ' / 100')));
      if (shared && Array.isArray(shared.TIERS) && shared.TIERS.length) {
        const list = node('ol', 'sc-points__tiers');
        const all = shared.TIERS.slice().sort((a, b) => a.min - b.min);
        all.forEach((tier, index) => {
          const active = selected && selected.id === tier.id;
          const card = node('li', 'sc-points__tier' + (active ? ' sc-points__tier--current' : ''));
          if (active) card.setAttribute('aria-current', 'true');
          card.append(node('span', 'sc-points__tier-state', active ? state === 'synthetic' ? '样例所在档' : '当前档位' : '规则参考'));
          card.append(node('h4', '', tierNames[tier.id] || tier.id));
          const next = all[index + 1];
          card.append(node('p', 'sc-points__range', next ? tier.min + '–' + (next.min - 1) : '≥ ' + tier.min));
          card.append(node('p', 'sc-points__tier-description', Number(tier.submitCost) > 0 ? '投稿规则：消耗 ' + amount(tier.submitCost) + ' 积分' : '投稿规则：不消耗积分'));
          if (tier.canReview) card.append(node('p', 'sc-points__tier-extra', '可申请参与审稿'));
          if (tier.priority) card.append(node('p', 'sc-points__tier-extra', '期刊优先 · 待机构启用'));
          list.append(card);
        });
        column.append(list);
      } else column.append(node('p', 'sc-points__notice', '共享分档规则尚未加载，暂不判定档位。'));
      column.append(node('p', 'sc-points__boundary', '积分余额不会直接加到体检分。档位权益属于试行规则，需要参与机构启用并核验资格，不表示机构已经承诺减免、优先或审稿资格。'));
      if (current.claimSimulation) column.append(node('p', 'sc-points__claim-note', '本地认领演示不会发放积分，也不会改写链上余额；只有授权发放方提交并确认的账本事件才计入。'));
      return column;
    }
    function ruleTable() {
      const shared = rules();
      const details = node('details', 'sc-points__rules');
      const toggle = node('summary', '', '查看积分规则与发放条件');
      toggle.append(node('span', '', shared && shared.VERSION ? shared.VERSION + ' · 试行参数' : '规则暂未加载'));
      details.append(toggle);
      const body = node('div', 'sc-points__rules-body');
      body.append(node('p', 'sc-points__rule-note', '这些数值是公开试行参数，不是完成按钮后的自动奖励。积分需由授权发放方依据有效记录发放或扣除；本页只读取。'));
      const entries = shared && shared.RULES && Object.entries(shared.RULES);
      if (entries && entries.length) {
        const list = node('ul', 'sc-points__rule-list');
        entries.forEach(([key, rule]) => {
          const row = node('li', 'sc-points__rule-row');
          const copy = node('div', '');
          copy.append(node('code', '', key), node('span', '', rule.label));
          const value = integer(rule.amount, false);
          row.append(copy, node('strong', rule.kind === 'spend' ? 'sc-points__negative' : 'sc-points__positive', value === null ? '—' : amount((rule.kind === 'spend' ? '-' : '+') + value, true)));
          list.append(row);
        });
        body.append(list);
      } else body.append(node('p', 'sc-points__notice', '未加载共享规则，暂不展示任何奖励数值。'));
      details.append(body);
      return details;
    }
    function field(list, label, value, href) {
      const row = node('div', '');
      row.append(node('dt', '', label));
      const content = node('dd', '');
      content.append(href ? link(value, href, '') : node('span', '', value));
      row.append(content);
      list.append(row);
    }
    function eventCard(event) {
      const shared = rules();
      const rule = shared && shared.RULES && shared.RULES[event.reason];
      const spending = event.kind === 'spend';
      const item = node('li', 'sc-points__event');
      const lead = node('div', 'sc-points__event-lead');
      const delta = integer(event.change, true) !== null ? event.change : integer(event.amount, false) !== null ? (spending ? '-' : '+') + event.amount : '';
      lead.append(node('strong', 'sc-points__delta ' + (spending ? 'sc-points__negative' : 'sc-points__positive'), amount(delta, true)));
      const copy = node('div', 'sc-points__event-copy');
      copy.append(node('h4', '', rule && rule.label || event.reason || '未识别的积分原因'));
      const meta = node('p', 'sc-points__event-meta', (spending ? '扣除' : '发放') + ' · 区块 ' + (event.blockNumber == null ? '—' : event.blockNumber));
      meta.append(node('span', '', '操作后余额 ' + amount(event.balance)));
      if (event.evidenceAvailable === false || zeroHash.test(String(event.evidence || ''))) meta.append(node('span', 'sc-points__evidence-missing', '未附证据指纹'));
      copy.append(meta);
      const transactionURL = safeURL(event.explorerUrl) || explorerLink('tx', event.transactionHash);
      const transaction = link('交易 ↗', transactionURL, 'sc-points__transaction');
      if (event.transactionHash) transaction.setAttribute('aria-label', '在区块浏览器查看交易 ' + event.transactionHash);
      lead.append(copy, transaction);
      item.append(lead);
      const details = node('details', 'sc-points__event-details');
      details.append(node('summary', '', '原因、证据与发放方'));
      const fields = node('dl', 'sc-points__fields');
      field(fields, '原因编码', event.reason || '无法解码，保留原始指纹');
      if (event.reasonHash) field(fields, '原因指纹', event.reasonHash);
      field(fields, '证据指纹', event.evidence ? zeroHash.test(event.evidence) ? '未附证据指纹（链上值为零）' : event.evidence : '本次未取得');
      field(fields, spending ? '扣除发起地址' : '积分发放地址', event.issuer || '本次未取得', explorerLink('address', event.issuer));
      field(fields, '交易哈希', event.transactionHash || '本次未取得', transactionURL);
      field(fields, '操作后余额', amount(event.balance) + ' 积分');
      details.append(fields, node('p', 'sc-points__evidence-note', '账本事件证明某地址发放或扣除了积分。证据指纹仍需对应原始材料，单个哈希不证明任务已经完成。'));
      item.append(details);
      return item;
    }
    function history() {
      const section = node('section', 'sc-points__history');
      section.setAttribute('aria-labelledby', id + '-history');
      const head = node('div', 'sc-points__history-head');
      const title = node('h3', '', '链上积分流水');
      title.id = id + '-history';
      head.append(title);
      const events = (state === 'ready' || state === 'partial') && result && Array.isArray(result.events) ? result.events : [];
      head.append(node('span', 'sc-points__history-count', state === 'partial' ? '部分记录 · ' + events.length + ' 笔' : state === 'ready' ? events.length + ' 笔链上事件' : state === 'synthetic' ? '不查询真实账本' : '等待可用账本'));
      section.append(head);
      if (events.length) {
        const list = node('ol', 'sc-points__event-list');
        events.slice().sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber) || Number(b.logIndex) - Number(a.logIndex)).forEach(event => list.append(eventCard(event)));
        section.append(list);
      } else {
        const messages = { loading: '正在读取当前学者标识的积分事件。', ready: '本次查询范围内没有积分流水。是否已有余额，以同一区块读取的余额为准。', partial: '已取得余额，但当前返回的流水为空。查询范围不完整，不能据此断言没有历史发放。', missing: '当前网络没有可用的积分部署，暂不能展示真实流水。', error: '此次读取未取得可靠流水。刷新后重试，不以空列表代替链上结果。', synthetic: '虚构样例不生成余额、流水或可点击的真实交易。' };
        section.append(node('p', 'sc-points__empty', messages[state] || messages.error));
      }
      if (result && result.history && result.history.scannedFromBlock != null) section.append(node('p', 'sc-points__scan-range', '本次事件范围：区块 ' + result.history.scannedFromBlock + ' → ' + (result.history.toBlock == null ? '—' : result.history.toBlock) + (result.history.complete ? ' · 已覆盖本次完整查询范围' : ' · 未覆盖全部历史')));
      if (result && result.deployment && result.deployment.address) {
        const footer = node('p', 'sc-points__contract');
        footer.append(node('span', '', 'PointsLedger · '), link(short(result.deployment.address) + ' ↗', result.deployment.explorer || explorerLink('address', result.deployment.address), ''));
        section.append(footer);
      }
      return section;
    }
    function render() {
      if (destroyed) return;
      const previousFocus = doc.activeElement;
      const hadRefreshFocus = previousFocus && root.contains(previousFocus) && previousFocus.dataset.pointsAction === 'refresh';
      const wrapper = node('section', 'sc-points');
      wrapper.dataset.state = state;
      wrapper.setAttribute('aria-labelledby', id + '-title');
      const head = node('div', 'sc-points__header');
      const identity = node('div', '');
      identity.append(node('p', 'sc-points__eyebrow', 'POINTS & TIERS / 各有依据'));
      const title = node('h2', '', '积分与档位');
      title.id = id + '-title';
      identity.append(title);
      const controls = node('div', 'sc-points__controls');
      const shared = rules();
      controls.append(node('span', 'sc-points__version', shared && shared.VERSION ? shared.VERSION + ' · 试行参数' : '规则等待加载'));
      const refresh = node('button', 'sc-points__refresh', state === 'loading' ? '读取中…' : '刷新账本 ↻');
      refresh.type = 'button';
      refresh.dataset.pointsAction = 'refresh';
      refresh.setAttribute('aria-label', '重新读取当前学者的链上积分和流水');
      refresh.setAttribute('aria-disabled', String(state === 'loading' || state === 'synthetic'));
      controls.append(refresh);
      head.append(identity, controls);
      wrapper.append(head);
      if (state === 'synthetic') wrapper.append(node('p', 'sc-points__synthetic', '虚构样例 / SYNTHETIC · 不代表任何真实学者的积分、资格或权益'));
      wrapper.append(summary());
      const notice = node('p', 'sc-points__status', statusMessage());
      notice.setAttribute('role', state === 'error' ? 'alert' : 'status');
      notice.setAttribute('aria-live', 'polite');
      wrapper.append(notice, history(), ruleTable());
      root.replaceChildren(wrapper);
      if (hadRefreshFocus || focusRefresh && (doc.activeElement === doc.body || doc.activeElement === root)) refresh.focus();
      if (state !== 'loading') focusRefresh = false;
    }
    async function refresh(retry) {
      const token = ++request;
      if (controller) controller.abort();
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      result = null;
      if (current.synthetic || /^SYNTHETIC(?:$|[-_:])/i.test(String(current.id || ''))) { state = 'synthetic'; render(); return; }
      state = 'loading'; render();
      try {
        if (!reader && host && host.ScholarCheckupPointsCore) {
          reader = host.ScholarCheckupPointsCore.createReader({ network: options.network });
          ownsReader = true;
        }
        if (!reader || typeof reader.read !== 'function') throw new Error('积分读取模块未加载，暂时无法查询链上账本。');
        const next = await reader.read(current, { signal: controller && controller.signal, retry: Boolean(retry) });
        if (destroyed || token !== request) return;
        result = next || { kind: 'error', message: '读取模块没有返回可用结果。' };
        state = ['ready', 'partial', 'missing', 'error', 'synthetic'].includes(result.kind) ? result.kind : 'error';
        if (state === 'ready' && result.history && result.history.complete === false) state = 'partial';
        if ((state === 'ready' || state === 'partial') && integer(result.balance, false) === null) { state = 'error'; result = { ...result, message: '未取得有效链上余额，不能以零积分替代。' }; }
      } catch (error) {
        if (destroyed || token !== request) return;
        state = 'error';
        result = { kind: 'error', message: error.name === 'AbortError' ? '本次读取已取消，请刷新重试。' : error.message || '积分读取失败，请稍后重试。' };
      }
      render();
    }
    function handleClick(event) {
      const button = event.target.closest('[data-points-action="refresh"]');
      if (!button || !root.contains(button) || state === 'loading' || state === 'synthetic') return;
      focusRefresh = doc.activeElement === button;
      refresh(true);
    }
    root.addEventListener('click', handleClick);
    const instance = {
      update(next) { if (destroyed) return; current = next || {}; focusRefresh = false; refresh(false); },
      destroy() {
        if (destroyed) return;
        destroyed = true; request += 1;
        if (controller) controller.abort();
        if (ownsReader && reader && typeof reader.destroy === 'function') reader.destroy();
        root.removeEventListener('click', handleClick);
        root.replaceChildren(); instances.delete(root);
      }
    };
    instances.set(root, instance);
    refresh(false);
    return instance;
  }
  return Object.freeze({ mount });
});
