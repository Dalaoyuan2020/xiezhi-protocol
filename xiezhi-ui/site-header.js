/* One public navigation shell for search, checkups, the workbench and administration. */
(function () {
  'use strict';
  const header = document.querySelector('[data-site-header]');
  if (!header) return;
  const workbench = location.pathname.startsWith('/workbench/');
  const base = workbench ? '/workbench/' : '/ui/';
  const path = location.pathname;
  const svg = content => '<svg viewBox="0 0 24 24" aria-hidden="true">' + content + '</svg>';
  const icons = {
    agent: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 16h6"/>',
    scholar: '<circle cx="10" cy="9" r="3"/><path d="M4 20v-2a6 6 0 0 1 8-5.65"/><circle cx="17" cy="16" r="3.5"/><path d="m19.5 18.5 2.5 2.5"/>',
    org: '<path d="m3 9 9-6 9 6H3ZM4 21h16M5 11v7m5-7v7m4-7v7m5-7v7"/>',
    cases: '<rect x="4" y="4" width="12" height="14" rx="2"/><path d="M8 8h4m-4 4h5m-5 9h10a2 2 0 0 0 2-2V8"/>',
    papers: '<path d="M4 3h10l4 4v5M14 3v5h4M4 3v18h8M8 8h3M8 12h4"/><circle cx="17" cy="17" r="4"/><path d="m20 20 2 2"/>',
    paper: '<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 15l3 3 5-6"/>',
    present: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v5m-4 0h8m-4-14 4 3-4 3V7Z"/>',
    workspace: '<circle cx="12" cy="5" r="3"/><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="m10.5 8-4 7m7-7 4 7M8 18h8"/>',
    workbench: '<path d="M3 4h18v16H3zM8 4v16M8 9h13M12 13h5m-5 3h5"/>',
    minimal: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="9" cy="12" r="2"/><path d="m10.5 13.5 1.5 1.5M16 12h2"/>'
  };
  const active = /\/org\.html$/.test(path) ? 'org'
    : /\/papers\.html$/.test(path) ? 'papers'
    : /\/cases\.html$/.test(path) ? 'cases'
    : path.startsWith('/paper/') ? 'paper'
    : path.startsWith('/workspace/') ? 'workspace'
    : /\/(?:ui|live)\//.test(path) || workbench && /\/(?:index|checkup)\.html$|\/workbench\/$|\/live\//.test(path) ? 'scholar' : '';
  const icon = key => '<i class="guanya-app-icon" aria-hidden="true">' + svg(icons[key]) + '</i>';
  const tiles = [
    ['scholar', base, '个人体检'],
    ['org', base + 'org.html', '机构查询'],
    ['cases', '/ui/cases.html', '典型案例'],
    ['papers', base + 'papers.html', '论文检索'],
    ['paper', '/paper/', '论文体检']
  ];
  header.className = 'xz-site-header';
  const guide = header.hasAttribute('data-guide-enabled')
    ? '<button class="xz-guide-trigger" type="button" data-claim-demo aria-haspopup="dialog">怎么用？</button>' : '';
  header.innerHTML = '<a class="xz-site-brand" href="/ui/" aria-label="灋廌覈鑒 Xiezhi 首页，学术信誉链">' +
    '<span>灋廌覈鑒</span><small>学术信誉链 · Xiezhi</small></a>' +
    guide +
    '<div class="xz-site-apps"><button type="button" id="menu-toggle" aria-label="打开菜单" aria-expanded="false" aria-controls="menu-panel">' +
    svg([6, 12, 18].flatMap(y => [6, 12, 18].map(x => '<circle cx="' + x + '" cy="' + y + '" r="1.5"/>')).join('')) +
    '</button><nav id="menu-panel" data-shared-navigation="true" aria-label="功能菜单" hidden></nav></div>';
  const panel = header.querySelector('#menu-panel');
  for (const [key, href, label] of tiles) {
    const link = document.createElement('a');
    link.className = 'guanya-app-tile'; link.href = href;
    if (key === active) link.setAttribute('aria-current', 'page');
    link.innerHTML = icon(key) + '<span>' + label + '</span>';
    panel.append(link);
  }

  // Keep each page's projection controller and its event handlers intact.
  const existingProjection = ['sc-present', 'org-present', 'ss-present'].map(id => document.getElementById(id)).find(Boolean);
  const projection = existingProjection || document.createElement('button');
  projection.id = existingProjection?.id || header.dataset.projectionControl || 'xz-present';
  projection.type = 'button'; projection.className = 'guanya-app-tile';
  projection.removeAttribute('style'); projection.setAttribute('aria-pressed', 'false');
  projection.setAttribute('aria-label', '投影模式');
  projection.innerHTML = icon('present') + '<span>投影模式</span>';
  panel.append(projection);
  if (!existingProjection && !header.dataset.projectionControl) {
    const setProjection = enabled => {
      document.body.dataset.presentation = String(enabled);
      document.body.dataset.sitePresentation = String(enabled);
      projection.setAttribute('aria-pressed', String(enabled));
      projection.querySelector('span').textContent = enabled ? '退出投影' : '投影模式';
    };
    projection.addEventListener('click', () => setProjection(document.body.dataset.presentation !== 'true'));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') setProjection(false); });
  }
  const workspace = document.createElement('a');
  workspace.className = 'guanya-app-tile'; workspace.href = '/workspace/';
  workspace.setAttribute('aria-label', '知行社社区');
  if (active === 'workspace') workspace.setAttribute('aria-current', 'page');
  workspace.innerHTML = icon('workspace') + '<span>知行社 · 社区</span>'; panel.append(workspace);
  const agentLink = document.createElement('a');
  agentLink.className = 'guanya-app-tile'; agentLink.href = '/llms.txt';
  agentLink.setAttribute('aria-label', 'Agent 接口说明（llms.txt）');
  agentLink.innerHTML = icon('agent') + '<span>Agent 接口</span>'; panel.append(agentLink);
  const edition = document.createElement('a');
  edition.id = 'edition-workbench'; edition.className = 'guanya-app-tile';
  edition.href = workbench ? '/ui/index.html' : '/workbench/index.html';
  const editionLabel = workbench ? '返回搜索首页' : '切换工作台';
  edition.setAttribute('aria-label', editionLabel);
  edition.innerHTML = icon('workbench') + '<span>' + editionLabel + '</span>';
  panel.append(edition);
  if (document.body.classList.contains('guanya-search-page')) {
    const minimal = document.createElement('button');
    minimal.id = 'xz-minimal-toggle'; minimal.type = 'button'; minimal.className = 'guanya-app-tile';
    minimal.setAttribute('aria-pressed', 'false');
    minimal.innerHTML = icon('minimal') + '<span>极简模式</span>';
    minimal.addEventListener('click', () => document.dispatchEvent(new CustomEvent('xiezhi:minimal-toggle')));
    panel.insertBefore(minimal, projection);
  }

  function retainContext(anchor, switching = false) {
    const current = new URL(location.href);
    let target = new URL(anchor.href || '/ui/', current);
    if (switching) {
      const equivalent = /\/(checkup|org|papers)\.html$/.exec(path)?.[1];
      const root = workbench ? '/ui/' : '/workbench/';
      target = new URL(path.includes('/live/') ? (workbench ? '/live/' : '/workbench/live/') : equivalent ? root + equivalent + '.html' : root + 'index.html', current);
      const fields = equivalent === 'papers' ? ['q', 'author', 'source', 'mode', 'discipline', 'page']
        : equivalent === 'checkup' ? ['case', 'q', 'institution'] : ['q', 'institution'];
      for (const field of fields) {
        const value = current.searchParams.get(field)?.trim();
        if (value && value.length <= (field === 'q' && equivalent === 'papers' ? 400 : 160)) target.searchParams.set(field, value);
      }
      if (path.includes('/live/') && current.searchParams.get('demo') === 'claim-xu') target.searchParams.set('demo', 'claim-xu');
    }
    const network = current.searchParams.get('network');
    if (['mainnet', 'testnet'].includes(network) && /^\/(?:ui|workbench|live)\//.test(target.pathname)) target.searchParams.set('network', network);
    anchor.href = target.pathname + target.search;
  }
  header.querySelectorAll('a[href]').forEach(anchor => retainContext(anchor, anchor === edition));
  for (const eventName of ['click', 'auxclick', 'contextmenu', 'focusin']) {
    header.addEventListener(eventName, event => {
      const anchor = event.target.closest('a[href]');
      if (anchor) retainContext(anchor, anchor === edition);
    });
  }
  const toggle = header.querySelector('#menu-toggle');
  function setOpen(open, restoreFocus = false) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
    if (restoreFocus) toggle.focus({ preventScroll: true });
  }
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  toggle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault(); setOpen(true);
    panel.querySelector('a[href]')?.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); setOpen(false, true); }
  });
  const outside = event => { if (!panel.hidden && !header.querySelector('.xz-site-apps').contains(event.target)) setOpen(false); };
  document.addEventListener('click', outside); document.addEventListener('focusin', outside);
  panel.addEventListener('click', event => {
    const action = event.target.closest('a[href],button');
    if (action && panel.contains(action)) setOpen(false, action.tagName === 'BUTTON');
  });
}());
