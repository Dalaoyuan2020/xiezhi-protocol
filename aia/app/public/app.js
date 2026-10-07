(function () {
  'use strict';
  const app = document.getElementById('app');
  const dialog = document.getElementById('dialog');
  const dialogBody = document.getElementById('dialog-body');
  const toastNode = document.getElementById('toast');
  let user = null;
  let csrfToken = null;
  let overview = null;
  let pageData = null;
  let communityData = null;
  let communityPoints = null;
  // Session-only observation: an initial ledger snapshot is a baseline, never a reward event.
  const observedLedger = new Map();
  const celebratedScholars = new Set();
  let authNext = 'community';
  const commons = window.AIACommunity;
  let authMode = 'login';
  let authBusy = false;
  let renderToken = 0;
  let walletEpoch = 0;
  let walletOperation = null;
  let toastTimer;
  let modalReturn = null;
  let proofRecord = null;
  let pendingAttestation = null;
  let userSearchTimer;
  let scholarResults = [];
  const fileSelections = { import: [], delivery: [] };
  const userLabels = new Map();
  const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const q = value => encodeURIComponent(String(value ?? ''));
  const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const pretty = value => JSON.stringify(value, null, 2);
  const shortHash = value => value ? String(value).slice(0, 12) + '…' + String(value).slice(-6) : '尚未生成';
  const labels = { requested: '待审阅', submitted: '已提交', open: '待领取', claimed: '进行中', revision_requested: '待补充', accepted: '已验收', rejected: '未验收', recommend: '建议继续', revise: '建议修订', decline: '不建议继续', supports: '支持该主张', differs: '发现差异', inconclusive: '尚不能判断', reproduction: '实验复现', 'evidence-review': '材料核对', maintenance: '研究维护', accept: '工作通过', reject: '工作未通过' };
  const icons = { home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>', idea: '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>', review: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 10 2 2 5-5M8 16h8"/>', action: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>', record: '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/><path d="m16 18 3 3 3-3"/>', profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>', plus: '<path d="M12 5v14M5 12h14"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>', arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>', key: '<circle cx="8" cy="9" r="5"/><path d="m12 13 9 8m-4-4 3-3"/>' };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.idea}</svg>`;
  const badge = (text, color = '') => `<span class="badge ${color}">${e(text)}</span>`;
  const statusBadge = status => badge(labels[status] || status || '待处理', ['accepted', 'submitted', 'recommend'].includes(status) ? 'green' : ['revision_requested', 'requested', 'open'].includes(status) ? 'amber' : status === 'rejected' ? 'red' : '');
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
  const bytes = value => n(value) >= 1048576 ? (n(value) / 1048576).toFixed(1) + ' MB' : n(value) >= 1024 ? (n(value) / 1024).toFixed(1) + ' KB' : n(value) + ' B';
  const userName = (id, name) => name || (id === user?.id ? user.displayName : userLabels.get(id)) || '参与者 ' + String(id || '').slice(0, 8);
  const errBox = () => '<div class="form-error" role="alert"></div>';
  const field = (label, name, value = '', options = {}) => `<div class="field ${options.wide ? 'wide' : ''}"><label for="${e(options.id || name)}">${label}</label>${options.textarea ? `<textarea id="${e(options.id || name)}" name="${e(name)}" ${options.required ? 'required' : ''} ${options.min ? `minlength="${options.min}"` : ''} maxlength="${options.max || 12000}" ${options.placeholder ? `placeholder="${e(options.placeholder)}"` : ''} class="${options.large ? 'large' : ''}">${e(value)}</textarea>` : `<input id="${e(options.id || name)}" name="${e(name)}" type="${options.type || 'text'}" value="${e(value)}" ${options.required ? 'required' : ''} ${options.min ? `minlength="${options.min}"` : ''} maxlength="${options.max || 240}" ${options.autocomplete ? `autocomplete="${options.autocomplete}"` : ''} ${options.pattern ? `pattern="${e(options.pattern)}"` : ''} ${options.placeholder ? `placeholder="${e(options.placeholder)}"` : ''}>`}${options.help ? `<small>${options.help}</small>` : ''}</div>`;
  const select = (label, name, values, selected = '', help = '') => `<div class="field"><label for="${e(name)}">${label}</label><select id="${e(name)}" name="${e(name)}" required>${values.map(([value, text]) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(text)}</option>`).join('')}</select>${help ? `<small>${help}</small>` : ''}</div>`;
  const heading = (eyebrow, title, description = '', actions = '') => `<div class="page-heading"><div><p class="eyebrow">${e(eyebrow)}</p><h1>${e(title)}</h1>${description ? `<p>${e(description)}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
  const empty = (title, text, action = '', mark = 'idea') => `<div class="empty"><span class="empty-mark">${icon(mark)}</span><h2>${e(title)}</h2><p>${e(text)}</p>${action}</div>`;
  const paymentNotice = '<div class="notice"><strong>当前行动不涉及现金付款。</strong>符合规则的独立验收会形成廌点贡献记录，以实际账本为准。BOT／稳定币付款尚未启用，不会锁款或承诺提现。</div>';

  function notify(message, error = false) {
    clearTimeout(toastTimer); toastNode.textContent = message; toastNode.className = 'show' + (error ? ' error' : '');
    toastTimer = setTimeout(() => { toastNode.className = ''; }, 6500);
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 90000);
    const method = options.method || (options.body !== undefined ? 'POST' : 'GET');
    try {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
      if (!response.ok) {
        let payload;
        try { payload = await response.json(); } catch (_) { payload = {}; }
        const error = new Error(payload.error || '请求失败（HTTP ' + response.status + '）');
        error.status = response.status; error.code = payload.code; throw error;
      }
      if (options.blob) return response.blob();
      return response.status === 204 ? {} : response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，尚未确认操作结果。请刷新记录后再决定是否重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function route() {
    const [path, queryString] = (location.hash.slice(1) || 'community').split('?');
    const segments = path.split('/').map(part => { try { return decodeURIComponent(part); } catch (_) { return part; } });
    return { page: segments[0] || 'community', id: segments[1] || '', params: new URLSearchParams(queryString || '') };
  }
  async function go(path) {
    if (location.hash === '#' + path) return renderRoute();
    location.hash = path;
  }
  function navKey(page) { return ['idea', 'import'].includes(page) ? 'ideas' : page === 'community-task' ? 'community' : page === 'review' ? 'reviews' : page === 'task' ? 'tasks' : page; }
  function shell() {
    const r = route();
    const navs = [['community', 'home', '知行社 · 社区'], ['overview', 'record', '我的工作概览'], ['ideas', 'idea', 'Idea · 我的研究'], ['reviews', 'review', 'Attention · 审阅'], ['tasks', 'action', 'Act · 行动'], ['points', 'record', '我的廌点'], ['agents', 'key', '我的 Agent'], ['records', 'record', '贡献与凭据'], ['profile', 'profile', '个人资料']];
    const current = navs.find(([key]) => key === navKey(r.page));
    app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#community" aria-label="知行社 · AIA Commons 社区"><span class="wordmark">aia</span><span class="brand-name"><strong>知行社</strong><br>AIA Commons</span></a><p class="nav-label">RESEARCH COMMONS</p><nav class="navigation" aria-label="工作空间导航">${navs.map(([key, glyph, label]) => `<a class="nav-link" href="#${key}"${key === navKey(r.page) ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-bottom"><div class="sidebar-note"><strong>让研究有来路</strong>以材料保存想法，<br>以审阅交换注意力，<br>以证据确认行动。</div><a class="legacy-link" href="/ui/" target="_blank" rel="noopener">公开档案工具 ↗</a></div></aside><div class="main-shell"><div class="topbar" role="region" aria-label="协作空间账号与当前位置"><div class="crumb">知行社 <strong>/ ${e(current?.[2] || '详情')}</strong></div><div class="account-tools">${user ? `<a class="commons-header-points" href="#points" aria-label="查看我的廌点账本">${commons.coin}<span data-points-balance>${communityPoints ? e(communityPoints.balance) : '—'}</span><small>廌点</small></a><a class="user-link" href="#profile"><span class="avatar">${e((user.displayName || user.username || '?').slice(0, 1))}</span><span>${e(user.displayName)}</span></a><button class="signout" data-action="logout">退出</button>` : '<a class="text-button" href="#login">登录</a><a class="button secondary small" href="#register">注册</a>'}</div></div><main id="main" class="main" tabindex="-1"><div class="loading"><span class="spinner"></span>正在读取协作记录…</div></main><footer class="footer"><span>AIA / IDEA · ATTENTION · ACT</span><span>正文保存在授权档案中 · 证据与声明分别记录</span></footer></div></div>`;
  }
  function renderAuth(message = '') {
    const register = authMode === 'register';
    document.title = (register ? '注册' : '登录') + ' · 知行社 AIA Commons';
    app.innerHTML = `<div class="auth"><section class="auth-story"><a class="auth-brand" href="#community"><span class="wordmark">aia</span><p><strong>知行社 · AIA Commons</strong><br>AIA 科研协作工作空间</p></a><div class="auth-content"><p class="eyebrow">IDEAS DESERVE A TRACE</p><h1>研究不止被阅读，<br>还要<em>经得起追问。</em></h1><p>从一份属于你的研究材料出发。找到认真审阅的人，留下可检查的行动，把每一次贡献连回证据。</p><div class="auth-flow"><div><span>01 / IDEA</span><p>保存原始材料与明确主张</p></div><div><span>02 / ATTENTION</span><p>让不同的人给出独立意见</p></div><div><span>03 / ACTION</span><p>交付实际工作，留下验收记录</p></div></div></div><div class="auth-footer"><span>IDENTITY</span><span>→</span><span>EVIDENCE</span><span>→</span><span>CONTRIBUTION</span></div></section><main id="main" class="auth-form-side"><div class="auth-box"><p class="eyebrow">${register ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</p><h2>${register ? '建立你的研究账号' : '回到你的研究空间'}</h2><p>${register ? '这是你的独立账号，之后的提交和验收都会与它关联。' : '登录后继续处理属于你的研究、审阅与行动。'}</p><form data-form="${register ? 'register' : 'login'}">${message ? `<div class="form-error" role="alert">${e(message)}</div>` : errBox()}${register ? field('显示姓名', 'displayName', '', { required: true, max: 80, autocomplete: 'name', placeholder: '让协作者认识你' }) : ''}${field('用户名', 'username', '', { required: true, min: 3, max: 40, autocomplete: 'username', placeholder: '字母、数字或 _ . -' })}${field('密码', 'password', '', { type: 'password', required: true, min: register ? 10 : undefined, max: 256, autocomplete: register ? 'new-password' : 'current-password', help: register ? '至少 10 个字符。请使用独立密码。' : '' })}<button class="button full" type="submit">${register ? '创建账号并进入 →' : '登录工作空间 →'}</button></form><div class="auth-switch">${register ? '已有账号？' : '第一次来？'}<button type="button" data-action="auth-mode" data-mode="${register ? 'login' : 'register'}">${register ? '直接登录' : '创建研究账号'}</button></div><div class="auth-note">账号与学术身份分别核对。注册后可以关联 ORCID、OpenAlex 和钱包；填写标识不等于已认证。</div><div class="auth-tools"><a href="#community">先逛逛知行社 →</a><a href="/ui/" target="_blank" rel="noopener">公开档案工具 ↗</a></div></div></main></div>`;
  }
  async function renderRoute() {
    closeDialog();
    const token = ++renderToken;
    const r = route();
    if (r.page === 'login' || r.page === 'register') {
      if (user) { await go('community'); return; }
      authMode = r.page; renderAuth(); return;
    }
    const isPublic = r.page === 'community' || r.page === 'community-task';
    if (!user && !isPublic) { authNext = location.hash.slice(1) || 'community'; renderAuth(); return; }
    shell();
    try {
      if (isPublic) {
        const [data, taskPoints] = await Promise.all([
          r.page === 'community' ? api('/api/community') : api('/api/community/tasks/' + q(r.id)),
          user && r.page === 'community-task' ? api('/api/community/points').catch(() => null) : null
        ]);
        if (token !== renderToken) return;
        if (taskPoints) communityPoints = taskPoints;
        if (r.page === 'community') {
          communityData = data;
          if (data.viewer?.points) communityPoints = data.viewer.points;
          else if (!data.viewer && user) { user = null; csrfToken = null; communityPoints = null; shell(); }
        }
        pageData = data;
        document.getElementById('main').innerHTML = r.page === 'community' ? commons.home(data, user) : commons.task(data.task, user);
        const credited = updatePointsBalance();
        if (r.page === 'community' && !credited) celebrateVerifiedScholar(data.viewer?.eligibility);
        document.title = (r.page === 'community' ? '社区' : data.task?.title || '公开记录核对') + ' · 知行社 AIA Commons';
        return;
      }
      const [nextOverview, pointsResult] = await Promise.all([api('/api/overview'), api('/api/community/points').catch(() => null)]);
      if (token !== renderToken) return;
      overview = nextOverview;
      communityPoints = pointsResult;
      updatePointsBalance();
      if (overview.user) user = overview.user;
      rememberParticipants(overview);
      let html;
      let viewData;
      if (r.page === 'overview') { viewData = overview; html = overviewPage(); }
      else if (r.page === 'points') { viewData = pointsResult || await api('/api/community/points'); communityPoints = viewData; html = commons.points(viewData); }
      else if (r.page === 'agents') { viewData = await api('/api/agents'); html = commons.agents(viewData); }
      else if (r.page === 'profile') { viewData = {}; html = profilePage(); }
      else if (r.page === 'ideas') { viewData = await api('/api/research'); html = ideasPage(viewData.research || []); }
      else if (r.page === 'import') { viewData = { previous: (overview.ideas || []).find(item => item.id === r.params.get('previous')) }; html = importPage(viewData.previous); }
      else if (r.page === 'idea' && r.id) {
        viewData = await api('/api/research/' + q(r.id));
        if (!r.params.get('tab') || r.params.get('tab') === 'report') {
          try { viewData.dualReview = await api('/api/research/' + q(r.id) + '/dual-review'); }
          catch (error) { viewData.dualReviewError = error.message; }
        }
        if (r.params.get('tab') === 'files' && viewData.research.files?.length) {
          const filePath = r.params.get('path') || viewData.research.files.find(file => file.path === 'PAPER.md')?.path || viewData.research.files[0].path;
          viewData.selectedPath = filePath;
          try { viewData.material = await api('/api/research/' + q(r.id) + '/material?path=' + q(filePath)); } catch (error) { viewData.materialError = error.message; }
        }
        if (r.params.get('tab') === 'reviews' && viewData.permissions?.canRequestReview) viewData.users = (await api('/api/users')).users || [];
        html = ideaPage(viewData, r);
      } else if (r.page === 'reviews') { viewData = await api('/api/reviews'); html = reviewsPage(viewData.reviews || []); }
      else if (r.page === 'review' && r.id) {
        const list = await api('/api/reviews');
        const review = (list.reviews || []).find(item => item.id === r.id);
        if (!review) throw new Error('没有找到你可以访问的这项审阅。');
        viewData = { review }; html = reviewPage(review);
      } else if (r.page === 'tasks') { viewData = await api('/api/tasks'); html = tasksPage(viewData.tasks || []); }
      else if (r.page === 'task' && r.id === 'new') {
        const [researchList, people] = await Promise.all([api('/api/research'), api('/api/users')]);
        viewData = { research: (researchList.research || []).filter(item => item.ownerId === user.id), users: people.users || [] };
        html = createTaskPage(viewData, r.params.get('research'));
      } else if (r.page === 'task' && r.id) {
        viewData = await api('/api/tasks/' + q(r.id)); html = taskPage(viewData);
      } else if (r.page === 'records') { viewData = await api('/api/contributions'); html = recordsPage(viewData.contributions || []); }
      else { html = empty('找不到这个页面', '请从左侧导航返回你的研究空间。', '<a class="button" href="#overview">返回概览</a>'); }
      if (token !== renderToken) return;
      pageData = viewData;
      if (r.page === 'import') fileSelections.import = [];
      if (r.page === 'task' && r.id !== 'new') fileSelections.delivery = [];
      document.getElementById('main').innerHTML = html;
      document.title = ({ points: '我的廌点', agents: '我的 Agent', overview: '工作概览', profile: '个人资料', ideas: '我的研究', idea: viewData?.research?.title, import: '导入研究', reviews: 'Attention 审阅', review: '独立审阅', tasks: 'Act 行动', task: '研究行动', records: '贡献与凭据' }[r.page] || '科研协作') + ' · 知行社 AIA Commons';
    } catch (error) {
      if (token !== renderToken) return;
      if (error.status === 401) { user = null; csrfToken = null; renderAuth('登录已过期，请重新登录。'); return; }
      document.getElementById('main').innerHTML = empty('暂时无法打开这份记录', error.message, '<button class="button" data-action="retry">重新读取</button>', 'record');
    }
  }
  function updatePointsBalance() {
    const target = document.querySelector('[data-points-balance]');
    if (target) target.textContent = communityPoints && Number.isFinite(Number(communityPoints.balance)) ? String(communityPoints.balance) : '—';
    if (!user?.id || !communityPoints || !Array.isArray(communityPoints.ledger)) return 0;
    const entries = communityPoints.ledger.filter(entry => entry?.userId === user.id && typeof entry.id === 'string' && entry.id && Number.isFinite(Number(entry.amount)));
    const seen = observedLedger.get(user.id);
    if (!seen) {
      observedLedger.set(user.id, new Set(entries.map(entry => entry.id)));
      return 0;
    }
    let credited = 0;
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (Number(entry.amount) > 0) credited += Number(entry.amount);
    }
    if (credited > 0) {
      notify('+' + credited + ' 廌点已记账，待上链。');
      try { window.Zhidian?.drop(credited, target); } catch (_) { /* The ledger remains authoritative if animation is unavailable. */ }
    }
    return credited;
  }
  function celebrateVerifiedScholar(eligibility) {
    if (!user?.id || eligibility?.identityStatus !== 'verified' || !eligibility.authorId || !Number.isFinite(Number(eligibility.score)) || Number(eligibility.score) < 700) return;
    const key = user.id + ':' + eligibility.authorId;
    if (celebratedScholars.has(key) || !window.Zhidian?.rain) return;
    celebratedScholars.add(key);
    try { window.Zhidian.rain(40, '学术分已核验 · 纯庆祝动画'); } catch (_) { /* An optional visual effect never changes points or eligibility. */ }
  }
  function researchCard(item) {
    return `<a class="item" href="#idea/${q(item.id)}"><div class="item-main"><div class="item-meta">${badge(item.ownerId === user.id ? '我的研究' : '参与协作', item.ownerId === user.id ? 'green' : '')}<span>${e(item.version || 'v1')}</span>${item.assessmentSummary ? badge('已预检', 'cyan') : ''}</div><h3>${e(item.title)}</h3><p>${e(item.abstract ? item.abstract.slice(0, 150) : '尚未填写摘要')}</p><div class="item-meta mt-11"><span>${e(userName(item.ownerId, item.ownerName))}</span><span>${item.files?.length || 0} 个文件</span><span>${date(item.createdAt)}</span></div></div><span class="item-arrow" aria-hidden="true">↗</span></a>`;
  }
  function reviewCard(item) {
    return `<a class="item" href="#review/${q(item.id)}"><div class="item-main"><div class="item-meta">${statusBadge(item.status)}${badge(item.reviewerId === user.id ? '由我审阅' : '我发起的审阅')}</div><h3>${e(item.researchTitle || '研究材料审阅')}</h3><p>${e(item.focus)}</p><div class="item-meta mt-10"><span>审阅人 ${e(userName(item.reviewerId, item.reviewerName))}</span><span>${date(item.createdAt)}</span></div></div><span class="item-arrow" aria-hidden="true">↗</span></a>`;
  }
  function taskCard(item) {
    return `<a class="item" href="#task/${q(item.id)}"><div class="item-main"><div class="item-meta">${statusBadge(item.status)}${badge(labels[item.kind] || item.kind)}<span>${item.executorId === user.id ? '我来执行' : item.verifierId === user.id ? '我来核查' : '我发起的行动'}</span></div><h3>${e(item.title)}</h3><p>${e(item.researchTitle || '关联研究')} · ${e(userName(item.executorId, item.executorName))} 执行 / ${e(userName(item.verifierId, item.verifierName))} 核查</p></div><span class="item-arrow" aria-hidden="true">↗</span></a>`;
  }
  function overviewPage() {
    const hasScholarlyId = Boolean(user.profile?.orcid || user.profile?.openalexId);
    const counts = overview.counts || {};
    const mine = overview.ideas || [];
    const pending = (overview.reviews || []).filter(item => item.status === 'requested' && item.reviewerId === user.id);
    const activeTasks = (overview.tasks || []).filter(item => !['accepted', 'rejected'].includes(item.status));
    return heading('YOUR RESEARCH COMMONS', user.displayName + '，从证据开始', '属于你的材料、需要你回应的审阅，以及正在推进的研究行动。', '<a class="button" href="#import">' + icon('plus') + '导入研究</a>') + `<div class="stats">${[['ideas', '研究版本', counts.ideas], ['reviews', '待处理审阅', counts.reviewsPending], ['tasks', '进行中行动', counts.tasksOpen], ['records', '已验收贡献', counts.contributions]].map(([path, title, count]) => `<div class="stat"><span>${title}</span><strong>${n(count)}</strong><i>↗</i><a href="#${path}" aria-label="查看${title}"></a></div>`).join('')}</div>${!hasScholarlyId ? profileWelcome() : !mine.length ? `<section class="welcome"><div class="welcome-copy"><p class="eyebrow">BEGIN WITH ONE IDEA</p><h2>把第一份研究带进来。</h2><p>上传原件，形成可追溯的材料版本。预检之后，邀请另一位研究者审阅，或定义一项可以验收的行动。</p><a class="button" href="#import">导入我的研究 →</a></div><div class="flow"><div class="flow-step"><b>01</b><div><strong>归档与预检</strong><small>PDF / Markdown / ARA</small></div></div><div class="flow-step"><b>02</b><div><strong>邀请独立审阅</strong><small>明确问题，留下依据</small></div></div><div class="flow-step"><b>03</b><div><strong>交付与验收</strong><small>实际文件，对应贡献</small></div></div></div></section>` : ''}<div class="split"><div class="stack"><section><div class="section-heading"><h2>最近的研究</h2><a class="text-button" href="#ideas">查看全部 ↗</a></div><div class="item-list">${mine.length ? mine.slice(0, 5).map(researchCard).join('') : '<div class="panel"><p>尚无研究材料。你的上传会保存在当前账号下，只有获授权的协作者可以访问。</p></div>'}</div></section>${activeTasks.length ? `<section><div class="section-heading"><h2>正在推进的行动</h2><a class="text-button" href="#tasks">查看全部 ↗</a></div><div class="item-list">${activeTasks.slice(0, 3).map(taskCard).join('')}</div></section>` : ''}</div><div class="stack"><section class="panel"><div class="section-heading"><h3>需要你回应</h3>${badge(pending.length + ' 项')}</div>${pending.length ? `<div class="item-list">${pending.slice(0, 3).map(reviewCard).join('')}</div>` : '<p>当前没有待你提交的审阅。收到指定给你的请求后，会出现在这里。</p>'}</section><section class="panel"><p class="eyebrow">YOUR IDENTITY</p><h3>让合作从认识你开始</h3><p>补充研究单位与简介，查询并关联自己的公开学术档案。</p><div class="form-actions spaced"><a class="button secondary" href="#profile">完善个人资料 ↗</a></div></section></div></div>`;
  }
  function profileWelcome() {
    return `<section class="welcome"><div class="welcome-copy"><p class="eyebrow">BEGIN WITH YOUR IDENTITY</p><h2>先把你，与自己的学术档案连起来。</h2><p>查找并核对公开档案，保存你的学术标识。需要时，用已关联的钱包登记档案声明。资料关联与声明存证不代替 ORCID 身份认证。</p><a class="button" href="#profile">关联我的研究身份 →</a><p class="hint spaced">研究材料随时可以导入，不需要先连接钱包或等待链上确认。</p></div><div class="flow"><div class="flow-step"><b>01</b><div><strong>找到本人档案</strong><small>核对姓名、单位与方向</small></div></div><div class="flow-step"><b>02</b><div><strong>保存学术标识</strong><small>明确记录为本人声明</small></div></div><div class="flow-step"><b>03</b><div><strong>按需登记声明</strong><small>钱包签名 / 可追查存证</small></div></div></div></section>`;
  }
  function ideasPage(ideas) {
    return heading('IDEA / RESEARCH LIBRARY', '我的研究', '原件、主张和证据保存在同一个版本里。只有你与已授权的参与者可以访问。', '<a class="button" href="#import">' + icon('plus') + '导入研究</a>') + (ideas.length ? `<div class="item-list">${ideas.map(researchCard).join('')}</div>` : empty('第一份 Idea，从原件开始', '支持 PDF、Markdown、纯文本及 ARA 目录。导入后可以运行材料预检，再邀请协作者。', '<a class="button" href="#import">导入第一份研究 →</a>'));
  }
  function protocolIdentity() {
    return '<section class="panel protocol-panel" aria-label="资料与存证协议说明"><div class="protocol-brand"><img src="/brand/seal.png" width="64" height="64" alt="灋廌覈鑒协议标志"><div><p class="eyebrow">XIEZHI / 资料与存证协议</p><h3>灋廌覈鑒</h3><p class="protocol-reading">读作「法廌核鉴」</p></div></div><p>知行社承载 AIA 科研协作；灋廌覈鑒是资料与存证的协议标识。身份声明、材料归档与工作验收分别留下凭据。</p><p class="hint">这枚标志用于介绍协议，不表示当前账号已认证或任何记录已通过验收。实际状态以各项凭据为准。</p></section>';
  }
  function profilePage() {
    const profile = user.profile || {};
    return heading('IDENTITY / YOUR PROFILE', '你的研究身份', '登录账号、公开学术标识与钱包控制权分别记录。所有关联都有明确的核验状态。') + `<div class="split"><div class="stack"><section class="panel"><div class="account-summary"><span class="avatar">${e(user.displayName.slice(0, 1))}</span><div><h2>${e(user.displayName)}</h2><p>@${e(user.username)} · 注册于 ${date(user.createdAt)}</p></div></div><form data-form="profile">${errBox()}<div class="form-grid">${field('显示姓名', 'displayName', user.displayName, { required: true, max: 80 })}${field('研究单位', 'institution', profile.institution || '', { max: 240 })}${field('研究简介', 'bio', profile.bio || '', { textarea: true, wide: true, max: 2000, placeholder: '研究方向、擅长的方法，以及希望参与的协作' })}${field('ORCID', 'orcid', profile.orcid || '', { max: 100, help: '手填或从公开数据关联，均先标为用户声明。' })}${field('OpenAlex 作者 ID', 'openalexId', profile.openalexId || '', { max: 100, placeholder: 'A5126602136' })}</div><div class="notice">学术标识当前为<strong>用户关联声明</strong>，尚未完成 ORCID 授权与论文归属核验。</div><div class="form-actions spaced"><button class="button" type="submit">保存个人资料</button></div></form></section><section class="panel"><p class="eyebrow">OPENALEX / PUBLIC RECORDS</p><h2>找到自己的公开档案</h2><p>按姓名或 ORCID 查询，先核对单位和方向，再关联至当前账号。</p><form data-form="scholar-search" class="spaced">${errBox()}<div class="field"><label for="scholar-query">姓名或 ORCID</label><input id="scholar-query" name="query" required maxlength="200" placeholder="例如 Zhiyuan Lyu 或 ORCID"></div><button class="button secondary" type="submit">查询公开档案 ↗</button></form><div id="scholar-results" class="spaced" aria-live="polite"></div></section></div><div class="stack">${protocolIdentity()}<section class="panel"><p class="eyebrow">WALLET / PROOF OF CONTROL</p><h3>关联你的钱包</h3><p>签名用于证明你控制该地址，和学术身份核验是不同的步骤。关联钱包本身不发起交易。</p>${profile.walletVerified && profile.walletAddress ? `${badge('地址控制权已核验', 'green')}<div class="wallet-address">${e(profile.walletAddress)}</div>` : '<div class="notice spaced">还没有经过签名核验的钱包。</div>'}<div class="form-actions spaced"><button class="button secondary" data-action="link-wallet">${profile.walletVerified ? '重新关联钱包' : '连接钱包并签名'}</button><button class="button secondary" data-action="attest" data-type="profile" data-record="${e(user.id)}"${profile.walletVerified && (profile.orcid || profile.openalexId) ? '' : ' disabled'}>登记档案声明 ↗</button></div><p class="hint spaced">保存 ORCID 或 OpenAlex 标识并核验钱包后，可以登记档案声明。用户声明存证不等于 ORCID 认证或论文归属已核实。</p></section><section class="panel"><p class="eyebrow">RECORDS STAY WITH YOU</p><h3>真实贡献，回到同一份档案</h3><p>你提交的审阅、完成的交付和独立验收会保留原记录。材料不足不等于不诚信，公开引用数也不自动授予专家资格。</p><div class="form-actions spaced"><a class="button secondary" href="#records">查看贡献与凭据 ↗</a></div></section></div></div>`;
  }
  function uploadBox(kind) {
    return `<div class="upload">${icon('upload')}<h3>${kind === 'import' ? '保留原件，也保留目录结构' : '上传可供核查的实际交付'}</h3><p>${kind === 'import' ? '一份论文或完整 ARA 目录；最多 100 个文件，单文件 12 MB，总计 20 MB。' : '日志、原始输出、环境文件与分析。上传文件只归档，不在平台自动执行。'}</p><div class="actions"><button class="button secondary" type="button" data-action="choose-files" data-target="${kind}-files">选择文件</button><button class="button secondary" type="button" data-action="choose-files" data-target="${kind}-directory">选择目录</button><input class="sr-only" id="${kind}-files" type="file" multiple data-files="${kind}"><input class="sr-only" id="${kind}-directory" type="file" webkitdirectory directory multiple data-files="${kind}"></div></div><div id="${kind}-selection" class="file-selection" aria-live="polite"><p class="hint">尚未选择文件。</p></div>`;
  }
  function importPage(previous) {
    return `<a class="back-link" href="${previous ? '#idea/' + q(previous.id) : '#ideas'}">← 返回${previous ? '原研究版本' : '我的研究'}</a>` + heading('IDEA / MATERIAL INTAKE', previous ? '保存一份新的研究版本' : '把研究材料带进来', previous ? '新版本保留原版本引用。已有审阅和行动仍指向当时的原件，不会被覆盖。' : '上传原始材料，保存明确主张，为后续审阅与行动建立可以追查的依据。') + `<div class="split"><section class="panel"><form data-form="import">${errBox()}<input type="hidden" name="previousVersionId" value="${e(previous?.id || '')}">${field('研究标题 <span>可选，留空从文件识别</span>', 'title', previous?.title || '', { max: 240 })}<div class="segmented" aria-label="材料输入方式"><button type="button" data-action="import-mode" data-mode="files" aria-pressed="true">上传文件 / 目录</button><button type="button" data-action="import-mode" data-mode="text" aria-pressed="false">粘贴文字</button></div><input name="importMode" type="hidden" value="files"><div id="import-files-pane">${uploadBox('import')}</div><div id="import-text-pane" hidden>${field('研究正文', 'text', '', { textarea: true, large: true, max: 2000000, placeholder: '粘贴正文、方法、结果和局限，保存为 paper.md' })}</div>${field('摘要', 'abstract', previous?.abstract || '', { textarea: true, max: 3000, placeholder: '研究试图解决什么问题？' })}${field('需要核查的明确主张 <span>可选</span>', 'claim', '', { textarea: true, max: 10000, placeholder: '例如：在指定数据、环境与评价方法下，方法 A 达到什么结果。' })}<div class="form-actions"><button class="button" type="submit">保存原件并进入研究 →</button><a class="button secondary" href="#ideas">返回</a></div></form></section><div class="stack"><section class="panel"><p class="eyebrow">ONE VERSION / THREE KINDS OF WORK</p><h3>下一步，按材料实际情况推进</h3><div class="check-list"><div class="check-row"><span>01</span><div><strong>材料预检</strong><p>查看主张、代码、环境与证据引用是否齐备；问题定位到具体文件。</p></div></div><div class="check-row"><span>02</span><div><strong>Attention · 独立审阅</strong><p>指定另一位已注册研究者，就创新点、方法和局限给出意见。</p></div></div><div class="check-row"><span>03</span><div><strong>Action · 交付与验收</strong><p>约定执行人、核查人和标准，用实际交付形成贡献记录。</p></div></div></div></section><div class="notice">材料默认只对所属账号和获授权参与者开放。预检是本地材料规则检查，不签发 ARA Seal，也不直接判定科研结论。</div></div></div>`;
  }
  function ideaPage(detail, r) {
    const research = detail.research;
    const tab = r.params.get('tab') || 'report';
    const permissions = detail.permissions || {};
    const tabs = [['report', '材料预检'], ['files', '原件与证据'], ['reviews', 'Attention 审阅'], ['actions', 'Action 行动'], ['history', '版本与记录']];
    const base = '#idea/' + q(research.id);
    const head = `<a class="back-link" href="#ideas">← 我的研究</a><section class="research-lead"><div class="page-heading"><div><p class="eyebrow">IDEA / ${e(research.version || 'VERSION 1')}</p><h1>${e(research.title)}</h1></div><button type="button" class="seal" data-action="research-proof" aria-label="查看材料归档依据"><span>材料归档</span><small>ARCHIVED</small></button></div>${research.abstract ? `<p class="abstract">${e(research.abstract)}</p>` : ''}<div class="item-meta"><span>归属 ${e(userName(research.ownerId, research.ownerName))}</span><span>${research.files?.length || 0} 个文件</span><span>${date(research.createdAt)}</span>${badge(research.ownerId === user.id ? '所属账号' : '获授权参与者')}</div><div class="actions spaced"><span class="hash-inline" title="${e(research.rootHash)}">SHA256 / ${e(shortHash(research.rootHash))}</span>${research.ownerId === user.id ? `<a class="button secondary small" href="#import?previous=${q(research.id)}">导入修订版本</a>` : ''}<button class="button secondary small" data-action="attest" data-type="research" data-record="${e(research.id)}"${research.ownerId !== user.id ? ' disabled' : ''}>钱包存证 ↗</button></div></section><nav class="tabs" aria-label="研究内容">${tabs.map(([key, label]) => `<a class="tab" href="${base}?tab=${key}"${tab === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
    if (tab === 'files') return head + filesPage(detail, r);
    if (tab === 'reviews') return head + `<div class="split"><section><div class="section-heading"><h2>这份研究的独立意见</h2>${badge((detail.reviews || []).length + ' 项')}</div>${detail.reviews?.length ? `<div class="item-list">${detail.reviews.map(reviewCard).join('')}</div>` : empty('还没有审阅请求', '作者可以指定另一位已注册账号，围绕当前材料版本给出独立意见。', '', 'review')}</section><section class="panel">${permissions.canRequestReview ? `<h2>邀请独立审阅</h2><p>请求发出后，该账号获得此研究版本的材料访问权限。</p><form data-form="review-request" data-research="${e(research.id)}" class="spaced">${errBox()}${userPicker('指定审阅人', 'reviewerId', detail.users || [])}${field('重点希望核查什么', 'focus', '', { textarea: true, required: true, min: 10, max: 5000, placeholder: '说明创新点、相关工作或希望获得意见的具体问题。' })}<button class="button" type="submit">发送审阅请求</button></form>` : '<h2>审阅与材料检查分开</h2><p>预检回答材料能否被检查；Attention 记录研究者对创新点、方法、证据和局限的独立意见。</p>'}</section></div>`;
    if (tab === 'actions') return head + `<div class="section-heading"><h2>从主张到可验收的工作</h2>${permissions.canCreateTask ? `<a class="button" href="#task/new?research=${q(research.id)}">定义一项行动 →</a>` : ''}</div>${detail.tasks?.length ? `<div class="item-list">${detail.tasks.map(taskCard).join('')}</div>` : empty('还没有研究行动', '明确要检查的主张和验收标准，指定执行人与另一位独立核查者。', permissions.canCreateTask ? `<a class="button secondary" href="#task/new?research=${q(research.id)}">创建研究行动</a>` : '', 'action')}`;
    if (tab === 'history') return head + `<div class="split"><section class="panel"><h2>材料版本</h2><dl class="terms"><div><dt>研究版本</dt><dd>${e(research.version)}</dd></div><div><dt>归档时间 · 北京时间</dt><dd>${date(research.createdAt)}</dd></div><div><dt>原始材料 SHA256</dt><dd class="mono">${e(research.rootHash)}</dd></div><div><dt>上一版本</dt><dd>${research.previousVersionId ? `<a class="text-button" href="#idea/${q(research.previousVersionId)}">查看上一版本 ↗</a>` : '这是本研究的首个归档版本。'}</dd></div></dl></section><section class="panel"><h2>研究记录</h2>${detail.events?.length ? `<ol class="timeline">${detail.events.map(event => `<li><strong>${e(event.title || event.kind || event.type || '研究活动')}</strong><p>${e(event.detail || event.note || '')}</p><time>${date(event.createdAt || event.time)}</time></li>`).join('')}</ol>` : '<p>材料已归档。后续的预检、审阅与行动会保留各自记录。</p>'}</section></div>`;
    return head + commons.dual(detail, research.ownerId === user.id) + reportPage(detail);
  }
  function reportPage(detail) {
    const report = detail.assessment;
    const research = detail.research;
    const assessButton = detail.permissions?.canAssess ? `<button class="button" data-action="assess" data-research="${e(research.id)}">${report ? '重新运行预检' : '运行材料预检'}</button>` : '';
    if (!report) return empty('先看材料能否被检查', '预检会检查主张、证据路径、代码、环境与结果材料，将缺失和冲突定位到具体文件。', assessButton, 'review') + '<div class="notice spaced">检查原件与规则，不调用外部大模型，不执行上传代码。检查通过不等于科研结论成立。</div>';
    const score = report.score || {};
    const findings = [...(report.findings || [])].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.severity] ?? 3));
    return `<section class="report-head"><div><p class="eyebrow">MATERIAL READINESS / 材料可检查度</p><div class="report-score">${e(score.value ?? '—')}<small>/ ${e(score.max || 100)}</small></div><p>${e(report.summary || '基于当前材料版本生成的规则检查报告。')}</p><p>检查于 ${date(report.createdAt)} · 不评价人品或科研真假</p></div><div class="stack">${assessButton}<button class="button secondary" data-action="download-report" data-research="${e(research.id)}">导出报告 JSON ↓</button></div></section><div class="split"><section><div class="section-heading"><h2>需要关注的材料问题</h2>${badge(findings.length + ' 项')}</div><div class="stack">${findings.length ? findings.map(item => `<article class="finding ${e(item.severity)}">${badge(({ high: '重点核查', medium: '建议补充', low: '材料提示' })[item.severity] || '材料提示', item.severity === 'high' ? 'red' : item.severity === 'medium' ? 'amber' : '')}<h3>${e(item.title)}</h3><p>${e(item.detail)}</p>${paths(item.paths, research.id)}${item.suggestedTask ? `<p class="hint spaced">下一步：${e(item.suggestedTask)}</p>` : ''}</article>`).join('') : '<div class="panel"><p>本轮规则没有发现待关注项。这仅表示当前检查范围内的材料条件满足，不代表研究结论已被证实。</p></div>'}</div>${detail.permissions?.canCreateTask ? `<div class="form-actions spaced"><a class="button secondary" href="#task/new?research=${q(research.id)}">把具体问题交给独立核查 →</a></div>` : ''}</section><div class="stack"><section class="panel"><h2>检查依据</h2><div class="check-list">${(report.checks || []).map(check => `<div class="check-row ${e(check.status)}"><span>${check.status === 'pass' ? '✓' : check.status === 'fail' ? '×' : '!'}</span><div><strong>${e(check.label)}</strong><p>${e(check.detail)}</p>${paths(check.paths, research.id)}</div></div>`).join('')}</div></section>${report.claims?.length ? `<section class="panel"><h2>明确主张</h2>${report.claims.map(claim => `<div class="review-section"><h3>${e(claim.id)} · ${e(claim.title || '主张')}</h3><p>${e(claim.statement)}</p>${paths(claim.resolvedEvidence || claim.evidence, research.id)}</div>`).join('')}</section>` : ''}<div class="notice">${(report.limitations || ['报告只检查结构与材料一致性，不替代专家审阅和独立复现。']).map(e).join('<br>')}</div></div></div>`;
  }
  function paths(values, id) {
    if (!Array.isArray(values) || !values.length) return '';
    return `<div class="path-links">${values.map(value => { const path = typeof value === 'string' ? value : value.path; return path ? `<a class="path-link" href="#idea/${q(id)}?tab=files&path=${q(path)}">${e(path)} ↗</a>` : ''; }).join('')}</div>`;
  }
  function safeMarkdown(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let html = '', fenced = false, list = false, code = [];
    function closeList() { if (list) { html += '</ul>'; list = false; } }
    function inline(value) { return e(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }
    for (const line of lines) {
      if (/^\s*```/.test(line)) { closeList(); if (fenced) { html += '<pre>' + e(code.join('\n')) + '</pre>'; code = []; } fenced = !fenced; continue; }
      if (fenced) { code.push(line); continue; }
      const title = /^(#{1,4})\s+(.+)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (title) { closeList(); html += `<h${title[1].length}>${inline(title[2])}</h${title[1].length}>`; }
      else if (bullet) { if (!list) { html += '<ul>'; list = true; } html += '<li>' + inline(bullet[1]) + '</li>'; }
      else { closeList(); if (line.trim()) html += '<p>' + inline(line) + '</p>'; }
    }
    closeList(); if (fenced) html += '<pre>' + e(code.join('\n')) + '</pre>';
    return html;
  }
  function filesPage(detail, r) {
    const research = detail.research;
    const files = research.files || [];
    if (!files.length) return empty('尚无可查看的文件', '该记录没有可读取的材料清单。');
    const file = files.find(item => item.path === detail.selectedPath);
    const material = detail.material;
    const base = '#idea/' + q(research.id) + '?tab=files';
    return `<div class="file-layout"><aside class="file-tree"><h3>归档原件 · ${files.length} 个文件</h3>${files.map(item => `<a class="file-link" href="${base}&path=${q(item.path)}"${item.path === detail.selectedPath ? ' aria-current="page"' : ''}>${e(item.path)}</a>`).join('')}</aside><section class="file-view"><header class="file-head"><div><strong>${e(detail.selectedPath)}</strong><p class="file-meta">${bytes(file?.bytes)} · SHA256 ${e(shortHash(file?.sha256))}</p></div><div class="actions">${material?.text !== undefined ? `<a class="text-button" href="${base}&path=${q(detail.selectedPath)}&view=${r.params.get('view') === 'source' ? 'read' : 'source'}">${r.params.get('view') === 'source' ? '阅读视图' : '查看原文'}</a>` : ''}${file ? `<button class="button secondary small" data-action="download-material" data-research="${e(research.id)}" data-path="${e(file.path)}">下载原件 ↓</button>` : ''}</div></header><div class="file-content">${detail.materialError ? `<div class="notice amber">${e(detail.materialError)}</div>` : material?.binary ? `<div class="empty compact"><h3>保留原始文件</h3><p>该文件为 ${e(material.mimeType || '二进制材料')}，请下载原件后查看。PDF 提取文本会作为独立文件出现在目录中。</p></div>` : material?.text !== undefined ? /\.md$/i.test(detail.selectedPath) && r.params.get('view') !== 'source' ? `<article class="document">${safeMarkdown(material.text)}</article>` : `<pre>${e(material.text)}</pre>` : '<p class="hint">没有可显示的文本。</p>'}</div></section></div>`;
  }
  function userPicker(label, name, users) {
    users.forEach(item => userLabels.set(item.id, item.displayName));
    const people = users.filter(item => item.id !== user.id);
    return `<div class="field"><label for="${e(name)}">${e(label)}</label><div class="user-picker"><input type="search" placeholder="按用户名或姓名查找已注册账号" data-user-search="${e(name)}" aria-label="搜索${e(label)}" maxlength="100"><select id="${e(name)}" name="${e(name)}" required><option value="">请选择独立协作者</option>${people.map(item => `<option value="${e(item.id)}">${e(item.displayName)} · @${e(item.username)}</option>`).join('')}</select></div><small data-user-hint="${e(name)}">${people.length ? '只能选择其他真实账号；没有角色切换。' : '还没有找到其他账号。协作者需先注册，再按用户名搜索。'}</small></div>`;
  }
  function reviewsPage(reviews) {
    return heading('ATTENTION / INDEPENDENT REVIEW', '让注意力留下依据', '对创新点和研究内容给出可追查的独立意见。材料预检不会代替审阅人的判断。') + (reviews.length ? `<div class="item-list">${reviews.map(reviewCard).join('')}</div>` : empty('还没有参与的审阅', '作者可以从自己的研究详情中发起请求。指定给你的审阅会出现在这里。', '<a class="button secondary" href="#ideas">前往我的研究 →</a>', 'review'));
  }
  function reviewReport(report) {
    return `<div class="actions mb-20">${statusBadge(report.verdict)}${badge(report.conflictOfInterest ? '已声明利益冲突' : '已声明无利益冲突', report.conflictOfInterest ? 'amber' : '')}</div>${[['originality', '创新性与相关工作'], ['methodology', '方法与设计'], ['evidence', '证据与可检查性'], ['limitations', '局限与改进建议']].map(([key, label]) => `<section class="review-section"><h3>${label}</h3><p class="report-text">${e(report[key])}</p></section>`).join('')}`;
  }
  function reviewPage(review) {
    const assigned = review.reviewerId === user.id;
    return `<a class="back-link" href="#reviews">← Attention 审阅</a>` + heading('ATTENTION / REVIEW REQUEST', review.researchTitle || '独立审阅', assigned ? '这份审阅指定给你的账号。你的提交将保留身份、版本和具体意见。' : '等待指定审阅者给出意见；作者不能代替他人提交审阅。', `<a class="button secondary" href="#idea/${q(review.researchId)}?tab=files">打开原件与证据 ↗</a>`) + `<div class="split"><section class="panel">${review.status === 'submitted' && review.report ? `<div class="section-heading"><h2>已提交的审阅</h2><button class="seal" data-action="review-proof" aria-label="查看审阅提交依据"><span>审阅提交</span><small>REVIEWED</small></button></div>${reviewReport(review.report)}${assigned ? `<div class="form-actions spaced"><button class="button secondary" data-action="attest" data-type="review" data-record="${e(review.id)}">为这份审阅存证 ↗</button></div>` : ''}` : assigned ? `<h2>提交你的独立意见</h2><form data-form="review-submit" data-review="${e(review.id)}">${errBox()}${field('创新性与相关工作', 'originality', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '指出明确创新点，并说明与哪些已有工作相比；有来源时写出链接或标识。' })}${field('方法与设计', 'methodology', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '研究设计、假设、实验条件与评价方法是否能回答问题？' })}${field('证据与可检查性', 'evidence', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '对应哪些文件或结果，哪些推断尚缺证据？' })}${field('局限与改进建议', 'limitations', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '说明局限、适用边界和具体改进要求。' })}${select('审阅建议', 'verdict', [['revise', '建议修订后继续'], ['recommend', '建议继续推进'], ['decline', '不建议继续推进']], 'revise')}<label class="check-label"><input type="checkbox" name="conflictOfInterest"><span>我与作者、机构或该研究存在需要披露的利益冲突。此声明将随审阅保存；存在冲突时应先与发起人说明并回避不适当的评审。</span></label><div class="form-actions"><button class="button" type="submit">提交审阅并保留依据</button></div></form>` : empty('等待独立审阅', '只有预先指定的审阅人可以在自己的登录会话中提交意见。', '', 'review')}</section><div class="stack"><section class="panel"><h2>本次审阅范围</h2><dl class="terms"><div><dt>重点问题</dt><dd>${e(review.focus)}</dd></div><div><dt>审阅人</dt><dd>${e(userName(review.reviewerId, review.reviewerName))}</dd></div><div><dt>进度</dt><dd>${statusBadge(review.status)}</dd></div><div><dt>请求时间</dt><dd>${date(review.createdAt)}</dd></div>${review.submittedAt ? `<div><dt>提交时间</dt><dd>${date(review.submittedAt)}</dd></div>` : ''}<div><dt>锁定材料 SHA256</dt><dd class="mono">${e(review.researchHash)}</dd></div></dl></section><div class="notice">审阅记录是研究者的独立意见，不是平台对论文真实性的认证。科研结论仍需材料和实际核查支持。</div></div></div>`;
  }
  function tasksPage(tasks) {
    return heading('ACTION / CHECKABLE WORK', '让行动留下交付', '明确版本与条件，提交真实材料，由另一位参与者独立验收。', '<a class="button" href="#task/new">' + icon('plus') + '定义研究行动</a>') + (tasks.length ? `<div class="item-list">${tasks.map(taskCard).join('')}</div>` : empty('还没有研究行动', '从一个具体问题出发，指定执行人、核查人和可检查的交付要求。', '<a class="button" href="#task/new">定义第一项行动 →</a>', 'action'));
  }
  function createTaskPage(data, selected) {
    if (!data.research.length) return heading('ACTION / DEFINE THE WORK', '先有研究，再定义行动') + empty('需要一份属于你的研究材料', '行动必须绑定已经归档的材料版本。先上传原件，再明确验收标准。', '<a class="button" href="#import">导入研究 →</a>', 'idea');
    return `<a class="back-link" href="#tasks">← Action 行动</a>` + heading('ACTION / DEFINE THE WORK', '定义一项能被验收的行动', '发起人、执行人和核查人使用三个不同账号。创建后材料版本与验收条件会锁定。') + `<div class="split"><section class="panel"><form data-form="task-create">${errBox()}${select('关联研究版本', 'researchId', data.research.map(item => [item.id, item.title + ' · ' + (item.version || 'v1')]), selected || data.research[0].id)}${field('行动名称', 'title', '', { required: true, min: 3, max: 240, placeholder: '例如：核对 C1 主张的原始实验结果' })}${select('工作类型', 'kind', [['reproduction', '实验复现'], ['evidence-review', '材料核对'], ['maintenance', '研究维护']], 'reproduction')}${field('工作范围与交付要求', 'requirements', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '具体核查哪条主张？使用哪些代码、数据和环境？要交付哪些文件？' })}${field('事先约定的验收标准', 'acceptanceCriteria', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '运行次数、容差、文件完整性、如何独立复跑，以及失败或无法启动时的合格排查报告。' })}${userPicker('指定执行者', 'executorId', data.users)}${userPicker('指定独立核查者', 'verifierId', data.users)}${paymentNotice}<div class="form-actions spaced"><button class="button" type="submit">锁定条件并创建行动</button></div></form></section><div class="stack"><section class="panel"><h2>验收工作的完成，不押注结论</h2><p>按约定执行后得到不一致结果，也可以是合格交付。需要用证据说明差异，再判断它对原主张意味着什么。</p><div class="check-list"><div class="check-row"><span>01</span><div><strong>范围先锁定</strong><p>材料版本、执行要求、验收标准和参与人一同保存。</p></div></div><div class="check-row"><span>02</span><div><strong>交付用原件</strong><p>环境、命令、日志和原始输出实际归档，每个文件计算哈希。</p></div></div><div class="check-row"><span>03</span><div><strong>不同账号验收</strong><p>独立核查者说明自己检查了什么，再确认工作或要求补充。</p></div></div></div></section><div class="notice">这里组织真实协作，不自动运行用户上传的代码。外部实验的执行情况由提交者报告，并交由独立核查者复核。</div></div></div>`;
  }
  function taskPage(detail) {
    const task = detail.task, deliveries = detail.deliveries || [], verifications = detail.verifications || [];
    const latest = deliveries.find(item => item.id === task.latestDeliveryId) || deliveries.at(-1);
    const permissions = detail.permissions || {};
    const role = task.executorId === user.id ? '你是这项行动的执行者' : task.verifierId === user.id ? '你是预先指定的独立核查者' : '你是这项行动的发起人';
    const orderedSteps = ['open', 'claimed', 'submitted', 'accepted'];
    const stepIndex = task.status === 'revision_requested' ? 1 : task.status === 'rejected' ? 2 : orderedSteps.indexOf(task.status);
    let controls = '';
    if (permissions.canClaim) controls = `<section class="panel"><p class="eyebrow">YOUR NEXT STEP</p><h2>检查条款，再开始工作</h2><p>领取表示你接受当前研究版本与验收标准。实际交付时仍需上传材料和结果。</p><div class="form-actions spaced"><button class="button" data-action="claim-task" data-task="${e(task.id)}">接受并开始执行 →</button></div></section>`;
    else if (permissions.canDeliver) controls = `<section class="panel"><p class="eyebrow">DELIVER / SUBMIT YOUR WORK</p><h2>${task.status === 'revision_requested' ? '提交补充后的交付' : '提交实际完成的工作'}</h2><form data-form="delivery" data-task="${e(task.id)}">${errBox()}${field('执行情况与结果说明', 'summary', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '写明实际做了什么、结果如何、哪些部分仍无法核查。' })}${field('实际使用的环境', 'environment', '', { textarea: true, max: 12000, placeholder: '操作系统、依赖版本、数据版本、硬件或无法执行的原因。' })}${field('执行命令与步骤', 'commands', '', { textarea: true, max: 16000, placeholder: '可复制的命令与必要步骤；未运行的步骤请明确说明。' })}${select('你报告的研究结果', 'outcome', [['inconclusive', '目前仍不能判断'], ['supports', '结果支持该主张'], ['differs', '结果与原主张存在差异']], 'inconclusive')}${uploadBox('delivery')}<label class="check-label"><input type="checkbox" name="declared" required><span>我已如实区分实际执行、引用已有结果和未完成的部分。提交后由独立核查者判断工作是否符合约定。</span></label><button class="button" type="submit">归档交付并提交验收 →</button></form></section>`;
    else if (permissions.canVerify && latest) controls = verificationForm(task, latest);
    else controls = `<div class="notice">${task.status === 'accepted' ? '这项工作已经独立验收，贡献事实已记录。验收的是约定工作的完成情况，科研结论请结合下方核查意见理解。' : task.status === 'rejected' ? '本次工作未通过验收。原交付与核查理由保留，可以继续查看证据。' : task.status === 'submitted' ? '交付已提交，等待预先指定的独立核查者在自己的账号中验收。' : '当前阶段需要指定的参与者操作。你可以查看材料、条款与已有记录。'}</div>`;
    return `<a class="back-link" href="#tasks">← Action 行动</a>` + heading('ACTION / ' + (labels[task.kind] || task.kind), task.title, role, `<a class="button secondary" href="#idea/${q(task.researchId)}?tab=files">查看研究原件 ↗</a>`) + `<div class="actions">${statusBadge(task.status)}${badge('不涉及现金付款')}</div><div class="progress-steps">${[['条件已锁定', 0], ['执行中', 1], ['交付待核查', 2], ['工作已验收', 3]].map(([label, index]) => `<span class="${index <= stepIndex ? 'done' : ''}">${index < stepIndex ? '✓' : String(index + 1).padStart(2, '0')} ${label}</span>${index < 3 ? '<i>→</i>' : ''}`).join('')}</div><div class="split"><div class="stack">${controls}${verifications.length ? `<section class="panel"><h2>独立核查意见</h2>${[...verifications].reverse().map(item => `<article class="review-section"><div class="actions">${badge(labels[item.decision] || item.decision, item.decision === 'accept' ? 'green' : 'amber')}${badge('研究判断 · ' + (labels[item.finding] || item.finding))}</div><p class="report-text spaced">${e(item.note)}</p><p class="hint mt-15">${date(item.createdAt)} · 核对 ${item.checkedFiles?.length || 0} 份材料 · 对应交付 ${e(String(item.deliveryId).slice(0, 12))}</p></article>`).join('')}</section>` : ''}${deliveries.length ? `<section><div class="section-heading"><h2>交付原件与执行说明</h2>${badge(deliveries.length + ' 个版本')}</div><div class="stack">${[...deliveries].reverse().map((delivery, index) => deliveryCard(delivery, index === 0)).join('')}</div></section>` : ''}</div><aside class="stack"><section class="panel"><h2>已锁定的工作条件</h2><dl class="terms"><div><dt>关联研究</dt><dd><a class="text-button" href="#idea/${q(task.researchId)}">${e(task.researchTitle)}</a></dd></div><div><dt>交付要求</dt><dd>${e(task.requirements)}</dd></div><div><dt>验收标准</dt><dd>${e(task.acceptanceCriteria)}</dd></div><div><dt>执行者</dt><dd>${e(userName(task.executorId, task.executorName))}</dd></div><div><dt>独立核查者</dt><dd>${e(userName(task.verifierId, task.verifierName))}</dd></div><div><dt>材料 SHA256</dt><dd class="mono">${e(task.researchHash)}</dd></div><div><dt>条款 SHA256</dt><dd class="mono">${e(task.termsHash)}</dd></div></dl></section>${paymentNotice}${detail.contributions?.length ? `<section class="panel"><h2>已形成的贡献</h2><p>依据指定核查者对实际交付的验收生成。对应廌点以贡献账本的实际结算记录为准，当前待上链。</p><div class="form-actions spaced"><a class="button secondary" href="#records">查看贡献事实 ↗</a></div></section>` : ''}</aside></div>`;
  }
  function deliveryCard(delivery, latest) {
    return `<article class="panel"><div class="section-heading"><h3>${latest ? '最近一次交付' : '历史交付'}</h3>${badge('提交者报告', 'cyan')}</div><p class="hint mb-16">${date(delivery.createdAt)} · ${e(labels[delivery.outcome] || delivery.outcome)}</p><p class="report-text">${e(delivery.summary)}</p>${delivery.environment ? `<details class="spaced"><summary class="text-button">环境说明</summary><pre>${e(delivery.environment)}</pre></details>` : ''}${delivery.commands ? `<details class="spaced"><summary class="text-button">执行命令与步骤</summary><pre>${e(delivery.commands)}</pre></details>` : ''}<div class="delivery-files">${(delivery.files || []).map(file => `<div class="delivery-file"><div><code>${e(file.path)}</code><p class="hint">${bytes(file.bytes)} · ${e(shortHash(file.sha256))}</p></div><div class="actions"><button class="text-button" data-action="delivery-material" data-delivery="${e(delivery.id)}" data-path="${e(file.path)}">查看</button><button class="text-button" data-action="download-delivery" data-delivery="${e(delivery.id)}" data-path="${e(file.path)}">下载 ↓</button></div></div>`).join('')}</div><p class="hash-inline spaced">交付 SHA256 / ${e(delivery.rootHash)}</p></article>`;
  }
  function verificationForm(task, delivery) {
    return `<section class="panel"><p class="eyebrow">VERIFY / INDEPENDENT DECISION</p><h2>核对实际交付，再作决定</h2><p>请打开下方交付原件。验收结果与研究结论分别记录；说明你实际完成的材料检查或独立复跑。</p><form data-form="verification" data-task="${e(task.id)}" data-delivery="${e(delivery.id)}" class="spaced">${errBox()}${select('约定工作是否完成', 'decision', [['revise', '需要补充交付'], ['accept', '按约定完成，确认验收'], ['reject', '未完成约定工作，不予验收']], 'revise')}${select('对研究主张的核查判断', 'finding', [['inconclusive', '证据尚不足以判断'], ['supports', '核查结果支持该主张'], ['differs', '核查发现可说明的差异']], 'inconclusive')}<div class="field"><label>本次实际核对的文件 <span>至少一项</span></label>${(delivery.files || []).map(file => `<label class="check-label"><input type="checkbox" name="checkedFiles" value="${e(file.path)}"><span class="mono">${e(file.path)}</span></label>`).join('')}</div>${field('核查方法、依据与结论', 'note', '', { textarea: true, required: true, min: 10, max: 12000, placeholder: '写明打开和核对了哪些文件，是否实际复跑，检查步骤、发现的差异以及验收理由。' })}<label class="check-label"><input type="checkbox" required name="independent"><span>这是我独立检查后的决定。我没有将上传日志本身当作“已证明执行”，也没有把结果不一致直接当作“论文造假”。</span></label><button class="button" type="submit">保存独立核查决定</button></form></section>`;
  }
  function recordsPage(contributions) {
    const credit = record => { const entry = (communityPoints?.ledger || []).find(item => item.referenceId === record.id && item.userId === user?.id); return entry ? '<p class="spaced"><span class="commons-reward">+' + e(entry.amount) + ' 廌点</span> <a class="text-button" href="#points">链下记账 · 待上链 ↗</a></p>' : ''; };
    const tasksById = new Map((overview?.tasks || []).map(task => [task.id, task]));
    return heading('CONTRIBUTION / A TRACEABLE RECORD', '每一次贡献，都有出处', '这里只记录已经完成独立验收的工作。谁交付、谁核查、依据是哪一版材料，都可以追到原件。', '<button class="button secondary" data-action="export-account">导出我的记录 ↓</button>') + (contributions.length ? `<div class="grid-2">${contributions.map(record => `<article class="record-card"><div class="section-heading">${badge('独立验收完成', 'green')}<button class="seal" data-action="contribution-proof" data-record="${e(record.id)}" aria-label="查看贡献验收凭据"><span>工作验收</span><small>VERIFIED</small></button></div><h3>${e(record.taskTitle || tasksById.get(record.taskId)?.title || labels[record.kind] || '研究贡献')}</h3><p>贡献者 ${e(userName(record.userId, record.userName))}<br>核查者 ${e(userName(record.verifierId, record.verifierName))}<br>${date(record.createdAt)}</p><span class="hash-inline">凭据 SHA256 / ${e(record.receiptHash)}</span>${credit(record)}<div class="actions"><a class="button secondary small" href="#task/${q(record.taskId)}">查看工作与证据 ↗</a><button class="button secondary small" data-action="attest" data-type="contribution" data-record="${e(record.id)}"${record.userId !== user.id ? ' disabled' : ''}>钱包存证</button></div></article>`).join('')}</div>` : empty('还没有已验收的贡献', '领取指定给你的行动，提交实际交付，并由独立核查者验收后，这里会自动出现记录。', '<a class="button secondary" href="#tasks">查看我的行动 →</a>', 'record')) + `<section class="panel spaced"><div class="section-heading"><h2>链上声明</h2><button class="text-button" data-action="load-attestations">读取我的存证记录 ↻</button></div><p>本地归档、独立验收和链上交易分别保存。只有后端核对真实交易及事件后，才显示链上确认。</p><div id="attestations-list" class="spaced"><p class="hint">点击读取，查看当前账号准备或确认的存证。</p></div></section>`;
  }
  function rememberParticipants(data) {
    if (user?.id && user.displayName) userLabels.set(user.id, user.displayName);
    for (const item of [...(data.tasks || []), ...(data.reviews || []), ...(data.ideas || [])]) {
      for (const role of ['owner', 'executor', 'verifier', 'reviewer']) {
        if (item[role + 'Id'] && item[role + 'Name']) userLabels.set(item[role + 'Id'], item[role + 'Name']);
      }
    }
  }
  function openDialog(title, body, eyebrow = 'EVIDENCE / 可追查记录') {
    if (!dialog.open) modalReturn = document.activeElement;
    document.getElementById('dialog-title').textContent = title;
    document.getElementById('dialog-eyebrow').textContent = eyebrow;
    dialogBody.innerHTML = body;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-action="close-dialog"]').focus();
  }
  function invalidateWalletContext() {
    walletEpoch += 1;
    pendingAttestation = null;
  }
  function closeDialog() { invalidateWalletContext(); const credential = document.getElementById('agent-credential'); if (credential) { credential.value = ''; credential.textContent = ''; } if (dialog.open) dialog.close(); }
  function captureWalletContext(requireDialog = true) {
    return { epoch: walletEpoch, userId: user?.id, routeToken: renderToken, hash: location.hash, requireDialog };
  }
  function walletContextCurrent(context) {
    return Boolean(context.userId && context.userId === user?.id && context.epoch === walletEpoch && context.routeToken === renderToken && context.hash === location.hash && (!context.requireDialog || dialog.open));
  }
  function beginWalletOperation(requireDialog = true) {
    if (walletOperation) throw new Error('上一步钱包请求尚未结束，请先在钱包中完成或取消，再重新操作。');
    if (!window.ethereum?.request) throw new Error('当前浏览器没有可用的钱包。请在支持 EIP-1193 的钱包浏览器中打开本页面。');
    const operation = captureWalletContext(requireDialog);
    if (!walletContextCurrent(operation)) throw new Error('当前页面或账号已变化，请重新发起钱包操作。');
    walletOperation = operation;
    return operation;
  }
  function assertWalletOperation(operation) {
    if (walletOperation === operation && walletContextCurrent(operation)) return;
    const error = new Error('页面、弹窗或登录账号已变化，本次钱包流程已停止。');
    error.code = 'WALLET_CONTEXT_CHANGED';
    throw error;
  }
  function finishWalletOperation(operation) { if (walletOperation === operation) walletOperation = null; }
  function showProof(title, record, explanation) {
    proofRecord = record;
    openDialog(title, `<p class="hint">${e(explanation)}</p><pre>${e(pretty(record))}</pre><div class="dialog-actions"><button class="button secondary" data-action="export-proof">导出原始凭据 JSON ↓</button></div>`);
  }
  function saveBlob(blob, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function saveJSON(value, filename) { saveBlob(new Blob([pretty(value)], { type: 'application/json;charset=utf-8' }), filename); }
  function fileSelection(kind) {
    const target = document.getElementById(kind + '-selection');
    if (!target) return;
    const files = fileSelections[kind];
    target.innerHTML = files.length ? `<p class="hint">${files.length} 个文件 · ${bytes(files.reduce((sum, file) => sum + file.size, 0))}</p>${files.map((file, index) => `<div class="selected-file"><span>${e(file.webkitRelativePath || file.name)}</span><div class="actions"><small>${bytes(file.size)}</small><button type="button" data-action="remove-file" data-kind="${kind}" data-index="${index}" aria-label="移除 ${e(file.name)}">×</button></div></div>`).join('')}` : '<p class="hint">尚未选择文件。</p>';
  }
  function validateFiles(files) {
    if (files.length > 100) throw new Error('最多上传 100 个文件，请缩小本次交付范围。');
    if (files.some(file => file.size > 12 * 1024 * 1024)) throw new Error('有文件超过 12 MB，请分离过大的材料。');
    if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error('文件总量超过 20 MB，请缩小本次上传范围。');
  }
  async function encodeFiles(kind) {
    const files = fileSelections[kind]; validateFiles(files);
    return Promise.all(files.map(async file => {
      const data = new Uint8Array(await file.arrayBuffer());
      let raw = '';
      for (let offset = 0; offset < data.length; offset += 32768) raw += String.fromCharCode(...data.subarray(offset, offset + 32768));
      return { path: file.webkitRelativePath || file.name, base64: btoa(raw) };
    }));
  }
  async function perform(form, action) {
    if (form.dataset.busy) return;
    form.dataset.busy = 'true';
    const errorBox = form.querySelector('.form-error');
    if (errorBox) errorBox.textContent = '';
    const submits = [...form.querySelectorAll('[type="submit"]')];
    const original = submits.map(button => button.textContent);
    submits.forEach(button => { button.disabled = true; button.textContent = '正在保存…'; });
    try { await action(); }
    catch (error) {
      if (error.status === 401) { user = null; csrfToken = null; renderAuth('登录已过期，请重新登录后继续。'); }
      else if (errorBox) { errorBox.textContent = error.message; errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      else notify(error.message, true);
    } finally {
      delete form.dataset.busy;
      submits.forEach((button, index) => { button.disabled = false; button.textContent = original[index]; });
    }
  }
  async function submitForm(form) {
    const values = new FormData(form);
    const text = name => String(values.get(name) || '').trim();
    const type = form.dataset.form;
    if (type === 'login' || type === 'register') {
      authBusy = true;
      try {
        const result = await api('/api/auth/' + type, { body: { username: text('username'), password: String(values.get('password') || ''), ...(type === 'register' ? { displayName: text('displayName') } : {}) } });
        user = result.user; csrfToken = result.csrfToken;
        notify(type === 'register' ? '账号已建立。可以上传自己的第一份研究。' : '已登录你的研究账号。');
        if (['login', 'register'].includes(route().page)) { const next = authNext; authNext = 'community'; await go(next); }
        else await renderRoute();
      } finally { authBusy = false; }
    } else if (type === 'community-answer') {
      const context = { token: renderToken, userId: user?.id };
      const result = await api('/api/community/tasks/' + q(form.dataset.task) + '/answer', { body: { answer: text('answer'), reason: text('reason') } });
      if (context.token !== renderToken || context.userId !== user?.id) return;
      communityPoints = result.points || communityPoints;
      notify('独立判断已保存。是否获得廌点以实际结算记录为准。');
      await renderRoute();
    } else if (type === 'community-unpublish') {
      await api('/api/research/' + q(form.dataset.research) + '/publish', { body: { published: false } });
      notify('摘要已从社区撤下；已授权协作者与归档记录仍保留。'); await renderRoute();
    } else if (type === 'community-publish') {
      if (!values.has('publishConsent')) throw new Error('请先确认摘要公开与材料审阅授权。');
      await api('/api/research/' + q(form.dataset.research) + '/publish', { body: { published: true, allowReviewMaterials: true, allowReferenceTasks: values.has('referenceConsent') } });
      notify('摘要已发布；全文与附件仅向获授权的审阅参与者开放。'); await renderRoute();
    } else if (type === 'agent-create') {
      const scopes = values.getAll('scopes');
      if (!scopes.length) throw new Error('请至少选择一项需要授权的能力。');
      const context = { token: renderToken, userId: user?.id };
      const result = await api('/api/agents', { body: { name: text('name'), scopes } });
      if (context.token !== renderToken || context.userId !== user?.id) return;
      await renderRoute();
      if (context.userId !== user?.id || route().page !== 'agents') return;
      openDialog('保存这份一次性授权凭据', commons.credential(result), 'AGENT / 有限授权');
    } else if (type === 'profile') {
      const result = await api('/api/profile', { method: 'PUT', body: { displayName: text('displayName'), institution: text('institution'), bio: text('bio'), orcid: text('orcid'), openalexId: text('openalexId') } });
      user = result.user; notify('个人资料已保存。学术标识按用户声明记录。'); await renderRoute();
    } else if (type === 'scholar-search') {
      const result = await api('/api/scholars?q=' + q(text('query')));
      if (!form.isConnected) return;
      scholarResults = result.results || [];
      const target = document.getElementById('scholar-results');
      target.innerHTML = `<p class="hint">OpenAlex · ${date(result.fetchedAt)}${result.cached ? ' · 缓存查询结果' : ' · 本次查询'} · ${scholarResults.length} 个候选</p>${scholarResults.length ? `<div class="item-list spaced">${scholarResults.map((person, index) => `<article class="item"><div class="item-main"><h3>${e(person.name)}</h3><p>${e((person.institutions || []).join(' / ') || '来源未提供单位')}<br>${e((person.topics || []).join(' · ') || '来源未提供研究方向')}</p><div class="item-meta spaced"><span>${n(person.works)} 篇作品</span><span>${n(person.citedBy)} 次引用</span><span>${e(person.id)}</span></div><div class="actions spaced"><button class="button secondary small" data-action="link-scholar" data-index="${index}">将此档案填入资料</button>${safeExternal(person.sourceUrl) ? `<a class="text-button" href="${e(safeExternal(person.sourceUrl))}" target="_blank" rel="noopener noreferrer">核对来源 ↗</a>` : ''}</div></div></article>`).join('')}</div>` : '<div class="notice spaced">这次查询没有找到匹配档案。请调整姓名或 ORCID；页面不会用示例人物替代查询结果。</div>'}`;
      if (result.variants?.length > 1) target.insertAdjacentHTML('afterbegin', `<p class="hint">已检索：${e(result.variants.join(' / '))}。拼写扩展用于寻找候选，不自动合并同名档案。</p>`);
      if (result.partial) target.insertAdjacentHTML('afterbegin', `<div class="notice spaced">部分拼写查询未完成：${e((result.failedVariants || []).join(' / '))}。下面仅显示已返回的候选，可稍后重试或用 ORCID 精确查询。</div>`);
    } else if (type === 'import') {
      let files;
      if (text('importMode') === 'text') {
        if (!text('text')) throw new Error('请先粘贴研究正文。');
        files = [{ path: 'paper.md', text: text('text') }];
      } else {
        if (!fileSelections.import.length) throw new Error('请先选择论文文件或 ARA 目录。');
        files = await encodeFiles('import');
      }
      const result = await api('/api/research/import', { body: { title: text('title'), abstract: text('abstract'), claim: text('claim'), files, ...(text('previousVersionId') ? { previousVersionId: text('previousVersionId') } : {}) } });
      fileSelections.import = []; notify('原件已归档到你的账号，版本与文件哈希已保存。'); await go('idea/' + q(result.research.id));
    } else if (type === 'review-request') {
      if (!text('reviewerId') || text('reviewerId') === user.id) throw new Error('请选择另一位真实账号作为独立审阅人。');
      const result = await api('/api/research/' + q(form.dataset.research) + '/review-requests', { body: { reviewerId: text('reviewerId'), focus: text('focus') } });
      notify('审阅请求已保存，并授予指定账号查看该版本的权限。'); await go('review/' + q(result.review.id));
    } else if (type === 'review-submit') {
      await api('/api/reviews/' + q(form.dataset.review) + '/submit', { body: { originality: text('originality'), methodology: text('methodology'), evidence: text('evidence'), limitations: text('limitations'), conflictOfInterest: values.has('conflictOfInterest'), verdict: text('verdict') } });
      notify('独立审阅已提交，意见与材料版本一同保存。'); await renderRoute();
    } else if (type === 'task-create') {
      const executorId = text('executorId'), verifierId = text('verifierId');
      if (!executorId || !verifierId || new Set([user.id, executorId, verifierId]).size !== 3) throw new Error('发起人、执行者和独立核查者必须是三个不同的账号。');
      const result = await api('/api/tasks', { body: { researchId: text('researchId'), title: text('title'), kind: text('kind'), requirements: text('requirements'), acceptanceCriteria: text('acceptanceCriteria'), executorId, verifierId } });
      notify('研究行动已创建，材料与验收条件已锁定。'); await go('task/' + q(result.task.id));
    } else if (type === 'delivery') {
      if (!fileSelections.delivery.length) throw new Error('请上传至少一份实际交付文件，例如日志、结果或排查报告。');
      const files = await encodeFiles('delivery');
      await api('/api/tasks/' + q(form.dataset.task) + '/deliver', { body: { summary: text('summary'), environment: text('environment'), commands: text('commands'), outcome: text('outcome'), files } });
      fileSelections.delivery = []; notify('实际交付已归档，等待指定核查者独立验收。'); await renderRoute();
    } else if (type === 'verification') {
      const checkedFiles = values.getAll('checkedFiles').map(String);
      if (!checkedFiles.length) throw new Error('请至少选择一份你实际核对过的交付文件。');
      await api('/api/tasks/' + q(form.dataset.task) + '/verify', { body: { deliveryId: form.dataset.delivery, decision: text('decision'), finding: text('finding'), note: text('note'), checkedFiles } });
      notify(text('decision') === 'accept' ? '独立验收已保存，贡献事实已生成。' : '核查决定已保存，交付与理由可以追查。'); await renderRoute();
    } else if (type === 'attestation-prepare') {
      const context = captureWalletContext();
      const result = await api('/api/attestations/prepare', { body: { recordType: form.dataset.recordType, recordId: form.dataset.recordId, network: text('network') } });
      if (!walletContextCurrent(context) || !form.isConnected) return;
      pendingAttestation = result;
      openDialog('检查交易内容，再提交钱包', `<div class="notice amber">这将向 ${e(result.network?.label || result.network?.name)} 发送真实存证交易，可能产生 Gas 费用。链上只登记摘要，不上传研究正文。</div><dl class="terms spaced"><div><dt>网络</dt><dd>${e(result.network?.label || result.network?.name)} · Chain ID ${e(result.network?.chainId)}</dd></div><div><dt>发送账户</dt><dd class="mono">${e(result.transaction?.from)}</dd></div><div><dt>目标合约</dt><dd class="mono">${e(result.transaction?.to)}</dd></div><div><dt>证明对象</dt><dd>${e(form.dataset.recordType)} / ${e(form.dataset.recordId)}</dd></div></dl><details class="spaced"><summary class="text-button">查看待签发记录与交易数据</summary><pre>${e(pretty(result))}</pre></details><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">暂不发送</button><button class="button" data-action="send-attestation">由我的钱包发送交易 →</button></div>`, 'ONCHAIN / 由你确认的真实交易');
    } else if (type === 'attestation-confirm') {
      const context = captureWalletContext();
      const result = await api('/api/attestations/' + q(form.dataset.attestation) + '/confirm', { body: { txHash: text('txHash') } });
      if (!walletContextCurrent(context) || !form.isConnected) return;
      showProof('链上声明已核对', result.attestation, '后端已核对交易和合约事件。链上记录证明此声明的登记，不自动证明身份、研究结论或付款。');
      notify('交易与链上事件核对完成。');
    }
  }
  function safeExternal(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; }
  }
  async function showDeliveryMaterial(deliveryId, path) {
    const token = renderToken;
    const result = await api('/api/deliveries/' + q(deliveryId) + '/material?path=' + q(path));
    if (token !== renderToken) return;
    openDialog(path, `<p class="hint">交付原件 SHA256 / ${e(result.sha256 || '详见材料清单')}</p>${result.binary ? '<div class="notice">这是二进制文件，请下载原件后查看。</div>' : `<pre>${e(result.text || '')}</pre>`}<div class="dialog-actions"><button class="button secondary" data-action="download-delivery" data-delivery="${e(deliveryId)}" data-path="${e(path)}">下载此原件 ↓</button></div>`, 'DELIVERY / 实际归档的交付');
  }
  async function walletChallenge() {
    const operation = beginWalletOperation(false);
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      assertWalletOperation(operation);
      if (!accounts?.[0]) throw new Error('没有获得钱包地址。');
      const address = accounts[0];
      const challenge = await api('/api/wallet/challenge', { body: { address } });
      assertWalletOperation(operation);
      proofRecord = { kind: 'wallet-challenge', address, ...challenge };
      openDialog('核对钱包关联声明', `<p class="hint">签名用于证明当前账号控制下面的钱包地址，不是交易，也不会自动发送存证。</p><div class="wallet-address">${e(address)}</div><pre>${e(challenge.message)}</pre><p class="hint">挑战有效期至 ${date(challenge.expiresAt)}。请在钱包中核对相同内容。</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">取消</button><button class="button" data-action="wallet-sign">请求钱包签名</button></div>`, 'WALLET / 关联地址控制权');
    } finally { finishWalletOperation(operation); }
  }
  async function signWalletChallenge() {
    const challenge = proofRecord;
    if (challenge?.kind !== 'wallet-challenge') throw new Error('签名挑战已失效，请重新关联钱包。');
    const operation = beginWalletOperation();
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      assertWalletOperation(operation);
      if (!accounts?.[0] || accounts[0].toLowerCase() !== String(challenge.address).toLowerCase()) throw new Error('当前钱包账户已变化，请切回声明中的地址后再签名。');
      const messageHex = '0x' + [...new TextEncoder().encode(challenge.message)].map(value => value.toString(16).padStart(2, '0')).join('');
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [messageHex, challenge.address] });
      assertWalletOperation(operation);
      const result = await api('/api/wallet/verify', { body: { challengeId: challenge.id, signature } });
      assertWalletOperation(operation);
      user = result.user; closeDialog(); notify('钱包控制权已通过签名核验，关联到当前账号。'); await renderRoute();
    } finally { finishWalletOperation(operation); }
  }
  async function beginAttestation(type, id) {
    const context = captureWalletContext(false);
    if (!user.profile?.walletVerified) {
      openDialog('先关联经过签名核验的钱包', '<p class="hint">存证需要使用当前账号已经关联的钱包。请先在个人资料页完成地址控制权核验。</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">返回</button><a class="button" href="#profile" data-action="close-dialog">前往个人资料 →</a></div>', 'ONCHAIN / 准备存证');
      return;
    }
    const results = await Promise.allSettled([api('/api/chain/config?network=mainnet'), api('/api/chain/config?network=testnet')]);
    if (!walletContextCurrent(context)) return;
    const networks = results.map((result, index) => result.status === 'fulfilled' ? { key: index ? 'testnet' : 'mainnet', ...result.value } : { key: index ? 'testnet' : 'mainnet', label: index ? '测试网' : '主网', available: false, error: result.reason.message });
    const available = networks.filter(network => network.available);
    openDialog('为这份真实记录准备存证', `<p class="hint">只登记当前记录的摘要和声明类型。归档、审阅意见与工作验收保持各自含义，不会因为上链变成科学认证。</p><form data-form="attestation-prepare" data-record-type="${e(type)}" data-record-id="${e(id)}">${errBox()}<div class="field"><label for="network">选择网络</label><select id="network" name="network" required>${networks.map(network => `<option value="${e(network.key)}"${network.available ? '' : ' disabled'}>${e(network.label || network.name || network.key)} · ${network.available ? '部署可用' : '尚不可用'}</option>`).join('')}</select></div><div class="notice">${available.length ? '下一步先生成交易内容供你查看。只有你确认并在钱包提交后，才会发送链上交易。' : '当前没有可用的部署配置，无法准备真实交易。已有研究和协作记录不受影响。'}</div><div class="dialog-actions"><button type="submit" class="button"${available.length ? '' : ' disabled'}>查看待发送的交易 →</button></div></form>`, 'ONCHAIN / 记录摘要');
    const selectNode = document.getElementById('network'); if (available[0]) selectNode.value = available[0].key;
  }
  async function sendAttestation() {
    const prepared = pendingAttestation;
    if (!prepared?.attestation?.id || !prepared.transaction) throw new Error('交易准备记录不可用，请重新准备。');
    const operation = beginWalletOperation();
    try {
      const expectedChain = BigInt(prepared.network.chainIdHex || prepared.network.chainId);
      if (expectedChain <= 0n) throw new Error('交易准备记录中的网络标识无效，请重新准备。');
      const chainId = '0x' + expectedChain.toString(16);
      const sender = String(prepared.transaction.from).toLowerCase();
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      assertWalletOperation(operation);
      if (!accounts?.[0] || accounts[0].toLowerCase() !== sender) throw new Error('当前钱包账户与已关联的签发地址不同，请在钱包中切回正确账户。');
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
      catch (error) {
        assertWalletOperation(operation);
        if (Number(error.code) !== 4902 || !prepared.network.addEthereumChain) throw error;
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ ...prepared.network.addEthereumChain, chainId }] });
        assertWalletOperation(operation);
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
      assertWalletOperation(operation);
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
      assertWalletOperation(operation);
      if (BigInt(currentChainId) !== expectedChain) throw new Error('钱包没有切换到准备记录指定的网络，本次尚未发送交易。请核对网络后重试。');
      const currentAccounts = await window.ethereum.request({ method: 'eth_accounts' });
      assertWalletOperation(operation);
      if (!currentAccounts?.[0] || currentAccounts[0].toLowerCase() !== sender) throw new Error('切换网络后钱包账户发生变化，本次尚未发送交易。请切回签发地址后重试。');
      // Pin the transaction to the reviewed network even if the wallet changes after these checks.
      const txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ ...prepared.transaction, chainId }] });
      if (!/^0x[0-9a-f]{64}$/i.test(txHash || '')) throw new Error('钱包没有返回有效的交易哈希，请在钱包中检查本次交易。');
      const record = { id: prepared.attestation.id, txHash, network: prepared.network.key || prepared.network.network, createdAt: new Date().toISOString() };
      const cacheKey = 'aia-pending-tx:' + operation.userId + ':' + record.id;
      // A dispatched wallet request can finish after navigation. Preserve its public hash for recovery.
      try { localStorage.setItem(cacheKey, JSON.stringify(record)); } catch (_) { /* Public transaction hash recovery is optional. */ }
      if (pendingAttestation === prepared) pendingAttestation = null;
      if (!walletContextCurrent(operation)) return;
      renderPendingAttestation(record, '交易已由钱包发送，正在等待网络确认。后端核对成功前，不会显示为已存证。');
      try {
        const result = await api('/api/attestations/' + q(record.id) + '/confirm', { body: { txHash } });
        if (!walletContextCurrent(operation)) return;
        try { localStorage.removeItem(cacheKey); } catch (_) { /* Optional UI cache. */ }
        showProof('链上声明已核对', result.attestation, '后端已经核对真实交易和事件。这个记录证明声明登记，不自动证明研究结论。');
      } catch (error) { if (walletContextCurrent(operation)) renderPendingAttestation(record, error.message); }
    } finally { finishWalletOperation(operation); }
  }
  function renderPendingAttestation(record, message) {
    openDialog('交易已发送，等待核对', `<div class="notice amber">${e(message)}</div><form data-form="attestation-confirm" data-attestation="${e(record.id)}" class="spaced">${errBox()}${field('交易哈希', 'txHash', record.txHash || '', { required: true, max: 66 })}<div class="dialog-actions"><button class="button secondary" type="button" data-action="close-dialog">稍后查看</button><button class="button" type="submit">请求后端重新核对</button></div></form>`, 'ONCHAIN / 尚未确认');
  }
  async function loadAttestations() {
    const token = renderToken;
    const result = await api('/api/attestations');
    if (token !== renderToken) return;
    const records = result.attestations || [];
    const target = document.getElementById('attestations-list');
    if (!target) return;
    target.innerHTML = records.length ? `<div class="item-list">${records.map(record => `<article class="item"><div class="item-main"><div class="actions">${badge(record.status === 'confirmed' ? '链上已核对' : '尚未链上确认', record.status === 'confirmed' ? 'green' : 'amber')}${badge(record.network || '指定网络')}</div><h3>${e(record.recordType || '行为声明')}</h3><p>${date(record.createdAt)}<br><span class="mono">${e(record.txHash || '尚未记录交易哈希')}</span></p><div class="actions spaced"><button class="text-button" data-action="attestation-proof" data-record="${e(record.id)}">查看原始记录 ↗</button>${record.status !== 'confirmed' ? `<button class="text-button" data-action="retry-attestation" data-record="${e(record.id)}">提交交易哈希核对</button>` : ''}</div></div></article>`).join('')}</div>` : '<p class="hint">当前账号还没有准备或确认的链上声明。可以在自己的研究、已提交审阅或已验收贡献中发起存证。</p>';
    target._records = records;
  }
  async function clickAction(button) {
    const action = button.dataset.action;
    if (action === 'auth-mode') { if (authBusy) return; authMode = button.dataset.mode; if (['login', 'register'].includes(route().page)) await go(authMode); else renderAuth(); return; }
    if (action === 'community-act-scroll') { document.getElementById('commons-act')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'community-idea') { const item = (communityData?.ideas || []).find(item => item.id === button.dataset.research); if (item) openDialog(item.title, commons.ideaSummary(item), 'IDEA / 公开摘要'); return; }
    if (action === 'publish-research') { if (pageData?.research?.id === button.dataset.research) openDialog('确认公开范围与审阅授权', commons.publish(pageData.research), 'IDEA / 发布摘要'); return; }
    if (action === 'unpublish-research') { if (pageData?.research?.id === button.dataset.research) openDialog('撤下公开摘要', '<p>此摘要将从公开想法区和待领取审阅列表撤下。已经获授权的参与者仍可查看其协作材料，原始归档记录保留。</p><form class="spaced" data-form="community-unpublish" data-research="' + e(button.dataset.research) + '">' + errBox() + '<button class="button secondary" type="submit">确认撤下摘要</button></form>', 'IDEA / 公开范围'); return; }
    if (action === 'copy-agent-credential') { const node = document.getElementById('agent-credential'); if (node?.value) { await navigator.clipboard.writeText(node.value); notify('凭据已复制，请保存在你信任的位置。'); } return; }
    if (action === 'close-dialog') { closeDialog(); return; }
    if (action === 'retry') { await renderRoute(); return; }
    if (action === 'choose-files') { document.getElementById(button.dataset.target)?.click(); return; }
    if (action === 'remove-file') { fileSelections[button.dataset.kind].splice(Number(button.dataset.index), 1); fileSelection(button.dataset.kind); return; }
    if (action === 'import-mode') {
      const mode = button.dataset.mode;
      document.querySelector('[name="importMode"]').value = mode;
      document.getElementById('import-files-pane').hidden = mode !== 'files'; document.getElementById('import-text-pane').hidden = mode !== 'text';
      document.querySelectorAll('[data-action="import-mode"]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.mode === mode))); return;
    }
    if (action === 'research-proof') { showProof('材料已实际归档', pageData.research, '原件、目录和文件哈希由服务端保存。材料归档不等于创新性通过、官方 ARA Seal 或链上确认。'); return; }
    if (action === 'review-proof') { showProof('独立审阅的提交记录', pageData.review, '由指定审阅账号提交，绑定当时研究版本。此印章表示审阅已经提交，不代表平台认可论文结论。'); return; }
    if (action === 'contribution-proof') { const record = (pageData.contributions || []).find(item => item.id === button.dataset.record); showProof('经过独立验收的贡献事实', record, '此记录由指定独立核查者对交付的验收生成。贡献事实不等于货币、可提现余额或已确认的链上交易。'); return; }
    if (action === 'export-proof') { saveJSON(proofRecord, 'aia-record-' + (proofRecord?.id || 'proof') + '.json'); return; }
    if (action === 'link-scholar') {
      const person = scholarResults[Number(button.dataset.index)]; if (!person) return;
      const form = document.querySelector('[data-form="profile"]');
      form.elements.openalexId.value = String(person.id || '').replace(/^https:\/\/openalex\.org\//, '');
      form.elements.orcid.value = person.orcid || '';
      form.elements.openalexId.focus(); notify('已填入候选标识。请核对归属，再点击保存个人资料；这不是身份认证。'); return;
    }
    const buttonLabel = button.textContent;
    button.disabled = true;
    try {
      if (action === 'logout') { invalidateWalletContext(); await api('/api/auth/logout', { body: {} }); user = null; csrfToken = null; overview = null; pageData = null; communityData = null; communityPoints = null; authNext = 'community'; userLabels.clear(); renderToken += 1; closeDialog(); await go('community'); }
      else if (action === 'community-claim') { const result = await api('/api/community/attention/' + q(button.dataset.attention) + '/claim', { body: {} }); notify('已领取独立审阅，请核查全文与证据。'); await go('review/' + q(result.review.id)); }
      else if (action === 'dual-review') { button.textContent = '两路模型正在独立预评审…'; await api('/api/research/' + q(button.dataset.research) + '/dual-review', { body: {}, timeout: 180000 }); notify('双评审记录已保存，请查看实际返回状态和分歧。'); await renderRoute(); }
      else if (action === 'agent-revoke') { await api('/api/agents/' + q(button.dataset.agent), { method: 'DELETE', body: {} }); notify('Agent 授权已撤销。'); await renderRoute(); }
      else if (action === 'assess') { await api('/api/research/' + q(button.dataset.research) + '/assess', { body: {} }); notify('材料预检已完成，报告绑定当前归档版本。'); await renderRoute(); }
      else if (action === 'download-report') saveJSON(await api('/api/research/' + q(button.dataset.research) + '/report'), 'research-assessment.json');
      else if (action === 'download-material') saveBlob(await api('/api/research/' + q(button.dataset.research) + '/file?path=' + q(button.dataset.path), { blob: true }), button.dataset.path.split('/').at(-1));
      else if (action === 'download-delivery') saveBlob(await api('/api/deliveries/' + q(button.dataset.delivery) + '/file?path=' + q(button.dataset.path), { blob: true }), button.dataset.path.split('/').at(-1));
      else if (action === 'delivery-material') await showDeliveryMaterial(button.dataset.delivery, button.dataset.path);
      else if (action === 'claim-task') { await api('/api/tasks/' + q(button.dataset.task) + '/claim', { body: {} }); notify('已领取行动，可以按锁定条件执行并提交交付。'); await renderRoute(); }
      else if (action === 'export-account') saveJSON(await api('/api/export'), 'aia-my-research-records.json');
      else if (action === 'link-wallet') await walletChallenge();
      else if (action === 'wallet-sign') await signWalletChallenge();
      else if (action === 'attest') await beginAttestation(button.dataset.type, button.dataset.record);
      else if (action === 'send-attestation') await sendAttestation();
      else if (action === 'load-attestations') await loadAttestations();
      else if (action === 'attestation-proof' || action === 'retry-attestation') {
        const record = document.getElementById('attestations-list')?._records?.find(item => item.id === button.dataset.record);
        if (!record) throw new Error('请先刷新存证记录。');
        if (action === 'attestation-proof') showProof('存证原始记录', record, '链上确认以服务端交易核对结果为准。请同时查看网络、发送者和绑定的内容摘要。');
        else {
          let cached;
          try { cached = JSON.parse(localStorage.getItem('aia-pending-tx:' + user.id + ':' + record.id)); } catch (_) { cached = null; }
          renderPendingAttestation({ ...record, txHash: record.txHash || cached?.txHash || '' }, '输入钱包返回的真实交易哈希，由后端重新核对。未确认前不重复发送相同交易。');
        }
      }
    } finally { if (button.isConnected) { button.disabled = false; if (action === 'dual-review') button.textContent = buttonLabel; } }
  }
  document.addEventListener('submit', event => {
    const form = event.target.closest('form[data-form]'); if (!form) return;
    event.preventDefault(); perform(form, () => submitForm(form));
  });
  document.addEventListener('click', event => {
    const authLink = event.target.closest('a[href="#login"],a[href="#register"]');
    if (authLink && !user) authNext = route().page === 'community-task' ? location.hash.slice(1) : 'community';
    const skip = event.target.closest('.skip');
    if (skip) { event.preventDefault(); document.getElementById('main')?.focus(); return; }
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    if (button.tagName === 'A' && button.getAttribute('href')?.startsWith('#')) { if (button.dataset.action === 'close-dialog') closeDialog(); return; }
    event.preventDefault(); clickAction(button).catch(error => { if (error.code !== 'WALLET_CONTEXT_CHANGED') notify(error.code === 4001 || error.code === 'ACTION_REJECTED' ? '你已取消钱包操作，未确认任何交易。' : error.message, true); });
  });
  document.addEventListener('change', event => {
    const input = event.target;
    if (!input.matches('[data-files]')) return;
    try {
      const files = [...input.files]; validateFiles(files); fileSelections[input.dataset.files] = files; fileSelection(input.dataset.files);
    } catch (error) { notify(error.message, true); }
    input.value = '';
  });
  document.addEventListener('input', event => {
    const input = event.target;
    if (!input.matches('[data-user-search]')) return;
    clearTimeout(userSearchTimer);
    const target = input.dataset.userSearch;
    const search = input.value.trim();
    userSearchTimer = setTimeout(async () => {
      try {
        const result = await api('/api/users?q=' + q(search));
        if (!input.isConnected || input.value.trim() !== search) return;
        const selectNode = document.getElementById(target); if (!selectNode) return;
        const people = (result.users || []).filter(item => item.id !== user.id);
        people.forEach(item => userLabels.set(item.id, item.displayName));
        selectNode.innerHTML = '<option value="">请选择独立协作者</option>' + people.map(item => `<option value="${e(item.id)}">${e(item.displayName)} · @${e(item.username)}</option>`).join('');
        const hint = document.querySelector('[data-user-hint="' + target + '"]');
        if (hint) hint.textContent = people.length ? '找到 ' + people.length + ' 个账号。请选择具体的协作者。' : '没有找到匹配账号，请核对用户名，或让协作者先注册。';
      } catch (error) { if (input.isConnected) notify(error.message, true); }
    }, 320);
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener('close', () => { invalidateWalletContext(); const credential = document.getElementById('agent-credential'); if (credential) { credential.value = ''; credential.textContent = ''; } if (modalReturn?.isConnected) modalReturn.focus(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDialog();
  });
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); renderRoute(); });
  window.addEventListener('pagehide', closeDialog);
  async function boot() {
    try { const session = await api('/api/session'); user = session.user; csrfToken = session.csrfToken; await renderRoute(); }
    catch (error) { app.innerHTML = `<main id="main" class="initial"><span class="wordmark">aia</span><h1>暂时无法连接工作空间</h1><p>${e(error.message)}</p><div class="form-actions spaced"><button class="button" data-action="boot-retry">重新连接</button></div></main>`; app.querySelector('[data-action="boot-retry"]').addEventListener('click', boot); }
  }
  boot();
})();
