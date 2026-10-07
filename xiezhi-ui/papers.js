(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = '/scholar-api/literature/';
  const queryInput = $('papers-query');
  const authorInput = $('papers-author');
  const dialog = $('papers-reader');
  const sourceSelect = $('papers-source-select');
  const sources = { all: '多源联合检索', sciverse: 'Sciverse', openalex: 'OpenAlex', crossref: 'Crossref', semantic_scholar: 'Semantic Scholar', europe_pmc: 'Europe PMC', pubmed: 'PubMed', arxiv: 'arXiv', datacite: 'DataCite', nasa_ads: 'NASA ADS', unpaywall: 'Unpaywall' };
  let metadataSource = 'all';
  let responseSource = 'all';
  let searchController;
  let searchVersion = 0;
  let currentSearch = null;
  let nextPageAvailable = false;
  let readerController;
  let readerVersion = 0;
  let reader = null;
  let readerOpener;
  let healthVersion = 0;

  function syncNewUiLink() {
    const target = new URL('/workbench/papers.html', location.origin);
    const parameters = new URLSearchParams(location.search);
    for (const key of ['q', 'author', 'source', 'mode', 'discipline', 'page']) {
      const value = parameters.get(key);
      if (value) target.searchParams.set(key, value.slice(0, key === 'author' ? 160 : 400));
    }
    const network = parameters.get('network');
    if (network === 'mainnet' || network === 'testnet') target.searchParams.set('network', network);
    $('edition-workbench').href = target.pathname + target.search;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function externalLink(label, href) {
    const anchor = el('a', '', label);
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }
  function time(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date)
      : '时间未提供';
  }
  function mode() { return document.querySelector('input[name="mode"]:checked').value; }
  function updateModeHelp() {
    const semantic = mode() === 'semantic';
    if (semantic && !sourceSelect.disabled) { metadataSource = sourceSelect.value; sourceSelect.value = 'sciverse'; }
    if (!semantic && sourceSelect.disabled) sourceSelect.value = metadataSource;
    const doiOnly = !semantic && sourceSelect.value === 'unpaywall';
    const label = semantic ? '用一句话描述研究问题' : doiOnly ? '输入 DOI 查开放全文' : '论文标题、关键词或 DOI';
    queryInput.placeholder = label;
    $('papers-query-label').textContent = label;
    $('papers-mode-help').textContent = semantic
      ? '描述你想研究的问题，按语义相关性寻找原文片段。'
      : doiOnly ? '粘贴完整 DOI 或 doi.org 链接，查找出版方与机构库的开放全文。Unpaywall 不支持关键词或姓名检索。' : '用论文标题、关键词或 DOI 查找；也可以仅按作者查询。';
    $('papers-author-help').textContent = semantic
      ? '作者姓名作为相关性线索，并非严格筛选；同名结果仍需核对。'
      : doiOnly ? 'DOI 已对应具体文献，此来源不使用作者筛选；已填写姓名会保留，切换来源后可继续使用。' : '作者姓名只用于检索线索；同名结果仍需结合单位与论文核对。';
    authorInput.disabled = doiOnly;
    sourceSelect.disabled = semantic;
    $('papers-discipline').disabled = semantic || sourceSelect.value !== 'all';
    $('papers-scope-help').textContent = semantic
      ? '语义检索由 Sciverse 提供，返回相关的原文片段。'
      : doiOnly ? '只查询这个 DOI 的开放获取位置；链接由你主动打开，页面不会自动下载全文。' : sourceSelect.value === 'all' ? '联合检索会按研究领域选择来源；输入 DOI 时也查询开放全文位置。每条文献保留其出处。' : '当前只查询所选来源；可切换为全部来源扩大检索范围。';
  }
  async function request(path, controller) {
    let response;
    try { response = await fetch(api + path, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } }); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error('暂时无法连接文献服务，请稍后重试。');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('文献服务返回的内容暂时无法读取，请重试。'); }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error.slice(0, 350) : '文献查询未完成，请稍后重试。';
      const failure = new Error(/api[_ -]?key|token|密钥|凭据|配置|环境变量/i.test(detail) ? '所选数据源暂不可用，请试试其他来源或稍后重试。' : detail);
      failure.sourceStatus = Array.isArray(data.sourceStatus) ? data.sourceStatus : [];
      throw failure;
    }
    if (!data || typeof data.source !== 'string') throw new Error('文献来源信息不完整，请重试。');
    return data;
  }
  async function checkHealth() {
    const version = ++healthVersion;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    $('papers-service-state').textContent = '正在检查文献服务…';
    $('papers-service-retry').hidden = true;
    try {
      const data = await request('health', controller);
      if (version !== healthVersion) return;
      const supported = Array.isArray(data.providers) ? data.providers.filter(provider => provider.supported !== false) : [];
      $('papers-service-state').textContent = supported.length ? `${supported.length} 个学术来源已接入 · 返回情况以本次检索为准` : '文献服务 · 返回情况以本次检索为准';
      $('papers-service-note').hidden = true;
      $('papers-service-retry').hidden = true;
    } catch (_) {
      if (version !== healthVersion) return;
      $('papers-service-state').textContent = '文献服务状态暂不可用';
      $('papers-service-retry').hidden = false;
    } finally { clearTimeout(timer); }
  }
  function renderPaper(paper, index) {
    const card = el('article', 'papers-card');
    const kicker = el('p', 'papers-card-kicker');
    kicker.append(el('span', '', String(index + 1).padStart(2, '0')));
    kicker.append(el('span', '', paper.year ? String(paper.year) : '年份未提供'));
    card.append(kicker, el('h3', '', typeof paper.title === 'string' && paper.title.trim() ? paper.title : '未提供标题'));
    const provenance = el('div', 'papers-provenance');
    const origins = Array.isArray(paper.sources) && paper.sources.length ? paper.sources : [{ id: paper.source || responseSource }];
    provenance.append(el('span', '', '收录来源'));
    for (const origin of origins) {
      const label = typeof origin.label === 'string' ? origin.label : sources[origin.id] || '学术来源';
      const url = safeUrl(origin.url);
      provenance.append(url ? externalLink(label + ' ↗', url) : el('span', 'papers-source-chip', label));
    }
    card.append(provenance);
    const unpaywall = paper.openAccessSource === 'unpaywall' || paper.source === 'unpaywall';
    if (unpaywall && typeof paper.openAccess === 'boolean') {
      card.append(el('p', 'papers-card-abstract', paper.openAccess
        ? 'Unpaywall 已找到开放获取位置' + (paper.oaStatus ? ' · ' + paper.oaStatus : '') + '；使用范围以来源许可为准。'
        : 'Unpaywall 已收录此 DOI，目前未发现开放获取位置。这不是检索失败，也不说明论文质量。'));
    }
    const authors = Array.isArray(paper.authors) ? paper.authors.filter(value => typeof value === 'string') : [];
    card.append(el('p', 'papers-card-authors', authors.length ? authors.slice(0, 8).join(' · ') + (authors.length > 8 ? ` 等 ${authors.length} 位作者` : '') : '作者信息未提供'));
    if (authors.length > 8) {
      const details = el('details');
      details.append(el('summary', '', '查看完整作者名单'), el('p', 'papers-card-authors', authors.join(' · ')));
      card.append(details);
    }
    if (typeof paper.doi === 'string' && paper.doi) card.append(el('p', 'papers-card-doi', 'DOI ' + paper.doi));
    if (typeof paper.abstract === 'string' && paper.abstract.trim()) {
      if (paper.abstract.length > 480) {
        const details = el('details');
        details.append(el('summary', '', '展开摘要'), el('p', 'papers-card-abstract', paper.abstract));
        card.append(details);
      } else card.append(el('p', 'papers-card-abstract', paper.abstract));
    }
    if (typeof paper.snippet === 'string' && paper.snippet.trim()) card.append(el('blockquote', 'papers-card-snippet', paper.snippet));
    if (!paper.abstract && !paper.snippet) card.append(el('p', 'papers-card-abstract', '来源暂未提供摘要。'));
    const actions = el('div', 'papers-card-actions');
    if (paper.canRead && typeof paper.docId === 'string' && paper.docId && (paper.source === 'sciverse' || origins.some(origin => origin.id === 'sciverse'))) {
      const button = el('button', 'papers-primary', '查看原文片段 →');
      button.type = 'button';
      button.setAttribute('aria-label', '查看原文片段：' + (paper.title || '未提供标题'));
      button.addEventListener('click', () => openReader(paper, button));
      actions.append(button);
    } else if (safeUrl(paper.pdfUrl)) actions.append(externalLink('开放获取原文 ↗', safeUrl(paper.pdfUrl)));
    else actions.append(el('span', '', unpaywall && paper.openAccess === false ? '暂无开放全文链接，可前往来源核对' : '此页暂无可读原文片段'));
    let source = safeUrl(paper.url);
    if (!source && /^10\.\d{4,9}\/\S+$/i.test(paper.doi || '')) source = 'https://doi.org/' + encodeURIComponent(paper.doi);
    if (source) actions.append(externalLink('查看来源 ↗', source));
    card.append(actions);
    const locations = Array.isArray(paper.oaLocations) ? paper.oaLocations.filter(item => item && [item.url, item.landingPageUrl, item.pdfUrl].some(safeUrl)).slice(0, 20) : [];
    if (locations.length) {
      const details = el('details');
      details.append(el('summary', '', '开放全文位置与许可 · ' + locations.length + ' 处'));
      const list = el('ul');
      for (const location of locations) {
        const item = el('li');
        const host = { publisher: '出版方', repository: '机构库' }[location.hostType] || '开放来源';
        const version = { submittedVersion: '投稿稿', acceptedVersion: '录用稿', publishedVersion: '发表版' }[location.version];
        item.append(externalLink(host + '页面 ↗', [location.landingPageUrl, location.url, location.pdfUrl].map(safeUrl).find(Boolean)));
        if (safeUrl(location.pdfUrl)) item.append(document.createTextNode(' · '), externalLink('打开 PDF ↗', safeUrl(location.pdfUrl)));
        item.append(el('p', 'papers-card-abstract', [version, location.license ? '许可：' + location.license : '许可未提供，请到来源页面核对'].filter(Boolean).join(' · ')));
        list.append(item);
      }
      details.append(list);
      card.append(details);
    }
    return card;
  }
  function cancelSearch() {
    searchVersion++;
    searchController?.abort();
    searchController = null;
    $('papers-results').setAttribute('aria-busy', 'false');
    $('papers-form').setAttribute('aria-busy', 'false');
  }
  function invalidateSearch() {
    const hadSearch = Boolean(currentSearch || searchController);
    cancelSearch();
    currentSearch = null;
    nextPageAvailable = false;
    $('papers-results').hidden = true;
    $('papers-list').replaceChildren();
    $('papers-start').hidden = false;
    if (hadSearch) $('papers-status').textContent = '检索条件已修改，点击箭头重新搜索。';
  }
  function showEmpty(title, detail, retry = false) {
    $('papers-empty').hidden = false;
    $('papers-empty-title').textContent = title;
    $('papers-empty-detail').textContent = detail;
    $('papers-search-retry').hidden = !retry;
  }
  function renderSourceStatus(entries) {
    const container = $('papers-source-status');
    container.replaceChildren();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const item = el('span', 'papers-source-response');
      const ok = entry.status === 'ok';
      item.dataset.state = ok ? 'ok' : 'unavailable';
      item.append(el('strong', '', sources[entry.id] || entry.label || '学术来源'));
      item.append(document.createTextNode(ok ? ` · ${Number.isSafeInteger(entry.count) ? entry.count + ' 条' : '已返回'}` : entry.status === 'skipped' ? ' · 暂不支持此条件' : ' · 本次暂不可用'));
      if (ok && entry.id === 'unpaywall') {
        const status = { open: '找到开放获取位置', closed: '已收录，暂无开放全文', not_found: '未收录此 DOI' }[entry.lookupStatus];
        if (status) item.append(document.createTextNode(' · ' + status));
      }
      container.append(item);
    }
    container.hidden = !container.childElementCount;
  }
  async function search({ page = 1, focus = true } = {}) {
    cancelSearch();
    const query = queryInput.value.trim().replace(/\s+/g, ' ');
    const selectedMode = mode();
    const selectedSource = selectedMode === 'semantic' ? 'sciverse' : sourceSelect.value;
    const author = selectedSource === 'unpaywall' ? '' : authorInput.value.trim();
    if (selectedSource === 'unpaywall' && !/^10\.\d{4,9}\/\S+$/i.test(query.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim())) {
      $('papers-status').textContent = 'Unpaywall 需要完整 DOI 或 doi.org 链接；检索关键词或作者，请切换到联合检索。';
      queryInput.focus();
      return;
    }
    if ((!query && !author) || (selectedMode === 'semantic' && !query)) {
      $('papers-status').textContent = selectedMode === 'semantic' ? '先描述一个研究问题，再进行语义检索。' : '请输入标题、关键词、DOI 或作者姓名。';
      queryInput.focus();
      return;
    }
    if ((query && query.length < 2) || query.length > 400 || author.length > 160 || (author && author.length < 2)) {
      $('papers-status').textContent = '检索词请填写 2–400 个字符；作者姓名请填写 2–160 个字符，或留空。';
      ((query && query.length < 2) || query.length > 400 ? queryInput : authorInput).focus();
      return;
    }
    currentSearch = { q: query, author, mode: selectedMode, source: selectedSource, page: selectedMode === 'semantic' ? 1 : page };
    const parameters = new URLSearchParams({ q: query, author, mode: selectedMode, source: selectedSource, discipline: $('papers-discipline').value, page: String(currentSearch.page) });
    const locationUrl = new URL(location.href);
    for (const [key, value] of parameters) {
      if (value) locationUrl.searchParams.set(key, value);
      else locationUrl.searchParams.delete(key);
    }
    history.replaceState(null, '', locationUrl);
    syncNewUiLink();
    const version = searchVersion;
    const controller = new AbortController();
    searchController = controller;
    const timer = setTimeout(() => controller.abort(), 45000);
    $('papers-start').hidden = true;
    $('papers-results').hidden = false;
    $('papers-results').setAttribute('aria-busy', 'true');
    $('papers-form').setAttribute('aria-busy', 'true');
    $('papers-list').replaceChildren();
    $('papers-empty').hidden = true;
    $('papers-pagination').hidden = true;
    $('papers-result-note').hidden = true;
    $('papers-source-status').hidden = true;
    $('papers-results-title').textContent = '正在查找相关文献';
    $('papers-result-count').textContent = '';
    $('papers-source').textContent = `正在查询${sources[selectedSource] || '文献来源'}…`;
    $('papers-status').textContent = selectedMode === 'semantic' ? '正在寻找与你的问题相关的原文片段…' : '正在检索论文与作者信息…';
    try {
      const data = await request('search?' + parameters, controller);
      if (version !== searchVersion) return;
      if (!Array.isArray(data.results)) throw new Error('返回的文献列表不完整，请重试。');
      responseSource = data.source;
      $('papers-list').replaceChildren(...data.results.map(renderPaper));
      $('papers-results-title').textContent = selectedMode === 'semantic' ? '相关文献与片段' : '文献检索结果';
      const total = data.totalIsExact !== false && selectedSource !== 'all' && Number.isSafeInteger(data.total) && data.total >= data.results.length ? data.total : null;
      $('papers-result-count').textContent = selectedMode === 'semantic'
        ? `${data.results.length} 条相关结果`
        : `本页 ${data.results.length} 篇${total !== null ? ' · 共 ' + total.toLocaleString('zh-CN') + ' 篇' : ''}`;
      $('papers-source').textContent = `${sources[selectedSource] || '文献查询'} · ${data.cached ? '近期缓存' : '在线查询'} · 取数时间 ${time(data.fetchedAt)}`;
      const notes = [];
      if (data.partial) notes.push('部分来源暂不可用，已保留返回结果。');
      if (typeof data.note === 'string' && data.note.trim()) {
        for (const sentence of data.note.trim().split(/(?<=[。！？])\s*/u).filter(Boolean)) {
          notes.push(/(?:姓名|作者名)匹配可能包含同名者/.test(sentence)
            ? '姓名匹配可能包含同名者，请核对论文归属。' : sentence);
        }
      } else {
        if (selectedSource === 'all') notes.push('各来源分别分页并合并重复记录；本页数量不代表全库总量。');
        if (author) notes.push(selectedMode === 'semantic' ? '作者条件为近似匹配，请逐篇核对归属。' : '姓名匹配可能包含同名者，请核对论文归属。');
      }
      $('papers-result-note').textContent = [...new Set(notes)].join(' ');
      $('papers-result-note').hidden = !notes.length;
      renderSourceStatus(data.sourceStatus);
      nextPageAvailable = selectedMode === 'metadata' && data.hasMore === true && currentSearch.page < 100;
      $('papers-pagination').hidden = selectedMode !== 'metadata' || (!nextPageAvailable && currentSearch.page === 1);
      $('papers-page-number').textContent = `第 ${currentSearch.page} 页`;
      $('papers-prev').disabled = currentSearch.page === 1;
      $('papers-next').disabled = !nextPageAvailable;
      if (!data.results.length) showEmpty(data.partial ? '已返回的来源中暂未找到文献' : '暂未找到相关文献', data.partial ? '部分来源尚未返回，不能据此判断文献不存在。请重试或切换来源。' : selectedMode === 'semantic' ? '试着具体描述研究对象、方法或问题，也可以切换为结构化检索。' : '可以缩短关键词、换用英文标题，或去掉作者条件再试。未检索到不代表文献不存在。', Boolean(data.partial));
      if (selectedSource === 'unpaywall' && data.lookupStatus === 'not_found') showEmpty('Unpaywall 尚未收录这个 DOI', '可检查 DOI 是否完整，或切换到 Crossref、OpenAlex 查询书目信息。未收录不等于论文不存在或无法开放获取。');
      $('papers-status').textContent = selectedSource === 'unpaywall' && data.lookupStatus === 'not_found' ? '查询已完成，Unpaywall 尚未收录此 DOI。' : `已返回 ${data.results.length} ${selectedMode === 'semantic' ? '条相关结果' : '篇文献'}。`;
      $('papers-service-state').textContent = data.partial ? '文献服务 · 部分来源已返回' : '文献服务 · 本次查询已完成';
      $('papers-service-note').hidden = true;
      $('papers-service-retry').hidden = true;
    } catch (error) {
      if (version !== searchVersion) return;
      const message = controller.signal.aborted ? '本次查询等待较久，请稍后重试或缩小检索范围。' : String(error.message || '查询暂未完成，请重试。');
      $('papers-results-title').textContent = '查询暂未完成';
      $('papers-result-count').textContent = '';
      $('papers-source').textContent = `${sources[selectedSource] || '文献服务'} · 本次未取得文献结果`;
      renderSourceStatus(error.sourceStatus);
      showEmpty('暂时无法获取文献', message, true);
      $('papers-status').textContent = message;
    } finally {
      clearTimeout(timer);
      if (version === searchVersion) {
        searchController = null;
        $('papers-results').setAttribute('aria-busy', 'false');
        $('papers-form').setAttribute('aria-busy', 'false');
        if (focus) {
          $('papers-results-title').focus({ preventScroll: true });
          $('papers-results').scrollIntoView({ block: 'start', behavior: 'instant' });
        }
      }
    }
  }
  function stopReader() {
    readerVersion++;
    readerController?.abort();
    readerController = null;
  }
  function openReader(paper, opener) {
    stopReader();
    readerOpener = opener;
    const offset = Number.isSafeInteger(paper.offset) && paper.offset >= 0 ? paper.offset : 0;
    reader = { paper, offsets: [offset], index: 0, next: null, pendingOffset: offset, pendingIndex: 0 };
    $('papers-reader-title').textContent = paper.title || '未提供标题';
    dialog.showModal();
    loadChunk(offset, 0);
  }
  async function loadChunk(offset, index) {
    stopReader();
    if (!reader) return;
    const version = readerVersion;
    const controller = new AbortController();
    readerController = controller;
    const timer = setTimeout(() => controller.abort(), 45000);
    reader.pendingOffset = offset;
    reader.pendingIndex = index;
    $('papers-reader-status').textContent = '正在载入原文片段…';
    $('papers-reader-position').textContent = `片段 ${index + 1}`;
    $('papers-reader-text').replaceChildren();
    $('papers-reader-text').setAttribute('aria-busy', 'true');
    $('papers-resources').hidden = true;
    $('papers-resource-list').replaceChildren();
    $('papers-reader-retry').hidden = true;
    $('papers-reader-prev').disabled = true;
    $('papers-reader-next').disabled = true;
    const parameters = new URLSearchParams({ doc: reader.paper.docId, offset: String(offset) });
    try {
      const data = await request('content?' + parameters, controller);
      if (version !== readerVersion || !dialog.open) return;
      if (typeof data.text !== 'string') throw new Error('来源暂未返回可读取的原文片段。');
      reader.index = index;
      reader.offsets[index] = offset;
      reader.next = data.hasMore === true && Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset ? data.nextOffset : null;
      $('papers-reader-text').textContent = data.text || '这一位置没有可用的原文文本。';
      $('papers-reader-status').textContent = `来源：Sciverse · ${data.cached ? '近期缓存' : '在线读取'} · 取数时间 ${time(data.fetchedAt)}`;
      $('papers-reader-position').textContent = `片段 ${index + 1}${reader.next === null ? ' · 已到末段' : ''}`;
      const resources = Array.isArray(data.resources) ? data.resources : [];
      for (const [index, resource] of resources.entries()) {
        if (typeof resource.fileName !== 'string' || !resource.fileName) continue;
        const item = el('li');
        const title = typeof resource.alt === 'string' && resource.alt ? resource.alt : `图表 ${index + 1}`;
        const href = api + 'resource?' + new URLSearchParams({ file: resource.fileName });
        const detail = el('details');
        const preview = el('img', 'papers-resource-image');
        preview.alt = title; preview.decoding = 'async'; preview.hidden = true;
        const warning = el('p', 'papers-resource-error', '图表暂时无法载入，可重新展开或打开原图。');
        warning.hidden = true;
        const link = externalLink('单独打开原图 ↗', href); link.className = 'papers-resource-link';
        let loaded = false;
        detail.addEventListener('toggle', () => {
          if (detail.open && !loaded) { loaded = true; warning.hidden = true; preview.hidden = false; preview.src = href; }
        });
        preview.addEventListener('error', () => { preview.hidden = true; warning.hidden = false; loaded = false; });
        detail.append(el('summary', '', title + ' · 展开图表'), preview, warning, link);
        item.append(detail);
        $('papers-resource-list').append(item);
      }
      $('papers-resources').hidden = !$('papers-resource-list').childElementCount;
      $('papers-reader-prev').disabled = index === 0;
      $('papers-reader-next').disabled = reader.next === null;
      document.querySelector('.papers-reader-body').scrollTop = 0;
    } catch (error) {
      if (version !== readerVersion || !dialog.open) return;
      $('papers-reader-status').textContent = controller.signal.aborted ? '原文载入时间较长，请重试。' : String(error.message || '原文片段暂时无法读取。');
      $('papers-reader-position').textContent = '片段暂未载入';
      $('papers-reader-retry').hidden = false;
      $('papers-reader-prev').disabled = index === 0;
    } finally {
      clearTimeout(timer);
      if (version === readerVersion) {
        readerController = null;
        $('papers-reader-text').setAttribute('aria-busy', 'false');
      }
    }
  }
  $('papers-form').addEventListener('submit', event => { event.preventDefault(); search(); });
  queryInput.addEventListener('keydown', event => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); search(); } });
  queryInput.addEventListener('input', invalidateSearch);
  authorInput.addEventListener('input', invalidateSearch);
  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => { updateModeHelp(); invalidateSearch(); }));
  sourceSelect.addEventListener('change', () => { metadataSource = sourceSelect.value; updateModeHelp(); invalidateSearch(); });
  $('papers-discipline').addEventListener('change', invalidateSearch);
  $('papers-search-retry').addEventListener('click', () => search({ page: currentSearch?.page || 1 }));
  $('papers-service-retry').addEventListener('click', checkHealth);
  $('papers-prev').addEventListener('click', () => { if (currentSearch?.page > 1) search({ page: currentSearch.page - 1 }); });
  $('papers-next').addEventListener('click', () => { if (nextPageAvailable && currentSearch) search({ page: currentSearch.page + 1 }); });
  $('papers-reader-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { stopReader(); reader = null; readerOpener?.focus({ preventScroll: true }); });
  $('papers-reader-prev').addEventListener('click', () => { if (reader && reader.pendingIndex > 0) loadChunk(reader.offsets[reader.pendingIndex - 1], reader.pendingIndex - 1); });
  $('papers-reader-next').addEventListener('click', () => { if (reader?.next !== null && reader && !readerController) loadChunk(reader.next, reader.index + 1); });
  $('papers-reader-retry').addEventListener('click', () => { if (reader) loadChunk(reader.pendingOffset, reader.pendingIndex); });
  const parameters = new URLSearchParams(location.search);
  queryInput.value = (parameters.get('q') || '').slice(0, 400);
  authorInput.value = (parameters.get('author') || '').slice(0, 160);
  sourceSelect.value = Object.hasOwn(sources, parameters.get('source')) ? parameters.get('source') : 'all';
  metadataSource = sourceSelect.value;
  $('papers-discipline').value = ['general', 'biomedical', 'stem', 'astronomy', 'data'].includes(parameters.get('discipline')) ? parameters.get('discipline') : 'general';
  document.querySelector(`input[name="mode"][value="${parameters.get('mode') === 'semantic' ? 'semantic' : 'metadata'}"]`).checked = true;
  updateModeHelp();
  syncNewUiLink();
  checkHealth();
  if (queryInput.value.trim() || authorInput.value.trim()) search({ page: Math.min(100, Math.max(1, Number.parseInt(parameters.get('page'), 10) || 1)), focus: false });
})();
