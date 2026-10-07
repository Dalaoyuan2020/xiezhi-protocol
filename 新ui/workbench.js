(function () {
  'use strict';
  const registry = window.XiezhiPages;
  if (!registry) return;
  const section = registry.byKey(document.body.dataset.section)?.key || 'reader';
  const sidebarSlot = document.getElementById('wb-sidebar-slot');
  const topbarSlot = document.getElementById('wb-topbar-slot');
  if (!sidebarSlot || !topbarSlot) return;
  const siteHeader = document.querySelector('[data-site-header]');
  const links = registry.pages.filter(page => page.group === 'roles');
  function navLink(key, href, label, description, icon) {
    const a = document.createElement('a');
    a.className = 'wb-nav-link'; a.href = href;
    if (section === key) a.setAttribute('aria-current', 'page');
    if (icon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = '<path d="' + icon + '"/>'; a.append(svg);
    }
    const text = document.createElement('span'); text.textContent = label;
    if (description) { const small = document.createElement('small'); small.textContent = description; text.append(small); }
    a.append(text); return a;
  }
  const aside = document.createElement('aside');
  aside.id = 'wb-sidebar'; aside.className = 'wb-sidebar'; aside.setAttribute('aria-label', '工作台导航');
  aside.innerHTML = '<button type="button" class="wb-drawer-close" aria-label="关闭导航">关闭 <span aria-hidden="true">×</span></button>' +
    '<p class="wb-motto">我们聚在这里<br>就无所不知，无所不能</p>';
  const nav = document.createElement('nav'); nav.className = 'wb-nav'; nav.setAttribute('aria-label', '工作视角与公共工具');
  const caption = document.createElement('p'); caption.className = 'wb-nav-label'; caption.textContent = '工作视角'; nav.append(caption);
  links.forEach(item => nav.append(navLink(item.key, item.file, item.label, item.description, item.icon)));
  const tools = document.createElement('p'); tools.className = 'wb-nav-label'; tools.textContent = '公共工具'; nav.append(tools);
  for (const item of registry.pages.filter(page => page.group === 'tools')) nav.append(navLink(item.key, item.file, item.label));
  aside.append(nav);
  const boundary = document.createElement('p'); boundary.className = 'wb-sidebar-note';
  boundary.textContent = '角色入口仅切换工作视角，不代表登录身份、认证或业务权限。'; aside.append(boundary);
  sidebarSlot.replaceChildren(aside);
  const header = document.createElement('div'); header.className = 'wb-topbar';
  header.setAttribute('role', 'region'); header.setAttribute('aria-label', '工作台视角与网络');
  header.innerHTML = '<button id="wb-menu-toggle" class="wb-menu-toggle" type="button" aria-controls="wb-sidebar" aria-expanded="false" aria-label="打开导航">☰ <span>导航</span></button><div class="wb-topbar-title"><span>学术工作台</span><strong></strong></div><div class="wb-topbar-tools"><span class="wb-view-badge">工作视角 · 非身份认证</span><a id="sc-network-choice" href="?network=testnet">查看测试网 968 ↗</a></div>';
  header.querySelector('strong').textContent = registry.byKey(section).label; topbarSlot.replaceChildren(header);
  if (registry.byKey(section).localOnly) header.querySelector('.wb-view-badge').textContent = '本地工作区 · 本页不读写链';
  function measureTopbar() { document.documentElement.style.setProperty('--wb-topbar-height', (siteHeader || header).getBoundingClientRect().height + 'px'); }
  measureTopbar();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureTopbar).observe(siteHeader || header);
  const toggle = document.getElementById('wb-menu-toggle');
  const close = aside.querySelector('.wb-drawer-close');
  const backdrop = document.getElementById('wb-drawer-backdrop');
  const content = document.querySelector('.wb-content');
  const smallScreen = matchMedia('(max-width: 900px)');
  let open = false;
  function setOpen(next, restore = true) {
    open = Boolean(next && smallScreen.matches);
    document.body.classList.toggle('wb-drawer-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (backdrop) backdrop.hidden = !open;
    aside.inert = smallScreen.matches && !open;
    if (smallScreen.matches) aside.setAttribute('aria-hidden', String(!open));
    else aside.removeAttribute('aria-hidden');
    if (open) { aside.setAttribute('role', 'dialog'); aside.setAttribute('aria-modal', 'true'); }
    else { aside.removeAttribute('role'); aside.removeAttribute('aria-modal'); }
    if (content) content.inert = open;
    header.inert = open;
    if (siteHeader) siteHeader.inert = open;
    if (open) close.focus();
    else if (restore && smallScreen.matches) toggle.focus();
  }
  toggle.addEventListener('click', () => setOpen(!open));
  close.addEventListener('click', () => setOpen(false));
  backdrop?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...aside.querySelectorAll('a[href],button:not(:disabled)')].filter(node => node.getClientRects().length);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, true);
  smallScreen.addEventListener('change', () => setOpen(false, false));
  setOpen(false, false);
})();
