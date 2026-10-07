(function () {
  'use strict';
  const core = window.ScholarCheckupCore;
  const byId = id => document.getElementById(id);
  const caseRoot = byId('sc-cases');
  const loading = byId('sc-load-state');
  const fallback = byId('sc-file-fallback');
  const routeNotice = byId('sc-route-notice');
  const retryButton = byId('sc-retry-data');
  const presentationButton = byId('sc-present');
  const panels = { card: byId('sc-card-panel'), receipt: byId('sc-receipt-panel') };
  const tabs = { card: byId('sc-tab-card'), receipt: byId('sc-tab-receipt') };
  let dataset = null;
  let selected = null;
  let currentView = 'card';
  let loadVersion = 0;
  const records = new Map();
  const caseViews = new Map();

  function announce(message) { byId('sc-announcer').textContent = message; }
  function showChainStatus(status) {
    const target = byId('sc-chain-mode');
    if (!target) return;
    const state = status || {};
    target.dataset.state = state.kind || 'loading';
    target.querySelector('span').textContent = state.label || '正在检查部署 · 快照演示';
  }
  function openLocalClaim(id) {
    const view = caseViews.get(id);
    if (!view || selected?.id !== id) return;
    showView('receipt', true);
    byId('sc-local-receipt').open = true;
    view.receipt.openClaim();
  }
  function normalizeId(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text === 'SYNTHETIC') return text;
    const match = /^(?:https:\/\/openalex\.org\/)?(A[0-9]+)$/.exec(text);
    return match ? match[1] : null;
  }
  function showError(error, source = 'file') {
    loading.hidden = false;
    loading.dataset.error = 'true';
    loading.textContent = (source === 'network' ? '默认案例加载失败：' : '案例文件无法读取：') +
      (error.message || String(error)) + (source === 'network' ? '。可重试加载，或选择本地案例文件。' : '。请检查文件内容后重新选择。');
    fallback.hidden = false;
    if (retryButton) {
      retryButton.hidden = location.protocol === 'file:';
      retryButton.disabled = false;
    }
  }
  function clearRouteNotice() {
    if (!routeNotice) return;
    routeNotice.hidden = true;
    routeNotice.textContent = '';
  }
  async function loadCandidate(id) {
    if (!normalizeId(id) || id === 'SYNTHETIC') return;
    const version = loadVersion;
    try {
      const response = await fetch('search-data.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('候选快照读取失败');
      const data = await response.json();
      if (version !== loadVersion || selected) return;
      const person = data.candidates?.find(item => item.id === id);
      if (!person) return;
      const box = byId('sc-candidate');
      const node = (tag, text, cls) => {
        const element = document.createElement(tag);
        element.textContent = text;
        if (cls) element.className = cls;
        return element;
      };
      box.replaceChildren();
      box.append(node('p', 'IDENTITY FIRST / 同名候选公开档案', 'sc-eyebrow'));
      const title = node('h2', person.name); title.id = 'sc-candidate-name';
      box.append(title, node('p', '已选中这个候选。当前尚无完整的五维评分快照，暂未评分。'));
      const list = node('dl', '');
      const rows = [
        ['OpenAlex ID', person.id],
        ['候选单位线索', (person.displayInstitutions || person.institutions)?.join(' / ') || '数据未注明'],
        ['研究方向', (person.displayTopics || person.topics)?.join(' / ') || '数据未注明'],
        ['快照论文数', Number.isSafeInteger(person.works) ? String(person.works) : '数据未注明'],
        ['ORCID', person.orcid || '数据未注明'],
        ['快照日期', person.snapshotDate || data.generated || '数据未注明']
      ];
      rows.forEach(([label, value]) => { const row = node('div', ''); row.append(node('dt', label), node('dd', value)); list.append(row); });
      box.append(list);
      box.append(node('p', '公开库当前单位字段：' + (person.institutions?.join(' / ') || '数据未注明')));
      if (person.note) box.append(node('p', person.note));
      box.append(node('p', '公开库可能合并或拆散同名者；候选记录不代表已经核验本人身份。'));
      const links = node('div', '', 'sc-candidate-links');
      const source = node('a', '查看 OpenAlex 原始档案 ↗');
      source.href = 'https://api.openalex.org/authors/' + id; source.target = '_blank'; source.rel = 'noopener';
      const back = node('a', '返回搜索，重新辨认 →'); back.href = 'index.html?q=Zhiyuan%20Lyu';
      const chain = node('a', '机构台查看此档案 ↗'); chain.href = 'org.html?mode=chain&q=' + encodeURIComponent(id);
      links.append(back, source, chain); box.append(links);
      box.hidden = false;
      clearRouteNotice();
      document.querySelectorAll('[data-journey]').forEach(button => { button.disabled = true; button.removeAttribute('aria-current'); });
      showChainStatus({ kind: 'snapshot', label: '候选快照 · 暂未评分' });
      document.title = person.name + ' · 獬豸协议 Xiezhi';
      announce('已选择 ' + person.name + '，暂无五维评分快照。');
    } catch (_) {
      if (version === loadVersion && !selected) {
        routeNotice.textContent = '候选档案暂时无法读取。可返回搜索重试，或选择已有评分的演示案例。';
        routeNotice.hidden = false;
      }
    }
  }
  function setPresentation(enabled) {
    const active = Boolean(enabled);
    document.body.dataset.presentation = String(active);
    if (presentationButton) {
      presentationButton.setAttribute('aria-pressed', String(active));
      presentationButton.setAttribute('aria-label', active ? '退出投影模式' : '开启投影模式');
      const label = presentationButton.querySelector('span');
      if (label) label.textContent = active ? '退出投影' : '投影模式';
      else presentationButton.textContent = active ? '退出投影' : '投影模式';
    }
    announce(active ? '已开启投影模式。按 Escape 可退出。' : '已退出投影模式。');
  }
  function showView(view, focus = false) {
    if (!panels[view]) return;
    currentView = view;
    document.querySelectorAll('[data-journey]').forEach(button => {
      if (button.dataset.journey === view) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    for (const key of Object.keys(panels)) {
      panels[key].hidden = key !== view;
      tabs[key].setAttribute('aria-selected', String(key === view));
      tabs[key].tabIndex = key === view ? 0 : -1;
    }
    document.title = (view === 'card' ? '体检卡' : '上链收据') + ' · 獬豸协议 Xiezhi';
    if (focus) tabs[view].focus({ preventScroll: true });
    if (selected && /^https?:$/.test(location.protocol)) {
      const url = new URL(location.href);
      if (view === 'receipt') url.searchParams.set('view', 'receipt');
      else url.searchParams.delete('view');
      history.replaceState(null, '', url.href);
    }
    window.dispatchEvent(new CustomEvent('scholar-checkup:view', { detail: { view, caseId: selected?.id } }));
  }
  function handleClaim(value) {
    const view = caseViews.get(value.id);
    const record = records.get(value.id);
    if (!view || !record) throw new Error('案例数据已重新加载，请重新打开认领');
    const next = core.recomputeAfterClaim(record);
    records.set(next.id, next);
    view.record = next;
    view.card.update(next);
    view.actions.update(next);
    // The receipt component owns its current animation and renders the returned state.
    if (selected?.id === next.id) {
      selected = next;
      announce('本地模拟认领已记录。按现有五维重新合计 ' + next.score + ' 分；新增论文指标待回填。');
    }
    window.dispatchEvent(new CustomEvent('scholar-checkup:claimed', { detail: { caseId: next.id, claim: next.claim, score: next.score, localWorks: next.localWorks, simulation: true } }));
    return next;
  }
  function selectCase(requestedId) {
    if (!dataset) throw new Error('案例文件尚未加载');
    const id = normalizeId(requestedId);
    const record = records.get(id);
    if (!record) throw new Error('案例不存在，请从演示档案中选择');
    clearRouteNotice();
    byId('sc-candidate').hidden = true;
    document.querySelectorAll('[data-journey]').forEach(button => { button.disabled = false; });
    if (selected?.id === id) return;
    // Keep completed receipts and claims in this page session, including when switching cases.
    // Close open dialogs before hiding their case so a previous identity never overlays the next.
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    for (const view of caseViews.values()) {
      view.cardRoot.hidden = true;
      view.receiptRoot.hidden = true;
      view.actionsRoot.hidden = true;
      view.chainRoot.hidden = true;
    }
    selected = record;
    let view = caseViews.get(id);
    if (!view) {
      const cardRoot = document.createElement('div');
      const receiptRoot = document.createElement('div');
      const actionsRoot = document.createElement('div');
      const chainRoot = document.createElement('div');
      cardRoot.dataset.caseId = id;
      receiptRoot.dataset.caseId = id;
      byId('sc-card-root').append(cardRoot);
      byId('sc-receipt-root').append(receiptRoot);
      byId('sc-actions-root').append(actionsRoot);
      byId('sc-chain-root').append(chainRoot);
      const card = window.ScholarCheckupCard.mount(cardRoot, record, {
        onReceipt: () => { showView('receipt', true); },
        onClaim: () => openLocalClaim(id),
      });
      const receipt = window.ScholarCheckupReceipt.mount(receiptRoot, record, { onClaim: handleClaim, onBack: () => showView('card', true) });
      const actions = window.ScholarCheckupActions.mount(actionsRoot, record, { onClaim: () => openLocalClaim(id) });
      view = { record, cardRoot, receiptRoot, actionsRoot, chainRoot, card, receipt, actions, chain: null, chainStatus: null };
      caseViews.set(id, view);
      view.chain = window.ScholarCheckupChain.mount(chainRoot, record, {
        onStatus: status => {
          view.chainStatus = status;
          if (selected?.id === id) showChainStatus(status);
        }
      });
    }
    view.cardRoot.hidden = false;
    view.receiptRoot.hidden = false;
    view.actionsRoot.hidden = false;
    view.chainRoot.hidden = false;
    showChainStatus(view.chainStatus);
    for (const button of caseRoot.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.caseId === id));
    byId('sc-record-label').textContent = selected.synthetic ? 'SYNTHETIC / 虚构样例' : 'OPENALEX / ' + selected.id;
    byId('sc-subject-org').hidden = selected.synthetic;
    byId('sc-subject-org').href = 'org.html?mode=chain&q=' + encodeURIComponent(selected.id);
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const url = new URL(location.href);
      url.searchParams.set('case', selected.id);
      url.searchParams.delete('candidate');
      history.replaceState(null, '', url.href);
    }
    byId('sc-workspace').hidden = false;
    showView('card');
    announce('已选择 ' + selected.name + '，五维合计 ' + selected.score + ' 分。');
  }
  function loadDataset(data, requestedId) {
    if (!core || !window.ScholarCheckupCard || !window.ScholarCheckupReceipt || !window.ScholarCheckupActions || !window.ScholarCheckupChain) throw new Error('组件脚本未加载完整');
    if (!data || !Array.isArray(data.cases) || data.cases.length === 0 || data.cases.length > 20) throw new Error('案例文件结构不正确');
    const nextRecords = data.cases.map(raw => core.normalizeCase(raw, data));
    if (new Set(nextRecords.map(r => r.id)).size !== nextRecords.length) throw new Error('案例 ID 重复');
    loadVersion += 1;
    for (const view of caseViews.values()) {
      view.card.destroy();
      view.receipt.destroy();
      view.actions.destroy();
      view.chain?.destroy();
    }
    caseViews.clear();
    records.clear();
    nextRecords.forEach(record => records.set(record.id, record));
    byId('sc-card-root').replaceChildren();
    byId('sc-receipt-root').replaceChildren();
    byId('sc-actions-root').replaceChildren();
    byId('sc-chain-root').replaceChildren();
    showChainStatus(null);
    dataset = data;
    selected = null;
    clearRouteNotice();
    byId('sc-workspace').hidden = true;
    caseRoot.replaceChildren();
    for (const record of nextRecords) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sc-case-button' + (record.synthetic ? ' sc-synthetic' : '');
      button.dataset.caseId = record.id;
      button.setAttribute('aria-pressed', 'false');
      const avatar = document.createElement('span'); avatar.className = 'sc-case-avatar'; avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = record.synthetic ? 'DEMO' : record.name.split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join('');
      const copy = document.createElement('span'); copy.className = 'sc-case-copy';
      const name = document.createElement('span'); name.className = 'sc-case-name';
      name.textContent = record.misattributed ? '致远本人' : record.synthetic ? '虚构灌水号' : record.name === 'Kaiming He' ? '何恺明 · Kaiming He' : record.name;
      const sub = document.createElement('span'); sub.className = 'sc-case-sub';
      sub.textContent = record.misattributed ? '论文错挂 · 本人认领' : record.synthetic ? '虚构样例 · 数据一致性' : '公开档案 · 快照演示';
      const score = document.createElement('span'); score.className = 'sc-case-score';
      const scoreValue = document.createElement('strong'); scoreValue.textContent = String(record.score);
      const scoreMax = document.createElement('small'); scoreMax.textContent = '/100';
      score.append(scoreValue, scoreMax);
      copy.append(name, sub); button.append(avatar, copy, score);
      button.addEventListener('click', () => selectCase(record.id));
      caseRoot.append(button);
    }
    byId('sc-snapshot-date').textContent = 'SNAPSHOT ' + String(data.generated || '未注明') + ' / 非实时查询';
    loading.hidden = true; fallback.hidden = true;
    delete loading.dataset.error;
    if (retryButton) { retryButton.hidden = true; retryButton.disabled = false; }
    if (requestedId !== undefined && requestedId !== null && !records.has(normalizeId(requestedId))) {
      const message = '未找到档案「' + String(requestedId) + '」。请选择上方已有案例，或检查链接中的案例 ID。';
      if (routeNotice) { routeNotice.textContent = message; routeNotice.hidden = false; }
      announce(message);
      if (new URLSearchParams(location.search).get('candidate') === '1') loadCandidate(normalizeId(requestedId));
      return;
    }
    selectCase(requestedId === undefined || requestedId === null ? nextRecords[0].id : requestedId);
  }

  async function loadDefaultDataset() {
    if (location.protocol === 'file:') return;
    const token = ++loadVersion;
    loading.hidden = false;
    delete loading.dataset.error;
    loading.textContent = '正在读取仓库中的案例数据…';
    if (retryButton) retryButton.disabled = true;
    try {
      const response = await fetch('../product/mock_cases.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (token !== loadVersion) return;
      const requestedView = new URLSearchParams(location.search).get('view');
      loadDataset(data, new URLSearchParams(location.search).get('case'));
      if (selected && requestedView === 'receipt') showView('receipt');
    } catch (error) {
      if (token === loadVersion) showError(error, 'network');
    } finally {
      if (token === loadVersion && retryButton) retryButton.disabled = false;
    }
  }
  for (const [view, button] of Object.entries(tabs)) {
    button.addEventListener('click', () => showView(view));
    button.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        showView(event.key === 'Home' ? 'card' : event.key === 'End' ? 'receipt' : currentView === 'card' ? 'receipt' : 'card', true);
      }
    });
  }
  byId('sc-data-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const token = ++loadVersion;
    try {
      if (file.size > 1024 * 1024) throw new Error('案例 JSON 超过 1 MB');
      const data = JSON.parse(await file.text());
      if (token === loadVersion) loadDataset(data);
    } catch (error) { if (token === loadVersion) showError(error); }
    event.target.value = '';
  });
  if (retryButton) retryButton.addEventListener('click', loadDefaultDataset);
  document.querySelectorAll('[data-journey]').forEach(button => {
    button.addEventListener('click', () => {
      if (!selected) return;
      showView(button.dataset.journey, true);
      byId('sc-workspace').scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  });
  if (presentationButton) presentationButton.addEventListener('click', () => setPresentation(document.body.dataset.presentation !== 'true'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.dataset.presentation === 'true' && !document.querySelector('dialog[open]')) {
      setPresentation(false);
    }
  });
  // Screen 01/02 can route here with ?case=OpenAlexID, or dispatch this event in a composed page.
  window.addEventListener('scholar-checkup:select', event => {
    try { selectCase(event.detail.caseId); showView(event.detail.view === 'receipt' ? 'receipt' : 'card', true); }
    catch (error) { announce(error.message); }
  });
  window.ScholarCheckup = Object.freeze({ selectCase, showView, loadDataset, setPresentation, getSelected: () => selected ? JSON.parse(JSON.stringify(selected)) : null });
  if (location.protocol === 'file:') {
    loading.hidden = true; fallback.hidden = false;
    if (retryButton) retryButton.hidden = true;
  } else {
    loadDefaultDataset();
  }
}());
