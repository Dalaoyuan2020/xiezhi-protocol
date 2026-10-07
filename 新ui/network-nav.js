/* Explicit network selection; never treat testnet as a mainnet deployment. */
(function () {
  'use strict';
  const registry = globalThis.XiezhiPages;
  const requested = new URLSearchParams(location.search).get('network');
  const currentPath = new URL(location.href).pathname;
  const appBase = currentPath.startsWith('/workbench/') ? '/workbench/' : new URL('.', location.href).pathname;
  // Only an absent mainnet manifest enables automatic testnet selection.
  // Explicit choices never fall back across networks, including on RPC errors.
  if (!requested) {
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const mainnet = await fetch('/chain/deployments/botchain.json', { cache: 'no-store', signal: controller.signal });
        if (mainnet.status !== 404) return;
        const response = await fetch('/chain/deployments/botchain-testnet.json', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const config = await response.json();
        if (config.chainId !== 968 || !/^0x[0-9a-f]{40}$/i.test(config.address || '') || /^0x0{40}$/i.test(config.address) || !Number.isSafeInteger(config.block) || config.block < 0) return;
        const next = new URL(location.href);
        next.searchParams.set('network', 'testnet');
        location.replace(next.href);
      } catch (_) { /* Keep the visible snapshot or explicit read error. */ }
      finally { clearTimeout(timer); }
    })();
  }
  const testnet = new URLSearchParams(location.search).get('network') === 'testnet';
  const slot = document.getElementById('sc-network-choice');
  function networkTarget() {
    const target = new URL(location.href);
    if (testnet) target.searchParams.set('network', 'mainnet');
    else target.searchParams.set('network', 'testnet');
    // A network switch must not carry a fictional query into real chain mode.
    if (target.pathname.endsWith('/org.html')) {
      target.searchParams.delete('q');
      target.searchParams.delete('mode');
    }
    return target.pathname + target.search;
  }
  if (slot) {
    slot.href = networkTarget();
    slot.addEventListener('click', () => { slot.href = networkTarget(); });
    slot.textContent = testnet ? '切回主网 677 ↗' : '查看测试网 968 ↗';
    slot.setAttribute('aria-label', testnet ? '切换到 BOT Chain 主网 677' : '切换到 BOT Chain 测试网 968，仅测试');
  }
  // Preserve either explicit network across the existing local entry points.
  // Leave the network-switch control and external source links untouched.
  if (requested === 'mainnet' || requested === 'testnet') {
    function syncLink(anchor) {
      if (!anchor || anchor.id === 'sc-network-choice') return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || !registry?.isAppPath(url.pathname, appBase)) return;
      url.searchParams.set('network', requested);
      if (anchor.href !== url.href) anchor.href = url.href;
    }
    function syncTree(node) {
      if (node.matches?.('a[href]')) syncLink(node);
      node.querySelectorAll?.('a[href]').forEach(syncLink);
    }
    // Real hrefs retain the selection for copying, middle-click and new tabs too.
    syncTree(document);
    document.addEventListener('click', event => syncLink(event.target.closest?.('a[href]')), true);
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') syncLink(record.target);
          else record.addedNodes.forEach(syncTree);
        }
      });
      const observeLinks = () => observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      observeLinks();
      window.addEventListener('pagehide', () => observer.disconnect());
      window.addEventListener('pageshow', observeLinks);
    }
  }
  const noticeSlot = document.getElementById('network-notice');
  if (!noticeSlot) return;
  const banner = document.createElement('aside');
  banner.className = 'sc-network-notice';
  banner.setAttribute('aria-label', '当前网络');
  banner.dataset.network = testnet ? 'testnet' : 'mainnet';
  banner.textContent = testnet
    ? 'BOT Chain 测试网 · Chain ID 968 · 测试网交易不属于主网交付'
    : '当前选择 BOT Chain 主网 · Chain ID 677 · 部署与记录状态以各功能面板的核验结果为准';
  if (registry?.forPath(location.pathname || new URL(location.href).pathname)?.localOnly) banner.textContent += ' · 本页不读写链';
  noticeSlot.replaceChildren(banner);
}());
