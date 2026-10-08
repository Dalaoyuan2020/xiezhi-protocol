// Exact public assets: colorful search is the default; the workbench is optional.
// Both variants share public data and APIs, never private files.
export const publicAssets = new Map();
for (const name of ['index.html','checkup.html','org.html','reviewer.html','submitter.html','rules.html','data.html','style.css','workbench.css','workbench.js','page-registry.js','reader-context.js','role-drafts-core.js','role-drafts.js','role-workspace.css','evidence-core.js','evidence-panel.css','search.css','search.js','search-core.js','search-data.json','org.css','org.js','org-core.js','org-mock.json','network-nav.js','checkup.js','checkup-page.css','checkup-core.js','checkup-card.js','checkup-card.css','checkup-receipt.js','checkup-receipt.css','checkup-chain.js','checkup-chain.css','checkup-actions.js','checkup-actions.css','papers.html','papers.js','papers.css']) publicAssets.set(`/workbench/${name}`, `新ui/${name}`);
publicAssets.set('/workbench/', '新ui/index.html');
for (const name of ['index.html','checkup.html','org.html','style.css','style-guanya.css','guanya-components.css','search.css','search.js','search-core.js','search-data.json','org.css','org.js','org-core.js','org-mock.json','network-nav.js','checkup.js','checkup-page.css','checkup-core.js','checkup-card.js','checkup-card.css','checkup-receipt.js','checkup-receipt.css','checkup-chain.js','checkup-chain.css','checkup-actions.js','checkup-actions.css','points-rules.js','checkup-points-core.js','checkup-points.js','checkup-points.css']) publicAssets.set(`/ui/${name}`, `xiezhi-ui/${name}`);
publicAssets.set('/ui/', 'xiezhi-ui/index.html');
for (const name of ['cases.html', 'menu.js', 'menu.css']) publicAssets.set(`/ui/${name}`, `xiezhi-ui/${name}`);
publicAssets.set('/ui/entry.css', 'xiezhi-ui/entry.css');
for (const name of ['site-header.js', 'site-header.css']) publicAssets.set(`/ui/${name}`, `xiezhi-ui/${name}`);
publicAssets.set('/ui/home-mode.js', 'xiezhi-ui/home-mode.js');
for (const name of ['papers.html', 'papers.js', 'papers.css']) publicAssets.set(`/ui/${name}`, `xiezhi-ui/${name}`);
publicAssets.set('/product/mock_cases.json', 'aia/product/mock_cases.json');
// 实时版：输入名字 → Agent 实时检索 → 评分 → 本人认领盖红章（Claude 维护）
publicAssets.set('/live/', 'aia/live/index.html');
for (const name of ['index.html', 'live.js', 'live.css', 'zhidian.js']) publicAssets.set(`/live/${name}`, `aia/live/${name}`);
publicAssets.set('/workbench/live/', 'aia/live/workbench.html');
publicAssets.set('/workbench/live/index.html', 'aia/live/workbench.html');
publicAssets.set('/workbench/live/workbench-live.css', 'aia/live/workbench-live.css');
publicAssets.set('/workbench/live/live.js', 'aia/live/live.js');
for (const name of ['claim-flow.js', 'claim-flow.css']) {
  publicAssets.set(`/live/${name}`, `aia/live/${name}`);
  publicAssets.set(`/workbench/live/${name}`, `aia/live/${name}`);
}
publicAssets.set('/paper/', 'aia/paper-checkup/index.html');
for (const name of ['index.html', 'paper.css', 'paper.js']) publicAssets.set(`/paper/${name}`, `aia/paper-checkup/${name}`);
for (const name of ['ActionRegistry.json', 'PointsLedger.json']) publicAssets.set(`/chain/artifacts/${name}`, `aia/chain/artifacts/${name}`);
for (const name of ['botchain.json','botchain-testnet.json','journals.json','journals-testnet.json','points.json','points-testnet.json']) publicAssets.set(`/chain/deployments/${name}`, `aia/chain/deployments/${name}`);
// Agent 入口：llms.txt 说明公开接口与 Agent 授权；agent-guide.md 为社区 Agent 接口全文
publicAssets.set('/llms.txt', 'aia/agent/llms.txt');
publicAssets.set('/agent-guide.md', 'aia/app/AGENT_GUIDE.md');
for (const name of ['seal.html','seal.png','zhidian-coin.png','zhidian-coin-256.png','zhidian-coin-gold.png','zhidian-coin-gold-256.png']) publicAssets.set(`/brand/${name}`, `brand/${name}`);

export const publicMime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

export function publicRedirect(url) {
  let target = url.pathname;
  if (['/', '/index.html', '/ui'].includes(target)) target = '/ui/';
  else if (target === '/workbench') target = '/workbench/';
  else if (target === '/paper') target = '/paper/';
  else if (target === '/live' || target === '/workbench/live') target += '/';
  else if (target === '/classic') target = '/ui/';
  else if (target.startsWith('/classic/')) {
    const tail = target.slice('/classic/'.length);
    target = tail === 'live' || tail.startsWith('live/') ? '/live/' + tail.slice('live/'.length) : '/ui/' + tail;
    if (target !== '/ui/card.html' && !publicAssets.has(target)) return null;
  } else if (target.startsWith('/legacy/')) {
    target = target.slice('/legacy'.length);
    if (target === '/ui') target = '/ui/';
    if (target !== '/ui/card.html' && !publicAssets.has(target)) return null;
  }
  if (target === '/ui/card.html') target = '/ui/checkup.html';
  if (target === '/workbench/card.html') target = '/workbench/checkup.html';
  if (target === '/workbench/cases.html') target = '/ui/cases.html';
  return target === url.pathname ? null : target + url.search;
}
