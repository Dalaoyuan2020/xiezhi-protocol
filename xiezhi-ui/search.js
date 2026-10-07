(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const queryInput = $('ss-query');
  const institutionInput = $('ss-institution');
  const status = $('ss-status');
  const defaultSource = 'OpenAlex 全库查询 · 公开档案不等于身份认证';
  let activeRequest;
  let requestVersion = 0;
  let lastQuery = '';
  let appliedInstitution = '';
  let composingName = false;
  let composingInstitution = false;

  function isIdentifier(query) {
    return /^(?:https:\/\/openalex\.org\/)?A\d+$/i.test(query)
      || /^(?:https?:\/\/(?:www\.)?orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]\/?$/i.test(query);
  }
  function institutionStatus(message, state = '') {
    $('ss-institution-status').textContent = message;
    $('ss-institution-guide').dataset.state = state;
  }
  function renderInstitution(data) {
    if (!appliedInstitution) {
      institutionStatus('支持模糊查找单位；可用中英文名或简称。');
      return;
    }
    const unit = data.institution;
    if (unit?.status === 'matched') {
      const names = (unit.matches || []).map(item => item.name).filter(Boolean);
      const label = names.slice(0, 3).join(' / ') + (names.length > 3 ? ` 等 ${names.length} 家单位` : '');
      institutionStatus(`已匹配：${label || appliedInstitution}。按最近公开单位记录缩小范围，记录可能滞后；请继续核对身份。`, 'matched');
    } else if (unit?.status === 'unresolved') {
      institutionStatus(`未匹配到“${appliedInstitution}”的单位记录。可换用英文名、完整名称，或不填查看全部候选。`, 'unresolved');
    } else {
      institutionStatus('单位筛选暂未完成。请重试，或不填查看全部候选。', 'unavailable');
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function externalLink(label, href) {
    const link = el('a', '', label);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function candidateUrl(candidate) {
    const url = new URL('/live/', location.origin);
    url.searchParams.set('q', candidate.id);
    const network = new URLSearchParams(location.search).get('network');
    if (network === 'mainnet' || network === 'testnet') url.searchParams.set('network', network);
    const back = new URL('/ui/index.html', location.origin);
    back.searchParams.set('q', lastQuery);
    if (appliedInstitution) back.searchParams.set('institution', appliedInstitution);
    if (network === 'mainnet' || network === 'testnet') back.searchParams.set('network', network);
    url.searchParams.set('returnTo', back.pathname + back.search);
    return url.pathname + url.search;
  }
  function fetchedTime(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date)
      : '时间未提供';
  }
  function renderCandidate(candidate, index) {
    const article = el('article', 'ss-result');
    article.style.setProperty('--ss-index', Math.min(index, 6));
    const initials = candidate.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
    article.append(el('span', 'ss-avatar', initials));
    const content = el('div', 'ss-result-content');
    const heading = el('h3', '', candidate.name);
    heading.append(document.createTextNode(' '), el('small', '', candidate.id));
    content.append(heading);
    content.append(el('p', 'ss-result-institution', candidate.institutions?.length ? candidate.institutions.join(' / ') : 'OpenAlex 未提供最近机构'));
    const topics = el('ul', 'ss-result-topics');
    (candidate.topics || []).slice(0, 3).forEach(topic => topics.append(el('li', '', topic)));
    content.append(topics);
    const orcid = el('p', 'ss-result-note-text', 'ORCID：');
    if (/^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(candidate.orcid || '')) {
      orcid.append(externalLink(candidate.orcid.split('/').pop(), candidate.orcid));
    } else {
      orcid.append(document.createTextNode('公开档案未关联'));
    }
    content.append(orcid);
    const source = el('p', 'ss-result-source', 'OpenAlex 公开档案 · 身份待核对 · ');
    source.append(externalLink('查看原始记录 ↗', 'https://openalex.org/' + candidate.id));
    content.append(source);
    const controls = el('div', 'ss-result-go');
    const works = el('span');
    works.append(el('strong', '', Number.isInteger(candidate.works) ? candidate.works.toLocaleString('zh-CN') : '—'), document.createTextNode('篇 / 库收录'));
    const link = el('a', '', '查看实时档案');
    link.append(el('span', '', '→'));
    link.href = candidateUrl(candidate);
    link.setAttribute('aria-label', `查看实时档案：${candidate.name}，${candidate.id}`);
    controls.append(works, link);
    article.append(content, controls);
    return article;
  }
  function cancelSearch() {
    requestVersion++;
    activeRequest?.abort();
    activeRequest = null;
    $('ss-results').setAttribute('aria-busy', 'false');
    $('ss-form').setAttribute('aria-busy', 'false');
  }
  function clearSearch() {
    cancelSearch();
    $('ss-results').hidden = true;
    $('ss-result-list').replaceChildren();
    $('ss-retry').hidden = true;
    $('ss-source-note').textContent = defaultSource;
    document.body.dataset.hasResults = 'false';
    status.textContent = '';
    lastQuery = '';
    appliedInstitution = '';
    institutionInput.value = '';
    $('ss-institution-guide').hidden = true;
    const url = new URL(location.href);
    url.searchParams.delete('q');
    url.searchParams.delete('institution');
    history.replaceState(null, '', url);
  }
  function showEmpty(title, detail) {
    $('ss-empty-title').textContent = title;
    $('ss-empty-detail').textContent = detail;
    $('ss-empty').hidden = false;
  }
  function focusResults(focus) {
    if (!focus) return;
    $('ss-results-title').focus({ preventScroll: true });
    $('ss-results').scrollIntoView({ behavior: 'instant', block: 'start' });
  }
  async function runSearch({ focus = true, resetInstitution = false } = {}) {
    const query = queryInput.value.trim();
    cancelSearch();
    if (!query) { clearSearch(); queryInput.focus(); return; }
    if (query.length < 2 || query.length > 160) {
      clearSearch();
      status.textContent = '请输入 2–160 个字符的姓名、ORCID 或 OpenAlex 作者编号。';
      queryInput.focus();
      return;
    }
    const exact = isIdentifier(query);
    if (resetInstitution || exact || (lastQuery && query !== lastQuery)) institutionInput.value = '';
    appliedInstitution = institutionInput.value.trim();
    const version = requestVersion;
    const controller = new AbortController();
    activeRequest = controller;
    const timer = setTimeout(() => controller.abort(), 40000);
    lastQuery = query;
    const url = new URL(location.href);
    url.searchParams.set('q', query);
    if (appliedInstitution) url.searchParams.set('institution', appliedInstitution);
    else url.searchParams.delete('institution');
    history.replaceState(null, '', url);
    $('ss-results').hidden = false;
    $('ss-results').setAttribute('aria-busy', 'true');
    $('ss-form').setAttribute('aria-busy', 'true');
    document.body.dataset.hasResults = 'true';
    $('ss-institution-guide').hidden = exact;
    institutionStatus(appliedInstitution
      ? `正在匹配“${appliedInstitution}”的单位记录…`
      : '支持模糊查找单位；不填也能直接查看候选。');
    $('ss-result-list').replaceChildren();
    $('ss-empty').hidden = true;
    $('ss-retry').hidden = true;
    $('ss-result-count').textContent = '正在查询…';
    $('ss-results-title').textContent = '正在查找公开学术档案';
    $('ss-result-note').hidden = false;
    $('ss-result-note').textContent = appliedInstitution
      ? '正在按姓名与学术单位重新查询 OpenAlex…'
      : '正在连接 OpenAlex；中文姓名会同时检索可能的拼音写法。';
    $('ss-source-note').textContent = 'OpenAlex 全库查询 · 等待返回';
    $('ss-external-search').href = 'https://openalex.org/authors?search=' + encodeURIComponent(query);
    status.textContent = `正在查询“${query}”${appliedInstitution ? `，单位“${appliedInstitution}”` : ''}…`;
    try {
      const parameters = new URLSearchParams({ q: query });
      if (appliedInstitution) parameters.set('institution', appliedInstitution);
      const response = await fetch('/scholar-api/search?' + parameters, {
        signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'OpenAlex 查询暂时不可用，请稍后重试。');
      if (!Array.isArray(data.results) || data.source !== 'openalex') throw new Error('搜索服务返回的数据不完整，请重试。');
      if (version !== requestVersion) return;
      renderInstitution(data);
      const items = data.results.filter(item => /^A\d{1,20}$/.test(item?.id) && typeof item.name === 'string');
      $('ss-result-list').replaceChildren(...items.map(renderCandidate));
      $('ss-result-count').textContent = `${items.length} 条候选 · ${data.cached ? '近期缓存' : '在线查询'}`;
      $('ss-results-title').textContent = items.length ? '请先选对这位研究者' : '暂未检索到候选档案';
      const notes = [items.length > 1
        ? '名字相似，身份未必相同。请结合单位、研究方向和 ORCID 辨认。'
        : '公开档案不代表本人认证。请先核对机构、研究方向和 ORCID。'];
      notes.push('候选按相关性返回，并非所有同名档案。');
      if (data.partial) notes.push('部分姓名写法的检索未完成，可重试补查。');
      $('ss-result-note').textContent = notes.join(' ');
      $('ss-result-note').hidden = !items.length;
      $('ss-source-note').textContent = `来源：OpenAlex · ${data.cached ? '服务端近期缓存' : '在线查询'} · 取数时间 ${fetchedTime(data.fetchedAt)}${data.partial ? ' · 部分检索未完成' : ''}`;
      if (!items.length) {
        if (data.institution?.status === 'unresolved') {
          $('ss-results-title').textContent = '先确认学术单位的写法';
          showEmpty('暂未匹配到这个单位', '这不代表研究者没有档案。请换用单位全称、英文名，或点击上方“不填，查看全部”按姓名查询。');
        } else if (appliedInstitution) {
          showEmpty('暂未找到同时符合姓名与单位的档案', '公开单位记录可能滞后或缺失。可以修改单位，或点击上方“不填，查看全部”重新辨认同名候选。');
        } else {
          showEmpty('暂未检索到候选档案', data.partial
            ? '部分姓名写法查询失败，当前结果不完整。请重试，或使用 ORCID、英文名继续搜索。'
            : '可以尝试 ORCID、英文名或其他拼音写法。未找到候选不代表没有研究成果；OpenAlex 的收录和更新可能有延迟。');
        }
      }
      $('ss-retry').hidden = !data.partial;
      $('ss-retry').textContent = '重试未完成查询';
      status.textContent = `“${query}”${appliedInstitution ? `，单位“${appliedInstitution}”` : ''}返回 ${items.length} 条公开候选档案。${data.partial ? '部分检索未完成。' : ''}`;
      focusResults(focus);
    } catch (error) {
      if (version !== requestVersion) return;
      const message = controller.signal.aborted ? '查询时间较长，请重试，或使用 ORCID、OpenAlex 作者编号缩小范围。'
        : error instanceof TypeError || error instanceof SyntaxError ? '暂时无法连接搜索服务，请稍后重试。'
        : String(error.message || '搜索未完成，请重试。').slice(0, 300);
      $('ss-results-title').textContent = '查询暂未完成';
      $('ss-result-count').textContent = '服务暂不可用';
      $('ss-result-note').hidden = true;
      $('ss-result-list').replaceChildren();
      showEmpty('暂时无法获取公开档案', message);
      $('ss-source-note').textContent = 'OpenAlex 查询失败 · 未返回候选档案';
      $('ss-retry').hidden = false;
      $('ss-retry').textContent = '重新查询';
      if (appliedInstitution) institutionStatus('单位筛选查询暂未完成。可重试，或不填查看全部候选。', 'unavailable');
      status.textContent = message;
      focusResults(focus);
    } finally {
      clearTimeout(timer);
      if (version === requestVersion) {
        activeRequest = null;
        $('ss-results').setAttribute('aria-busy', 'false');
        $('ss-form').setAttribute('aria-busy', 'false');
      }
    }
  }
  $('ss-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!event.isComposing && !composingName) runSearch();
  });
  queryInput.addEventListener('compositionstart', () => { composingName = true; });
  queryInput.addEventListener('compositionend', () => { composingName = false; });
  queryInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.isComposing || composingName || event.keyCode === 229)) event.preventDefault();
  });
  document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => {
    queryInput.value = button.dataset.query;
    runSearch({ resetInstitution: true });
  }));
  $('ss-institution-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!event.isComposing && !composingInstitution) runSearch();
  });
  institutionInput.addEventListener('compositionstart', () => { composingInstitution = true; });
  institutionInput.addEventListener('compositionend', () => { composingInstitution = false; });
  institutionInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.isComposing || composingInstitution || event.keyCode === 229)) event.preventDefault();
  });
  $('ss-institution-skip').addEventListener('click', () => {
    institutionInput.value = '';
    runSearch();
  });
  institutionInput.addEventListener('input', () => {
    if (institutionInput.value.trim() === appliedInstitution) return;
    if (activeRequest) {
      cancelSearch();
      $('ss-result-count').textContent = '等待更新';
      $('ss-results-title').textContent = '补充单位后继续查找';
      $('ss-result-note').hidden = true;
      status.textContent = '单位已修改。点击“缩小范围”，或不填查看全部候选。';
    }
    institutionStatus('修改尚未应用。点击“缩小范围”更新；已有候选仍来自上次查询。');
  });
  $('ss-retry').addEventListener('click', () => runSearch());
  queryInput.addEventListener('input', () => {
    if (lastQuery && queryInput.value.trim() !== lastQuery) clearSearch();
  });
  $('ss-present').addEventListener('click', () => {
    const pressed = $('ss-present').getAttribute('aria-pressed') !== 'true';
    $('ss-present').setAttribute('aria-pressed', String(pressed));
    document.body.dataset.presentation = String(pressed);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { document.body.dataset.presentation = 'false'; $('ss-present').setAttribute('aria-pressed', 'false'); }
  });
  queryInput.value = new URLSearchParams(location.search).get('q')?.slice(0, 160) || '';
  institutionInput.value = new URLSearchParams(location.search).get('institution')?.slice(0, 160) || '';
  status.textContent = '';
  $('ss-source-note').textContent = defaultSource;
  if (queryInput.value.trim()) runSearch({ focus: false });
})();
