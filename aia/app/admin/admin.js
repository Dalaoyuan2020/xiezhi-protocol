(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = '/admin/sources/api/';
  let csrfToken = '';
  let records = [];
  let filter = 'all';
  let authVersion = 0;
  const activeRequests = new Set();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function status(message, error = false) {
    $('admin-status').textContent = message;
    $('admin-status').dataset.state = error ? 'error' : '';
  }
  function lock(message = '') {
    authVersion++;
    csrfToken = '';
    records = [];
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
    $('admin-token').value = '';
    $('admin-sources').replaceChildren();
    $('admin-workspace').hidden = true;
    $('admin-login-panel').hidden = false;
    $('admin-logout').hidden = true;
    status(message);
  }
  async function request(path, { method = 'GET', data } = {}) {
    const controller = new AbortController();
    activeRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    const headers = { Accept: 'application/json' };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken && path !== 'login') headers['X-CSRF-Token'] = csrfToken;
    try {
      const response = await fetch(base + path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 401 && path !== 'login') lock('管理会话已过期，请重新登录。');
        throw new Error(typeof body.error === 'string' ? body.error.slice(0, 350) : '操作未完成，请重试。');
      }
      return body;
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('暂时无法连接管理服务，请稍后重试。');
      if (controller.signal.aborted) throw new Error('请求未完成，请重试。');
      throw error;
    } finally {
      clearTimeout(timer);
      activeRequests.delete(controller);
    }
  }
  function fieldStatus(field) {
    if (field.origin === 'disabled') return '已停用';
    if (!field.configured) return '未设置';
    return field.origin === 'environment' ? '已设置 · 环境变量' : '已设置 · 本地保存';
  }
  function setCardBusy(card, busy) {
    card.setAttribute('aria-busy', String(busy));
    card.querySelectorAll('button,input').forEach(node => { node.disabled = busy; });
  }
  function applyFilter() {
    let visible = 0;
    for (const card of $('admin-sources').children) {
      card.hidden = filter !== 'all' && card.dataset.status !== filter;
      if (!card.hidden) visible++;
    }
    $('admin-empty').hidden = visible > 0;
    document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
  }
  function summary() {
    $('admin-count-wired').textContent = String(records.filter(source => source.status === 'implemented' && source.kind === 'literature').length);
    $('admin-count-planned').textContent = String(records.filter(source => source.status !== 'implemented').length);
    $('admin-count-configured').textContent = String(records.flatMap(source => Array.isArray(source.fields) ? source.fields : []).filter(field => field.configured).length);
  }
  function replaceSources(data, changedId, message) {
    if (!Array.isArray(data.sources)) throw new Error('数据源列表格式不完整，请刷新重试。');
    records = data.sources;
    if (changedId) {
      const source = records.find(item => item.id === changedId);
      const existing = [...$('admin-sources').children].find(card => card.dataset.source === changedId);
      if (source && existing) {
        const restoreFocus = existing.contains(document.activeElement);
        const replacement = renderSource(source);
        replacement.querySelector('.admin-card-status').textContent = message || '配置已更新。';
        existing.replaceWith(replacement);
        if (restoreFocus) replacement.querySelector('button')?.focus({ preventScroll: true });
      }
    } else $('admin-sources').replaceChildren(...records.map(renderSource));
    summary();
    applyFilter();
  }
  async function changeSource(source, card, { method, data, message }) {
    const version = authVersion;
    setCardBusy(card, true);
    const note = card.querySelector('.admin-card-status');
    note.dataset.state = '';
    note.textContent = '正在保存…';
    try {
      const result = await request('sources/' + encodeURIComponent(source.id), { method, data });
      if (version !== authVersion || !csrfToken) return;
      replaceSources(result, source.id, message);
      status(`${source.label}：${message}`);
    } catch (error) {
      if (version !== authVersion) return;
      note.dataset.state = 'error';
      note.textContent = error.message;
      status('操作未完成，请检查该数据源卡片中的提示。', true);
    } finally {
      if (card.isConnected) setCardBusy(card, false);
    }
  }
  function renderSource(source) {
    const card = el('article', 'admin-source-card');
    card.dataset.source = source.id;
    card.dataset.status = source.status === 'implemented' ? 'implemented' : 'planned';
    const heading = el('div', 'admin-source-head');
    const badge = el('span', 'admin-source-badge', source.enabled === false ? '已暂停' : source.kind === 'mail' ? '邮件服务' : source.kind === 'model' ? '评审模型' : source.status === 'implemented' ? '已接入检索' : '待接入');
    badge.dataset.state = source.enabled === false ? 'disabled' : source.status;
    heading.append(el('h2', '', source.label), badge);
    card.append(heading);
    const description = typeof source.description === 'string' ? source.description : '';
    card.append(el('p', 'admin-source-description', description + (source.status !== 'implemented' ? ' 当前尚未参与检索，保存凭据不会自动启用检索能力。' : '')));
    const fields = Array.isArray(source.fields) ? source.fields : [];
    if (fields.length) {
      const form = el('form', 'admin-source-form');
      form.setAttribute('aria-label', source.label + ' 凭据配置');
      for (const [index, field] of fields.entries()) {
        const group = el('div', 'admin-field');
        const label = el('label', 'admin-field-label', field.label || field.name);
        const input = el('input');
        input.id = `source-${source.id}-field-${index}`;
        label.htmlFor = input.id;
        label.append(el('span', '', fieldStatus(field)));
        input.name = field.name;
        input.type = field.secret === false ? 'text' : 'password';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.maxLength = 4096;
        input.placeholder = field.configured ? '留空保留当前值；输入新值可替换' : '输入新值，或留空';
        if (field.secret === false && typeof field.value === 'string') input.value = field.value || field.suggestedValue || '';
        group.append(label, input, el('code', '', field.name));
        form.append(group);
      }
      const save = el('button', 'admin-primary', '保存新值');
      save.type = 'submit';
      form.append(save);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const values = {};
        for (const input of form.querySelectorAll('input')) {
          const value = input.name === 'SMTP_PASS' ? input.value : input.value.trim();
          if (value) values[input.name] = value;
          input.value = '';
        }
        if (!Object.keys(values).length) {
          const note = card.querySelector('.admin-card-status');
          note.dataset.state = '';
          note.textContent = '没有输入新值，现有配置已保留。';
          return;
        }
        changeSource(source, card, { method: 'PUT', data: { values }, message: source.status === 'implemented' ? '配置已保存；尚未向上游发起调用，可用性以实际请求为准。' : '凭据已保存，该来源仍待接入。' });
      });
      card.append(form);
    } else card.append(el('p', 'admin-keyless', '此来源不需要填写访问密钥。'));
    const note = el('p', 'admin-card-status');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    card.append(note);
    const footer = el('div', 'admin-source-foot');
    const clear = el('button', 'admin-text-button', '清除本地配置');
    clear.type = 'button';
    clear.addEventListener('click', () => changeSource(source, card, { method: 'DELETE', data: { mode: 'clear' }, message: '本地覆盖已清除，已恢复服务器默认设置。' }));
    const toggle = el('button', 'admin-text-button', source.enabled === false ? '重新启用' : '暂停此源');
    toggle.type = 'button';
    toggle.addEventListener('click', () => changeSource(source, card, source.enabled === false
      ? { method: 'PUT', data: { values: {}, enabled: true }, message: '已重新启用，原有凭据已保留。' }
      : { method: 'DELETE', data: { mode: 'disable' }, message: '已暂停此来源，原有凭据已保留。' }));
    footer.append(toggle, clear);
    try {
      const url = new URL(source.docsUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const docs = el('a', '', '官方说明 ↗');
        docs.href = url.href;
        docs.target = '_blank';
        docs.rel = 'noopener noreferrer';
        footer.append(docs);
      }
    } catch (_) { /* A missing documentation URL needs no placeholder. */ }
    card.append(footer, el('p', 'admin-reset-note', '清除本地配置会移除保存值；服务器环境变量可能继续生效。暂停可保留配置。'));
    return card;
  }
  async function loadSources(version = authVersion) {
    const data = await request('sources');
    if (version !== authVersion || !csrfToken) return;
    replaceSources(data);
    $('admin-login-panel').hidden = true;
    $('admin-workspace').hidden = false;
    $('admin-logout').hidden = false;
    status('已载入配置状态。密钥内容不会回显。');
  }
  $('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const token = $('admin-token').value.trim();
    if (!token) return;
    const version = ++authVersion;
    $('admin-token').value = '';
    $('admin-login').disabled = true;
    status('正在验证管理访问口令…');
    try {
      const data = await request('login', { method: 'POST', data: { token } });
      if (version !== authVersion) return;
      if (!data.authenticated || typeof data.csrfToken !== 'string') throw new Error('管理会话未建立，请重试。');
      csrfToken = data.csrfToken;
      await loadSources(version);
    } catch (error) { if (version === authVersion) status(error.message, true); }
    finally { $('admin-login').disabled = false; }
  });
  $('admin-logout').addEventListener('click', async () => {
    $('admin-logout').disabled = true;
    try { await request('logout', { method: 'POST', data: {} }); lock('已退出管理。'); }
    catch (error) { status(error.message, true); }
    finally { $('admin-logout').disabled = false; }
  });
  $('admin-refresh').addEventListener('click', async () => {
    $('admin-refresh').disabled = true;
    status('正在刷新配置状态…');
    try { await loadSources(); }
    catch (error) { status(error.message, true); }
    finally { $('admin-refresh').disabled = false; }
  });
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; applyFilter(); }));
  (async () => {
    const version = ++authVersion;
    try {
      const session = await request('session');
      if (version !== authVersion) return;
      if (session.authenticated && typeof session.csrfToken === 'string') {
        csrfToken = session.csrfToken;
        await loadSources(version);
      } else status('请输入管理访问口令。');
    } catch (error) { if (version === authVersion) status(error.message, true); }
  })();
})();
