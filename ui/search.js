(function () {
  'use strict';
  const core = window.ScholarSearch;
  const $ = id => document.getElementById(id);
  let candidates = [];
  let pending = true;
  let lastQuery = '';
  const queryInput = $('ss-query');
  const status = $('ss-status');
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function renderCandidate(candidate, index) {
    const article = el('article', 'ss-result');
    article.style.setProperty('--ss-index', Math.min(index, 6));
    const initials = candidate.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();
    article.append(el('span', 'ss-avatar', candidate.id === 'A5126602136' ? '本人' : candidate.id === 'SYNTHETIC' ? 'DEMO' : initials));
    const content = el('div', 'ss-result-content');
    const heading = el('h3', '', candidate.id === 'A5126602136' ? '吕志远 · ' + candidate.name : candidate.name);
    heading.append(document.createTextNode(' '), el('small', '', candidate.id));
    content.append(heading);
    if (candidate.identityNote) {
      const identity = el('span', 'ss-result-identity', candidate.identityNote);
      if (candidate.id === 'A5111337086') identity.dataset.conflict = 'true';
      content.append(identity);
    }
    const institutions = candidate.displayInstitutions?.length ? candidate.displayInstitutions : candidate.institutions;
    content.append(el('p', 'ss-result-institution', institutions?.length ? institutions.join(' / ') : '公开快照未提供机构'));
    const topics = el('ul', 'ss-result-topics');
    (candidate.displayTopics?.length ? candidate.displayTopics : candidate.topics || []).slice(0, 3).forEach(topic => topics.append(el('li', '', topic)));
    content.append(topics, el('p', 'ss-result-note-text', candidate.note));
    const source = el('p', 'ss-result-source', `${candidate.provenance} · ${candidate.snapshotDate}`);
    if (/^https:\/\/api\.openalex\.org\/authors\/A\d+$/.test(candidate.sourceUrl)) {
      source.append(document.createTextNode(' · '));
      const link = el('a', '', '查看原始记录 ↗');
      link.href = candidate.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      source.append(link);
    }
    content.append(source);
    const controls = el('div', 'ss-result-go');
    const works = el('span');
    works.append(el('strong', '', Number.isInteger(candidate.works) ? String(candidate.works) : '—'), document.createTextNode('篇 / 库收录'));
    const link = el('a', '', candidate.hasScore ? '查看体检卡' : '辨认此档案');
    link.append(el('span', '', '→'));
    link.href = core.candidateUrl(candidate);
    link.setAttribute('aria-label', `${candidate.hasScore ? '查看体检卡' : '辨认档案'}：${candidate.name}，${candidate.id}`);
    controls.append(works, link);
    article.append(content, controls);
    return article;
  }
  function runSearch({ focus = true } = {}) {
    if (pending) { status.textContent = '候选档案正在载入，请稍候。'; return; }
    const query = queryInput.value.trim();
    if (!query) { queryInput.focus(); return; }
    const result = core.search(query, candidates);
    if (result.direct) {
      const destination = new URL(result.direct, location.href);
      if (new URLSearchParams(location.search).get('network') === 'testnet') destination.searchParams.set('network', 'testnet');
      window.location.assign(destination.href);
      return;
    }
    lastQuery = query;
    const url = new URL(window.location.href);
    url.searchParams.set('q', query);
    window.history.replaceState(null, '', url);
    $('ss-results').hidden = false;
    document.body.dataset.hasResults = 'true';
    $('ss-result-list').replaceChildren(...result.items.map(renderCandidate));
    $('ss-empty').hidden = result.items.length > 0;
    $('ss-result-count').textContent = `${result.items.length} 条匹配 · 公开快照`;
    $('ss-results-title').textContent = result.items.length ? '请先选对这位研究者' : '暂未找到匹配档案';
    $('ss-result-note').hidden = !result.items.length;
    $('ss-result-note').textContent = result.items.length > 1 ? '名字相似，身份未必相同。请结合单位、研究方向和 ORCID 辨认；论文数量不作为身份结论。' : '这是候选档案，不是身份认证。请先核对机构与研究方向，再查看后续证据。';
    $('ss-external-search').href = 'https://openalex.org/authors?search=' + encodeURIComponent(query);
    status.textContent = `“${query}”在本地快照中匹配 ${result.items.length} 条档案。`;
    if (focus) {
      $('ss-results-title').focus({ preventScroll: true });
      $('ss-results').scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  }
  async function load() {
    pending = true;
    $('ss-submit').disabled = true;
    $('ss-retry').hidden = true;
    status.textContent = '正在载入候选档案…';
    try {
      const [snapshot, cases] = await Promise.all([
        fetch('search-data.json').then(response => { if (!response.ok) throw new Error('候选数据不可用'); return response.json(); }),
        fetch('../product/mock_cases.json').then(response => { if (!response.ok) throw new Error('案例数据不可用'); return response.json(); })
      ]);
      if (!Array.isArray(snapshot.candidates)) throw new Error('候选格式不正确');
      const ids = new Set(snapshot.candidates.map(item => item.id));
      candidates = [...snapshot.candidates, ...core.caseCandidates(cases).filter(item => !ids.has(item.id))];
      pending = false;
      $('ss-submit').disabled = false;
      status.textContent = '';
      $('ss-source-note').textContent = `OpenAlex 公开数据快照 · ${snapshot.generated} · 非实时全库搜索`;
      if (queryInput.value.trim()) runSearch({ focus: false });
    } catch (error) {
      pending = true;
      status.textContent = '暂时无法加载搜索快照。请重试；也可以直接打开下方四个案例。';
      $('ss-retry').hidden = false;
    }
  }
  $('ss-form').addEventListener('submit', event => { event.preventDefault(); runSearch(); });
  document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => { queryInput.value = button.dataset.query; runSearch(); }));
  $('ss-retry').addEventListener('click', load);
  queryInput.addEventListener('input', () => { if (!queryInput.value && lastQuery) { $('ss-results').hidden = true; document.body.dataset.hasResults = 'false'; status.textContent = ''; lastQuery = ''; const url = new URL(window.location.href); url.searchParams.delete('q'); window.history.replaceState(null, '', url); } });
  $('ss-present').addEventListener('click', () => {
    const pressed = $('ss-present').getAttribute('aria-pressed') !== 'true';
    $('ss-present').setAttribute('aria-pressed', String(pressed));
    document.body.dataset.presentation = String(pressed);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { document.body.dataset.presentation = 'false'; $('ss-present').setAttribute('aria-pressed', 'false'); } });
  queryInput.value = new URLSearchParams(window.location.search).get('q')?.slice(0, 200) || '';
  load();
})();
