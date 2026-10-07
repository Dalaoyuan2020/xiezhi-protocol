(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XiezhiPages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const pages = Object.freeze([
    { key: 'reader', file: 'index.html', label: '读者', description: '搜索、档案与证据', group: 'roles', localOnly: false, icon: 'M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4zM12 6v15' },
    { key: 'reviewer', file: 'reviewer.html', label: '审稿人', description: '示例阅读与评议草稿', group: 'roles', localOnly: true, icon: 'M5 3h10v5h4v13H5zM15 3l4 5M8 12h8M8 16h6' },
    { key: 'submitter', file: 'submitter.html', label: '投稿人', description: '资料准备与材料清单', group: 'roles', localOnly: true, icon: 'M5 7h14v14H5zM12 3v11M8 7l4-4 4 4' },
    { key: 'org', file: 'org.html', label: '机构查询', description: '行为记录与独立核查', group: 'tools', localOnly: false },
    { key: 'papers', file: 'papers.html', label: '文献检索', description: '联合检索、原文与图表', group: 'tools', localOnly: false },
    { key: 'rules', file: 'rules.html', label: '公开规则', description: '评分依据与采信边界', group: 'tools', localOnly: true },
    { key: 'data', file: 'data.html', label: '数据说明', description: '快照来源与本地存储', group: 'tools', localOnly: true },
    { key: 'profile', file: 'checkup.html', label: '档案详情', group: 'internal', localOnly: false },
    { key: 'card', file: 'card.html', label: '档案兼容入口', group: 'internal', localOnly: false }
  ].map(Object.freeze));
  const byKey = key => pages.find(page => page.key === key) || null;
  const forPath = pathname => pages.find(page => pathname.endsWith('/' + page.file)) || null;
  function isAppPath(pathname, basePath) {
    const page = forPath(pathname);
    return Boolean(page && (!basePath || pathname === basePath + page.file));
  }
  return Object.freeze({ pages, byKey, forPath, isAppPath });
});
