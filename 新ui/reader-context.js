/* Reader return context is local to a tab and is never a navigation target supplied by a remote source. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XiezhiReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const STORAGE_KEY = 'xiezhi.reader.v1';
  const SEARCH_STATE = 'xiezhiReaderSearch';
  const DETAIL_STATE = 'xiezhiReaderDetail';
  const DIRECT_STATE = 'xiezhiReaderDirect';
  const ID = /^(A\d+|SYNTHETIC)$/;
  const TOKEN = /^[a-zA-Z0-9-]{8,100}$/;

  function networkOf(href) {
    try {
      const value = new URL(href).searchParams.get('network');
      return value === null ? null : value === 'mainnet' || value === 'testnet' ? value : undefined;
    } catch (_) { return undefined; }
  }

  function searchHomeUrl(currentHref) {
    const current = new URL(currentHref);
    return new URL(/^\/workbench\/live\/(?:index\.html)?$/.test(current.pathname) ? '/workbench/index.html' : 'index.html', currentHref);
  }

  function safeReturnUrl(value, currentHref) {
    try {
      const expected = searchHomeUrl(currentHref);
      const url = new URL(value, currentHref);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password) return null;
      const network = networkOf(url.href);
      const q = url.searchParams.get('q');
      const institution = url.searchParams.get('institution');
      if (network === undefined || (q !== null && q.length > 200) || (institution !== null && institution.length > 160)) return null;
      // The route is rebuilt from the supported search parameters; unrelated parameters and fragments do not survive.
      expected.search = '';
      expected.hash = '';
      if (q) expected.searchParams.set('q', q);
      if (institution?.trim()) expected.searchParams.set('institution', institution.trim());
      if (network) expected.searchParams.set('network', network);
      return expected.href;
    } catch (_) { return null; }
  }

  function validateContext(value, currentHref) {
    if (!value || value.version !== 1 || !TOKEN.test(value.token || '') || !ID.test(value.candidateId || '')) return null;
    if (typeof value.q !== 'string' || !value.q.trim() || value.q.length > 200 || value.q !== value.q.trim()) return null;
    if (![null, 'mainnet', 'testnet'].includes(value.network)) return null;
    if (!Number.isFinite(value.scrollY) || value.scrollY < 0 || value.scrollY > 10000000) return null;
    const returnUrl = safeReturnUrl(value.returnUrl, currentHref);
    if (!returnUrl || returnUrl !== value.returnUrl) return null;
    const url = new URL(returnUrl);
    if (url.searchParams.get('q') !== value.q || networkOf(returnUrl) !== value.network) return null;
    return { version: 1, token: value.token, q: value.q, network: value.network, candidateId: value.candidateId, scrollY: value.scrollY, returnUrl };
  }

  function isSameTabActivation(event, link) {
    return !event.defaultPrevented && (event.button === undefined || event.button === 0) &&
      !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey &&
      (!link || !link.target || link.target === '_self') && !(link && link.hasAttribute && link.hasAttribute('download'));
  }

  function create(options) {
    options = options || {};
    const location = options.location || root.location;
    const history = options.history || root.history;
    const document = options.document || root.document;
    let storage;
    let storageAvailable = true;
    try { storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : root.sessionStorage; }
    catch (_) { storageAvailable = false; }
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') storageAvailable = false;
    const navigationType = () => {
      if (typeof options.navigationType === 'function') return options.navigationType();
      if (options.navigationType) return options.navigationType;
      return root.performance?.getEntriesByType?.('navigation')?.[0]?.type || 'navigate';
    };
    const newToken = options.newToken || (() => root.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));

    function fallbackUrl() {
      const url = searchHomeUrl(location.href);
      const network = networkOf(location.href);
      if (network) url.searchParams.set('network', network);
      return url.href;
    }
    function read() {
      const empty = { version: 1, contexts: [], pending: null, returning: null };
      if (!storageAvailable) return empty;
      try {
        const value = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
        if (!value || value.version !== 1 || !Array.isArray(value.contexts)) return empty;
        const contexts = value.contexts.map(item => validateContext(item, location.href)).filter(Boolean).slice(-16);
        const marker = token => typeof token === 'string' && contexts.some(item => item.token === token) ? token : null;
        return { version: 1, contexts, pending: marker(value.pending), returning: marker(value.returning) };
      } catch (_) { storageAvailable = false; return empty; }
    }
    function write(value) {
      if (!storageAvailable) return false;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(value)); return true; }
      catch (_) { storageAvailable = false; return false; }
    }
    function state(key, value) {
      try {
        const next = { ...(history.state && typeof history.state === 'object' ? history.state : {}) };
        if (value) next[key] = value;
        else delete next[key];
        history.replaceState(next, '', location.href);
        return true;
      } catch (_) { return false; }
    }
    function matchesSearch(context) {
      const current = safeReturnUrl(location.href, location.href);
      return context && current === context.returnUrl && networkOf(location.href) === context.network;
    }
    function captureSearch(value) {
      const q = typeof value?.q === 'string' ? value.q.trim() : '';
      const network = networkOf(location.href);
      if (!q || q.length > 200 || !ID.test(value?.candidateId || '') || network === undefined) return false;
      // The browser's own history can prevent an ORCID back/forward redirect loop even when storage is denied.
      // This marker carries no saved candidate list or viewport and is only honored on a return navigation.
      if (value.direct === true) state(DIRECT_STATE, { q, network, returned: false });
      const returnUrl = searchHomeUrl(location.href);
      returnUrl.searchParams.set('q', q);
      const institution = new URL(location.href).searchParams.get('institution');
      if (institution?.trim() && institution.length <= 160) returnUrl.searchParams.set('institution', institution.trim());
      if (network) returnUrl.searchParams.set('network', network);
      const context = validateContext({ version: 1, token: newToken(), q, network, candidateId: value.candidateId,
        scrollY: Math.max(0, Math.min(10000000, Number(value.scrollY) || 0)), returnUrl: returnUrl.href }, location.href);
      if (!context) return false;
      const store = read();
      store.contexts.push(context);
      store.contexts = store.contexts.slice(-16);
      store.pending = context.token;
      store.returning = null;
      if (!write(store)) return false;
      state(SEARCH_STATE, { token: context.token, returned: false });
      return true;
    }
    function detailContext() {
      const route = new URL(location.href);
      const isLive = /^\/workbench\/live\/(?:index\.html)?$/.test(route.pathname);
      if (!isLive && route.pathname !== new URL('checkup.html', location.href).pathname) return null;
      const candidateId = route.searchParams.get(isLive ? 'q' : 'case');
      if (!ID.test(candidateId || '')) return null;
      const store = read();
      const marker = history.state?.[DETAIL_STATE];
      const network = networkOf(location.href);
      let context = store.contexts.find(item => item.token === marker?.token && item.network === network && item.candidateId === candidateId);
      if (context) return context;
      context = store.contexts.find(item => item.token === store.pending && item.network === network);
      if (!context || navigationType() !== 'navigate') return null;
      // Newly opened detail tabs can inherit their opener's sessionStorage, but have no preceding search history entry.
      if (typeof history.length === 'number' && history.length < 2) return null;
      if (candidateId !== context.candidateId) return null;
      // A pending context is adopted once, only by the page actually opened from that search document.
      if (!document?.referrer || safeReturnUrl(document.referrer, location.href) !== context.returnUrl) return null;
      store.pending = null;
      if (!write(store) || !state(DETAIL_STATE, { token: context.token })) return null;
      return context;
    }
    function prepareReturn() {
      const context = detailContext();
      if (!context) return { url: fallbackUrl(), restored: false };
      const store = read();
      store.returning = context.token;
      return write(store) ? { url: context.returnUrl, restored: true } : { url: fallbackUrl(), restored: false };
    }
    function searchRestore({ fromHistory = false } = {}) {
      const store = read();
      const marker = history.state?.[SEARCH_STATE];
      const explicit = store.contexts.find(item => item.token === store.returning && matchesSearch(item));
      const historical = (fromHistory || navigationType() === 'back_forward' || marker?.returned === true) &&
        store.contexts.find(item => item.token === marker?.token && matchesSearch(item));
      const context = explicit || historical || null;
      if (!context) return null;
      if (explicit) { store.returning = null; write(store); }
      state(SEARCH_STATE, { token: context.token, returned: true });
      return context;
    }
    function canRestore(query, context) {
      return Boolean(context && validateContext(context, location.href) && context.q === String(query || '').trim() && matchesSearch(context));
    }
    function shouldShowDirectResult(query, { fromHistory = false } = {}) {
      const marker = history.state?.[DIRECT_STATE];
      if (marker?.q !== String(query || '').trim() || marker.network !== networkOf(location.href) ||
        !(fromHistory || navigationType() === 'back_forward' || marker.returned === true)) return false;
      state(DIRECT_STATE, { q: marker.q, network: marker.network, returned: true });
      return true;
    }
    function clearSearchRestore() {
      state(SEARCH_STATE, null);
      state(DIRECT_STATE, null);
      const store = read();
      if (store.returning) { store.returning = null; write(store); }
    }
    function bindBack(link, onNotice) {
      if (!link) return () => {};
      const context = detailContext();
      const fallback = new URL(fallbackUrl());
      if (!context && !storageAvailable) fallback.hash = 'reader-return-unavailable';
      link.href = fallback.href;
      link.textContent = context ? '返回原搜索结果' : storageAvailable ? '返回搜索' : '返回搜索（原结果未保留）';
      link.dataset.readerReturn = context ? 'saved' : 'plain';
      if (context) link.setAttribute('aria-label', '返回搜索结果：' + context.q + '，恢复所选档案');
      else link.title = storageAvailable ? '此页没有当前标签的搜索上下文。返回普通搜索。' : '浏览器无法保存当前标签的搜索上下文；返回后需重新搜索。';
      if (!context && !storageAvailable && typeof onNotice === 'function') onNotice('浏览器无法保存搜索上下文。返回搜索后，原结果和滚动位置不会保留。');
      const handler = event => {
        if (!isSameTabActivation(event, link)) return;
        event.preventDefault();
        const result = prepareReturn();
        const destination = new URL(result.url);
        if (!result.restored && !storageAvailable) destination.hash = 'reader-return-unavailable';
        location.assign(destination.href);
      };
      link.addEventListener('click', handler);
      return () => link.removeEventListener('click', handler);
    }
    return Object.freeze({ captureSearch, detailContext, prepareReturn, searchRestore, canRestore, shouldShowDirectResult, clearSearchRestore, bindBack,
      fallbackUrl, storageAvailable: () => storageAvailable });
  }

  return Object.freeze({ create, safeReturnUrl, validateContext, networkOf, isSameTabActivation, STORAGE_KEY });
});
