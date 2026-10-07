/* Explicit network selection; never treat testnet as a mainnet deployment. */
(function () {
  'use strict';
  const requested = new URLSearchParams(location.search).get('network');
  // Only an absent mainnet manifest enables automatic testnet selection.
  // Explicit choices never fall back across networks, including on RPC errors.
  if (!requested) {
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const mainnet = await fetch('../chain/deployments/botchain.json', { cache: 'no-store', signal: controller.signal });
        if (mainnet.status !== 404) return;
        const response = await fetch('../chain/deployments/botchain-testnet.json', { cache: 'no-store', signal: controller.signal });
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
  if (!testnet) return;
  const banner = document.createElement('aside');
  banner.className = 'sc-network-notice';
  banner.setAttribute('aria-label', '当前网络');
  banner.textContent = 'BOT Chain 测试网 · Chain ID 968 · 测试网交易不属于主网交付';
  document.querySelector('header')?.after(banner);
  const css = document.createElement('style');
  css.textContent = '.sc-network-notice{padding:10px 24px;text-align:center;background:#352914;color:#ffdb97;border-bottom:1px solid #ffc56e50;font:13px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}';
  document.head.append(css);
  // Dynamic case/candidate links also retain the explicitly selected network.
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor || anchor.id === 'sc-network-choice') return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !/\/(?:index|checkup|card|org)\.html$/.test(url.pathname)) return;
    url.searchParams.set('network', 'testnet');
    anchor.href = url.href;
  }, true);
}());
