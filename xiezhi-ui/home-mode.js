(function () {
  'use strict';
  if (!document.body.classList.contains('guanya-search-page')) return;
  const key = 'xiezhi:home:minimal';
  const exit = document.getElementById('home-mode-exit');
  const query = document.getElementById('ss-query');
  const toggle = document.getElementById('xz-minimal-toggle');
  const viewport = window.visualViewport;
  function fitVisibleViewport() {
    // Mobile keyboards resize the visual viewport, while 100svh can stay unchanged.
    // Preserve browser zoom: a pinch gesture must not reflow the page to its zoomed height.
    if (viewport && viewport.scale === 1) {
      document.body.style.setProperty('--home-viewport-height', Math.round(viewport.height) + 'px');
    } else {
      document.body.style.removeProperty('--home-viewport-height');
    }
  }
  viewport?.addEventListener('resize', fitVisibleViewport);
  fitVisibleViewport();

  function setMinimal(enabled, { focus = false, persist = true } = {}) {
    document.body.dataset.minimal = String(enabled);
    exit.hidden = !enabled;
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.setAttribute('aria-label', enabled ? '关闭极简模式' : '开启极简模式');
      const label = toggle.querySelector('span');
      if (label) label.textContent = enabled ? '退出极简' : '极简模式';
    }
    if (persist) {
      try { localStorage.setItem(key, String(enabled)); } catch { /* Usable when browser storage is disabled. */ }
    }
    document.dispatchEvent(new CustomEvent('xiezhi:minimal-change', { detail: { enabled } }));
    if (focus) requestAnimationFrame(() => {
      (enabled ? query : document.getElementById('menu-toggle'))?.focus({ preventScroll: true });
    });
  }

  document.addEventListener('xiezhi:minimal-toggle', event => {
    const enabled = typeof event.detail?.enabled === 'boolean'
      ? event.detail.enabled : document.body.dataset.minimal !== 'true';
    setMinimal(enabled, { focus: true });
  });
  exit.addEventListener('click', () => setMinimal(false, { focus: true }));
  window.addEventListener('storage', event => {
    if (event.key !== key) return;
    const enabled = event.newValue === 'true';
    const active = document.activeElement;
    const focus = document.hasFocus() && (enabled ? !!active?.closest('[data-site-header]') : active === exit);
    setMinimal(enabled, { persist: false, focus });
  });
  let saved = false;
  try { saved = localStorage.getItem(key) === 'true'; } catch { /* Default to the full homepage. */ }
  setMinimal(saved, { persist: false });
}());
