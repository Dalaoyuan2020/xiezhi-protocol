/* Shared navigation disclosure. Kept external so it works with the site's CSP. */
(function () {
  'use strict';
  const appMenu = document.getElementById('menu-panel');
  if (appMenu && !document.getElementById('edition-workbench')) {
    const link = document.createElement('a');
    link.id = 'edition-workbench'; link.className = 'guanya-app-tile';
    link.setAttribute('aria-label', '切换工作台');
    const icon = document.createElement('span'); icon.className = 'guanya-app-icon'; icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3 4h18v16H3zM8 4v16M8 9h13M12 13h5m-5 3h5');
    svg.append(path); icon.append(svg);
    const label = document.createElement('span'); label.textContent = '切换工作台';
    link.append(icon, label);
    function updateDestination() {
      const destination = new URL('/workbench/index.html', location.href);
      const parameters = new URLSearchParams(location.search);
      for (const name of ['q', 'institution']) {
        const value = parameters.get(name)?.trim();
        if (value && value.length <= 160) destination.searchParams.set(name, value);
      }
      const network = parameters.get('network');
      if (network === 'mainnet' || network === 'testnet') destination.searchParams.set('network', network);
      link.href = destination.pathname + destination.search;
    }
    updateDestination();
    for (const eventName of ['click', 'auxclick', 'contextmenu', 'focus']) link.addEventListener(eventName, updateDestination);
    appMenu.append(link);
  }
  const seal = document.getElementById('brand-seal');
  let sealTurn;
  seal?.addEventListener('click', () => {
    if (sealTurn?.playState === 'running') return;
    // A deliberate click requests the complete turn and scale animation.
    const frames = [
      { transform: 'rotate(-3deg) scale(1)', offset: 0 },
      { transform: 'rotate(177deg) scale(1.04)', offset: .5 },
      { transform: 'rotate(357deg) scale(1)', offset: 1 }
    ];
    sealTurn = seal.animate(frames, { duration: 1800, easing: 'ease-in-out' });
  });
  const toggle = document.getElementById('menu-toggle');
  const panel = document.getElementById('menu-panel');
  if (!toggle || !panel) return;
  if (panel.dataset.sharedNavigation === 'true') return;

  function setOpen(open, restoreFocus = false) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
    if (restoreFocus) toggle.focus({ preventScroll: true });
  }
  setOpen(false);
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  toggle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    setOpen(true);
    panel.querySelector('a[href], button:not([disabled])')?.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  function outside(event) {
    if (!panel.hidden && !toggle.contains(event.target) && !panel.contains(event.target)) setOpen(false);
  }
  document.addEventListener('click', outside);
  document.addEventListener('focusin', outside);
  panel.addEventListener('click', event => {
    const action = event.target.closest('a[href], button');
    if (action && panel.contains(action)) setOpen(false, action.tagName === 'BUTTON');
  });
}());
