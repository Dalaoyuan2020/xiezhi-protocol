(function () {
  'use strict';
  const core = window.ScholarOrgCore;
  const $ = id => document.getElementById(id);
  let data = null;
  let examples = [];
  let requestVersion = 0;
  let current = null;
  let mode = 'mock';
  let initialized = false;
  let chainView = null;
  let chainVersion = 0;
  const lastQueries = { mock: undefined, chain: undefined };
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const date = value => dateFormat.format(new Date(value));
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function setQuery(value) {
    $('query').value = value;
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('q', value); else url.searchParams.delete('q');
    if (mode === 'chain') url.searchParams.set('mode', 'chain'); else url.searchParams.delete('mode');
    window.history.replaceState(null, '', url);
  }
  function disposeChain() {
    chainVersion++;
    if (chainView) chainView.destroy();
    chainView = null;
    $('chain-panel').replaceChildren();
  }
  function searchChain(value, updateUrl) {
    disposeChain();
    const query = core.parseQuery(value);
    if (!query.error && query.type === 'author' && !/^A\d+$/.test(query.value)) {
      query.error = /^(DEMO-|SYNTHETIC)/.test(query.value) ? 'DEMO / SYNTHETIC ID 仅用于虚构快照，不能查询真实链。请切回虚构快照，或输入真实 OpenAlex 作者 ID。' : '链上作者查询需要 A 开头的数字 ID（如 A5126602136），也可粘贴完整 OpenAlex 作者链接。';
    }
    $('query-error').hidden = !query.error;
    $('query').setAttribute('aria-invalid', String(Boolean(query.error)));
    $('chain-query-label').hidden = true;
    $('chain-empty').hidden = false;
    $('results').hidden = true;
    if (query.error) {
      $('query-error').textContent = query.error;
      $('source-status').textContent = '链上只读 · 等待有效查询';
      $('status').textContent = '未发送链上查询，请核对输入。';
      return;
    }
    if (updateUrl) setQuery(query.value);
    lastQueries.chain = query.value;
    $('chain-empty').hidden = true;
    $('chain-query-label').hidden = false;
    $('chain-query-label').textContent = (query.type === 'hash' ? '内容指纹：0x' : '作者 ID：') + query.value;
    if (!window.ScholarCheckupChain) {
      $('status').textContent = '链上查询组件未加载，请刷新页面后重试。';
      $('source-status').textContent = '链上组件不可用';
      return;
    }
    const own = chainVersion;
    const normalized = query.type === 'hash' ? { contentHash: '0x' + query.value } : { id: query.value };
    chainView = window.ScholarCheckupChain.mount($('chain-panel'), normalized, {
      onStatus(state) {
        if (mode !== 'chain' || own !== chainVersion) return;
        $('source-status').textContent = state.label;
        $('status').textContent = state.kind === 'snapshot' ? '尚未部署，未取得链上行为。可以点击“返回虚构快照”查看规则演示；不会自动把虚构记录放入链上结果。' : state.label + '。机构授权尚待核验，当前不生成真实行为风险提示。';
      }
    });
  }
  function setMode(next, options = {}) {
    if (initialized && next === mode) return;
    if (initialized) lastQueries[mode] = $('query').value;
    initialized = true;
    mode = next;
    requestVersion++;
    disposeChain();
    $('mode-mock').setAttribute('aria-pressed', String(mode === 'mock'));
    $('mode-chain').setAttribute('aria-pressed', String(mode === 'chain'));
    $('mock-examples').hidden = mode !== 'mock';
    $('chain-results').hidden = mode !== 'chain';
    $('results').hidden = true;
    $('query-error').hidden = true;
    $('query').setAttribute('aria-invalid', 'false');
    $('load-error').hidden = true;
    $('chain-query-label').hidden = true;
    $('chain-empty').hidden = false;
    const query = Object.hasOwn(options, 'query') ? options.query : lastQueries[mode];
    $('query').value = query || '';
    if (options.updateUrl !== false) setQuery(query || '');
    if (mode === 'chain') {
      $('search-button').disabled = false;
      $('source-status').textContent = '链上只读 · 尚未查询';
      $('source-hint').textContent = '查询 BOT Chain 原始行为，不混入虚构快照。';
      $('query-help').textContent = '仅支持真实 OpenAlex 作者 ID、作者链接或完整 64 位十六进制指纹。DEMO ID 仅适用虚构快照。';
      $('footer-source').textContent = '真实合约只读 · 无内容上传 · 无写入交易';
      $('status').textContent = '已切换链上只读。输入真实查询条件后检查部署状态。';
      if (query !== undefined && query !== '') searchChain(query, options.updateUrl !== false);
    } else {
      $('source-status').textContent = '模拟数据 · 未连接链上行为';
      $('source-hint').textContent = '用虚构记录演示跨机构核查规则。';
      $('query-help').textContent = '支持学者 ID、OpenAlex 作者链接或完整十六进制哈希。以下案例全部虚构，与真实学者无关。';
      $('footer-source').textContent = '固定虚构快照 · 无内容上传 · 无真实链上交易';
      if (data) {
        $('search-button').disabled = false;
        document.querySelectorAll('[data-example]').forEach(button => { button.disabled = false; });
        search(query === undefined ? examples[0]?.query || 'DEMO-MULTI' : query, options.updateUrl !== false);
      } else load(query);
    }
  }
  function markExample(query) {
    document.querySelectorAll('[data-example]').forEach(button => {
      const sample = examples.find(item => item.key === button.dataset.example);
      const parsed = sample && core.parseQuery(sample.query);
      button.setAttribute('aria-pressed', String(Boolean(parsed && parsed.type === query.type && parsed.value === query.value)));
    });
  }
  function drawTimeline(events, query) {
    const timeline = $('timeline');
    timeline.replaceChildren();
    $('empty').hidden = events.length !== 0;
    $('timeline-count').textContent = events.length + ' EVENTS';
    $('timeline-scope').textContent = (query.type === 'hash' ? '仅显示当前稿件指纹；关联作者显示在每条记录中。' : '仅显示当前作者在此快照中的行为记录。') + ' 时间均为 UTC+8，按最近发生排序。';
    for (const event of events) {
      const item = el('li', 'timeline-item');
      item.id = event.id;
      item.dataset.kind = event.kind;
      const glyph = { submit: '↗', review: '✓', reproduce: '⟳', claim: '◇' }[event.kind];
      const dot = el('span', 'timeline-dot', glyph);
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot);
      const header = el('div', 'event-header');
      header.append(el('span', 'event-kind', core.KINDS[event.kind]), el('span', 'event-org', event.org));
      const time = el('time', '', date(event.time));
      time.dateTime = event.time;
      header.append(time);
      item.append(header);
      const body = el('div', 'event-body');
      body.append(el('p', 'event-author', event.author_name + ' · ' + event.author_id));
      body.append(el('small', '', '稿件指纹 / 模拟哈希'), el('code', '', event.content_hash));
      if (query.type !== 'hash') {
        const button = el('button', 'hash-button', '查看此指纹的跨机构记录 ↗');
        button.type = 'button';
        button.addEventListener('click', () => { search(event.content_hash); $('results').scrollIntoView({ behavior: motion() }); });
        body.append(button);
      }
      if (event.note) body.append(el('p', 'event-note', event.note));
      item.append(body);
      timeline.append(item);
    }
  }
  function motion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'; }
  function showEvidence(alert) {
    if (alert.type === 'frequency' && current.query.type === 'hash') search(alert.author);
    const ids = new Set(alert.evidenceIds);
    const nodes = [...document.querySelectorAll('.timeline-item')];
    nodes.forEach(node => { node.dataset.highlight = String(ids.has(node.id)); });
    const target = nodes.find(node => ids.has(node.id));
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: motion() });
      $('status').textContent = '已标出相关证据记录；所有记录均来自固定虚构快照。';
    }
  }
  function drawAlerts(result) {
    const root = $('alerts');
    root.replaceChildren();
    $('risk-count').textContent = result.alerts.length + ' SIGNALS';
    if (!result.alerts.length) {
      const clean = el('div', 'no-signal', result.events.length ? '◇ 当前快照未触发提示' : '— 暂无可核查记录');
      clean.append(el('p', '', '记录覆盖有限。这不构成信誉背书，也不能据此判断是否存在其他问题。'));
      root.append(clean);
      return;
    }
    for (const alert of result.alerts) {
      const card = el('article', 'alert');
      card.dataset.type = alert.type;
      if (alert.type === 'multiple') {
        card.append(el('span', 'alert-label', 'CROSS-INSTITUTION / 待核实'));
        card.append(el('h3', '', '疑似一稿多投，请核实'));
        card.append(el('p', '', '同一稿件指纹在连续 30 天内，出现于 ' + alert.orgCount + ' 家不同机构的投稿记录。'));
        card.append(el('code', '', alert.hash));
        card.append(el('p', '', alert.orgs.join(' / ')));
        card.append(el('p', '', date(alert.start) + ' — ' + date(alert.end) + '（UTC+8）'));
        card.append(el('p', '', '请核对投稿状态、机构授权与时间关系；现有记录不能判断是否同时在审。'));
      } else {
        card.append(el('span', 'alert-label', 'SUBMISSION RATE / 待核实'));
        card.append(el('h3', '', '投稿频率异常'));
        card.append(el('p', '', alert.author + ' 在快照截止前 7 天内，提交了 ' + alert.count + ' 篇不同指纹的稿件。'));
        if (result.query.type === 'hash') card.append(el('p', '', '此项统计关联作者的全部投稿，包含其他稿件；上方计数和时间线仍仅限当前指纹。'));
        card.append(el('p', '', '频率只能提示需要进一步核查；不同指纹不代表内容不同。'));
      }
      const button = el('button', '', alert.type === 'frequency' && result.query.type === 'hash' ? '查看该作者的投稿证据 →' : '定位相关记录 ↓');
      button.type = 'button';
      button.addEventListener('click', () => showEvidence(alert));
      card.append(button);
      root.append(card);
    }
  }
  function search(value, updateUrl = true) {
    if (mode === 'chain') return searchChain(value, updateUrl);
    const query = core.parseQuery(value);
    $('query-error').hidden = !query.error;
    $('query').setAttribute('aria-invalid', String(Boolean(query.error)));
    if (query.error) {
      $('query-error').textContent = query.error;
      $('results').hidden = true;
      $('status').textContent = '请修改查询条件后重试。';
      return;
    }
    if (!data) return;
    if (updateUrl) setQuery(query.value);
    current = core.analyze(data, query);
    markExample(query);
    $('results').hidden = false;
    $('result-type').textContent = query.type === 'hash' ? 'MANUSCRIPT FINGERPRINT / 稿件档案' : 'AUTHOR DOSSIER / 学者档案';
    $('result-title').classList.toggle('hash-title', query.type === 'hash');
    $('result-title').textContent = query.type === 'hash' ? query.value : (current.events[0]?.author_name || query.value);
    $('result-subtitle').textContent = query.type === 'hash' ? '完整文件指纹 · ' + current.authors.length + ' 位关联作者 · 虚构演示' : query.value + ' · 虚构演示';
    $('snapshot').textContent = 'SNAPSHOT / 固定快照\n' + date(data.asOf) + ' UTC+8';
    $('stats').replaceChildren();
    for (const [key, label] of [['events', '行为记录'], ['submissions', '投稿记录'], ['manuscripts', '稿件指纹'], ['orgs', '关联机构']]) {
      const item = el('div', 'stat');
      item.append(el('strong', '', String(current.stats[key])), el('span', '', label));
      $('stats').append(item);
    }
    drawTimeline(current.events, query);
    drawAlerts(current);
    $('status').textContent = '找到 ' + current.events.length + ' 条匹配记录，' + current.alerts.length + ' 项待核实信号。' + (data.ignored ? ' 已忽略 ' + data.ignored + ' 条无效、未来或重复记录。' : '全部来自虚构快照。');
  }
  async function load(preferredQuery) {
    if (mode !== 'mock') return;
    const version = ++requestVersion;
    $('load-error').hidden = true;
    $('status').textContent = '正在加载虚构行为快照…';
    $('search-button').disabled = true;
    document.querySelectorAll('[data-example]').forEach(button => { button.disabled = true; });
    try {
      const response = await fetch('org-mock.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const raw = await response.json();
      if (version !== requestVersion) return;
      data = core.normalize(raw);
      examples = Array.isArray(raw.examples) ? raw.examples : [];
      const requested = preferredQuery === undefined ? new URL(window.location.href).searchParams.get('q') : preferredQuery;
      const query = requested === null ? examples[0]?.query || 'DEMO-MULTI' : requested;
      $('query').value = query;
      search(query, false);
    } catch (error) {
      if (version !== requestVersion) return;
      data = null;
      $('results').hidden = true;
      $('load-error').hidden = false;
      $('load-message').textContent = '行为快照加载失败。请通过本地 HTTP 服务打开页面，或检查网络后重试。';
      $('status').textContent = '尚无可用数据；未生成任何风险判断。';
    } finally {
      if (version === requestVersion) {
        $('search-button').disabled = !data;
        document.querySelectorAll('[data-example]').forEach(button => { button.disabled = !data; });
      }
    }
  }
  $('search-form').addEventListener('submit', event => { event.preventDefault(); search($('query').value); });
  $('retry').addEventListener('click', () => load($('query').value || undefined));
  $('mode-mock').addEventListener('click', () => setMode('mock'));
  $('mode-chain').addEventListener('click', () => setMode('chain'));
  $('return-mock').addEventListener('click', () => setMode('mock'));
  document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
    const sample = examples.find(item => item.key === button.dataset.example);
    if (sample) search(sample.query);
  }));
  const initial = new URL(window.location.href);
  const initialOptions = { updateUrl: false };
  if (initial.searchParams.has('q')) initialOptions.query = initial.searchParams.get('q');
  setMode(initial.searchParams.get('mode') === 'chain' ? 'chain' : 'mock', initialOptions);
}());
