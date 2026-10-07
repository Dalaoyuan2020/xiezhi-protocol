(function () {
  'use strict';
  const core = window.ScholarOrgCore;
  const network = window.ScholarCheckupChain.getNetwork();
  const $ = id => document.getElementById(id);
  let data = null;
  let examples = [];
  let requestVersion = 0;
  let current = null;
  let mode = 'mock';
  let initialized = false;
  let chainView = null;
  let chainVersion = 0;
  let journalController = null;
  let journalVersion = 0;
  let chainManifest = { kind: 'missing', journals: [] };
  let chainState = null;
  let chainQuery = null;
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
    url.searchParams.set('mode', mode);
    window.history.replaceState(null, '', url);
  }
  function disposeChain() {
    chainVersion++;
    journalVersion++;
    if (journalController) journalController.abort();
    if (chainView) chainView.destroy();
    chainView = null;
    chainState = null;
    chainQuery = null;
    $('chain-panel').replaceChildren();
    $('chain-timeline').replaceChildren();
    $('chain-lifecycle-timeline').hidden = true;
    $('same-author-receipt').hidden = true;
    drawAssessment($('chain-assessment'), null, 'chain');
  }
  async function refreshJournals(own) {
    const serial = ++journalVersion;
    if (journalController) journalController.abort();
    journalController = new AbortController();
    chainManifest = { kind: 'loading', journals: [] };
    $('journals-status').textContent = '正在读取公开期刊名单…';
    if (chainState) drawChainState();
    try {
      const manifest = await window.ScholarCheckupChain.loadJournals({ signal: journalController.signal });
      if (mode !== 'chain' || own !== chainVersion || serial !== journalVersion) return null;
      chainManifest = manifest;
      $('journals-status').textContent = manifest.kind === 'ready' ? '可信期刊名单：' + manifest.journals.map(j => j.name).join(' / ') + '；同时核对登记地址与机构指纹。' : '可信期刊名单未就绪：' + manifest.message;
      if (chainState) drawChainState();
      return manifest;
    } catch (error) {
      if (error.name === 'AbortError' || own !== chainVersion) return null;
      chainManifest = { kind: 'error', journals: [], message: '期刊名单读取失败。' };
      $('journals-status').textContent = chainManifest.message;
      if (chainState) drawChainState();
      return chainManifest;
    }
  }
  async function searchChain(value, updateUrl) {
    disposeChain();
    const own = chainVersion;
    let query = String(value || '').trim() ? core.parseQuery(value) : null;
    if (query && !query.error && query.type === 'author' && !/^A\d+$/.test(query.value)) {
      query.error = /^(DEMO-|SYNTHETIC)/.test(query.value) ? 'DEMO / SYNTHETIC ID 仅用于虚构快照，不能查询真实链。请切回虚构快照，或输入真实 OpenAlex 作者 ID。' : '链上作者查询需要 A 开头的数字 ID（如 A5126602136），也可粘贴完整 OpenAlex 作者链接。';
    }
    $('query-error').hidden = !query?.error;
    $('query').setAttribute('aria-invalid', String(Boolean(query?.error)));
    $('chain-query-label').hidden = true;
    $('chain-empty').hidden = false;
    $('results').hidden = true;
    if (query?.error) {
      $('query-error').textContent = query.error;
      $('source-status').textContent = '链上只读 · 等待有效查询';
      $('status').textContent = '未发送链上查询，请核对输入。';
      return;
    }
    if (!window.ScholarCheckupChain) {
      $('status').textContent = '链上查询组件未加载，请刷新页面后重试。';
      $('source-status').textContent = '链上组件不可用';
      return;
    }
    $('source-status').textContent = network.label + ' · 检查期刊名单';
    const manifest = await refreshJournals(own);
    if (!manifest || mode !== 'chain' || own !== chainVersion) return;
    if (!query && manifest.manuscript) query = core.parseQuery(manifest.manuscript);
    if (!query) {
      $('source-status').textContent = network.label + ' · 等待部署与期刊名单';
      $('status').textContent = '尚无可用的默认演示稿件。期刊名单发布后可刷新；也可手动输入作者 ID 或稿件指纹查询原始记录。';
      return;
    }
    if (updateUrl) setQuery(query.value); else $('query').value = query.value;
    lastQueries.chain = query.value;
    chainQuery = query;
    $('chain-empty').hidden = true;
    $('chain-query-label').hidden = false;
    $('chain-query-label').textContent = (query.type === 'hash' ? '内容指纹：0x' : '作者 ID：') + query.value;
    const normalized = query.type === 'hash' ? { contentHash: '0x' + query.value } : { id: query.value };
    let loads = 0;
    chainView = window.ScholarCheckupChain.mount($('chain-panel'), normalized, {
      reader: window.ScholarCheckupChain.createReader(),
      onStatus(state) {
        if (mode !== 'chain' || own !== chainVersion) return;
        chainState = state;
        $('source-status').textContent = state.label;
        $('status').textContent = state.kind === 'snapshot' ? '尚未部署，未取得链上行为。可以返回虚构快照演示；这里不会混入虚构结果。' : state.label + '。仅名单内地址与机构指纹匹配的记录用于判断。';
        if (state.kind === 'loading' && loads++ > 0) refreshJournals(own);
        drawChainState();
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
      $('source-status').textContent = network.label + ' · 尚未查询';
      $('source-hint').textContent = '查询 ' + network.label + ' 原始行为，不混入虚构快照。';
      $('query-help').textContent = '仅支持真实 OpenAlex 作者 ID、作者链接或完整 64 位十六进制指纹。DEMO ID 仅适用虚构快照。';
      $('footer-source').textContent = network.label + ' · 只读 · 无内容上传 · 无写入交易';
      $('status').textContent = '已切换链上只读。正在检查期刊名单与默认演示稿件。';
      searchChain(query || '', options.updateUrl !== false);
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
  function drawAssessment(root, result, source) {
    root.replaceChildren();
    const assessment = result?.assessment;
    const status = assessment?.status || 'unknown';
    root.dataset.state = status;
    root.append(el('p', 'eyebrow', source === 'chain' ? 'VERIFIED SOURCES / 可信名单核查' : 'FICTIONAL SNAPSHOT / 虚构生命周期'));
    const multiple = result?.alerts.find(a => a.type === 'multiple');
    const title = status === 'unknown' ? '状态未知 · ' + (assessment?.reason || '等待可信期刊与链上记录') : status === 'risk' ? multiple ? multiple.orgCount + ' 家同时在审 · 疑似一稿多投' : '投稿频率异常 · 请核实' : '当前可信记录未触发提示';
    root.append(el('h2', '', title));
    if (assessment) {
      root.append(el('p', '', '在审记录 ' + assessment.openCount + ' 条 · 已匹配结案 ' + assessment.closedCount + ' 条 · 未认证来源 ' + assessment.untrustedCount + ' 条（不计入判断）'));
    }
    root.append(el('p', '', status === 'clear' ? '绿色仅说明当前可用的可信记录没有触发规则，不能证明不存在其他投稿或学术问题。' : status === 'risk' ? '请核对在审状态与机构签发事实。这里的提示不等于违规认定，也不会直接加减分。' : '名单缺失、没有可信投稿或链上读取未完成时，不能判断是否存在并行在审。'));
    if (source === 'mock') root.append(el('small', '', '本区域全部为虚构演示，任何模拟操作均不生成真实链上交易。'));
  }
  function drawChainState() {
    const state = chainState;
    if (!state || !['ready', 'partial'].includes(state.kind) || !chainQuery) {
      drawAssessment($('chain-assessment'), null, 'chain');
      $('chain-lifecycle-timeline').hidden = true;
      $('same-author-receipt').hidden = true;
      return;
    }
    const subject = String(state.subject || '').toLowerCase();
    const chainData = core.normalizeChain(state.records, chainManifest, { asOf: state.checkedAt, subject, authorId: chainQuery.type === 'author' ? chainQuery.value : null });
    const query = chainQuery.type === 'hash' ? chainQuery : { type: 'subject', value: subject };
    const result = core.analyze(chainData, query);
    drawAssessment($('chain-assessment'), result, 'chain');
    $('chain-lifecycle-timeline').hidden = false;
    const timeline = $('chain-timeline');
    timeline.replaceChildren();
    for (const event of result.events.filter(e => ['submit', 'close', 'unknown'].includes(e.kind))) {
      const item = el('li', 'timeline-item');
      item.id = event.id;
      item.dataset.kind = event.kind;
      const dot = el('span', 'timeline-dot', event.kind === 'close' ? '✓' : '↗'); dot.setAttribute('aria-hidden', 'true'); item.append(dot);
      const header = el('div', 'event-header');
      header.append(el('span', 'event-kind', core.KINDS[event.kind] + (event.kind === 'close' ? ' · ' + event.close_reason : '')), el('span', 'event-org', event.org_name));
      const time = el('time', '', date(event.time)); time.dateTime = event.time; header.append(time); item.append(header);
      const body = el('div', 'event-body');
      body.append(el('p', event.trusted ? 'trust-tag' : 'trust-tag unverified', event.trusted ? '可信名单：地址与机构指纹匹配' : '未认证来源，不计入判断'));
      body.append(el('small', '', '登记人'), el('code', '', event.recorder), el('small', '', '机构指纹'), el('code', '', event.org), el('small', '', '主体指纹'), el('code', '', event.subject), el('small', '', '稿件指纹'), el('code', '', event.content_hash));
      if (event.transactionHash && /^0x[\da-f]{64}$/i.test(event.transactionHash)) {
        const link = el('a', 'event-transaction', '查看真实交易 ↗'); link.href = network.explorer + '/tx/' + event.transactionHash; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link);
      }
      if (event.note) body.append(el('p', 'event-note', event.note));
      item.append(body); timeline.append(item);
    }
    if (!timeline.children.length) timeline.append(el('li', 'scope', '当前查询没有可展示的投稿或结案记录；下方保留完整原始行为。'));
    const linked = chainQuery.type === 'author' && /^A\d+$/.test(chainQuery.value) && /^0x[\da-f]{64}$/.test(subject);
    $('same-author-receipt').hidden = !linked;
    if (linked) $('same-author-receipt').href = 'checkup.html?case=' + encodeURIComponent(chainQuery.value) + '&view=receipt';
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
      const glyph = { submit: '↗', close: '✓', review: '✓', reproduce: '⟳', claim: '◇' }[event.kind] || '◇';
      const dot = el('span', 'timeline-dot', glyph);
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot);
      const header = el('div', 'event-header');
      header.append(el('span', 'event-kind', core.KINDS[event.kind] + (event.kind === 'close' ? ' · ' + event.close_reason : '')), el('span', 'event-org', event.org));
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
        card.append(el('p', '', '同一稿件指纹目前仍有 ' + alert.orgCount + ' 家不同机构在审；这些投稿尚未匹配同一登记人的对应结案。'));
        card.append(el('code', '', alert.hash));
        card.append(el('p', '', alert.orgs.join(' / ')));
        card.append(el('p', '', date(alert.start) + ' — ' + date(alert.end) + '（UTC+8）'));
        card.append(el('p', '', '结案需同时匹配登记人、机构、作者主体和稿件；仅同名机构的记录不能替他人结案。'));
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
      if (alert.type === 'multiple' && result.source === 'mock') {
        const close = el('button', 'simulate-close', '模拟 ' + alert.events[0].org_name + ' 结案 → 变绿');
        close.type = 'button';
        close.addEventListener('click', () => simulateClose(alert.events[0]));
        card.append(close);
      }
      root.append(card);
    }
  }
  function simulateClose(submission) {
    if (mode !== 'mock' || data?.source !== 'mock') return;
    const sequence = Math.max(...data.events.map(e => e.sequence), -1) + 1;
    const closure = { ...submission, id: 'event-mock-close-' + sequence, sequence, kind: 'close', time: data.asOf, timeMs: data.asOfMs, close_reason: '拒稿', note: '本页模拟期刊拒稿结案，不修改原始快照，不生成真实交易。' };
    data = { ...data, events: [...data.events, closure].sort((a, b) => b.timeMs - a.timeMs || b.sequence - a.sequence) };
    search(current.query.value);
    $('status').textContent = '已模拟 ' + submission.org_name + ' 结案。点击“重置虚构演示”可恢复红灯；没有真实链上交易。';
    $('mock-assessment').scrollIntoView({ behavior: motion(), block: 'center' });
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
    drawAssessment($('mock-assessment'), current, 'mock');
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
  $('refresh-chain').addEventListener('click', () => searchChain($('query').value, true));
  $('reset-mock').addEventListener('click', () => load(examples.find(e => e.key === 'multiple')?.query));
  $('org-present').addEventListener('click', () => {
    const active = document.body.dataset.presentation !== 'true';
    document.body.dataset.presentation = String(active);
    $('org-present').setAttribute('aria-pressed', String(active));
    const label = $('org-present').querySelector('span');
    if (label) label.textContent = active ? '退出投影' : '投影模式';
    else $('org-present').textContent = active ? '退出投影' : '投影模式';
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.dataset.presentation === 'true') $('org-present').click();
  });
  document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
    const sample = examples.find(item => item.key === button.dataset.example);
    if (sample) search(sample.query);
  }));
  const initial = new URL(window.location.href);
  const initialOptions = { updateUrl: false };
  if (initial.searchParams.has('q')) initialOptions.query = initial.searchParams.get('q');
  async function start() {
    if (initial.searchParams.has('mode') || initial.searchParams.has('q')) {
      setMode(initial.searchParams.get('mode') === 'chain' ? 'chain' : 'mock', initialOptions);
      return;
    }
    $('status').textContent = '正在检查部署与期刊名单，选择可用的数据来源…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let available = false;
    try {
      const [manifest, response] = await Promise.all([
        window.ScholarCheckupChain.loadJournals({ signal: controller.signal }),
        fetch(network.deploymentPath, { cache: 'no-store', signal: controller.signal })
      ]);
      if (manifest.kind === 'ready' && manifest.manuscript && response.ok) {
        window.ScholarCheckupChain.validateDeployment(await response.json(), network.key);
        available = true;
      }
    } catch (_) { /* Absent deployment keeps the honest fictional preview. */ }
    finally { clearTimeout(timer); }
    if (initialized) return;
    setMode(available ? 'chain' : 'mock', initialOptions);
  }
  start();
}());
