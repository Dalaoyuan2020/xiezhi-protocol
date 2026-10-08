(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClaimCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SEAL_TEXT = '灋廌覈鑒';
  const DEMO_CODE = '246810';
  const LIMIT_NOTICE = '邮箱与机构域名仅验证控制权一致，不保证论文作者身份。';
  const DEMO_NOTICE = '演示 · 非真实认证。虚构人物、机构与论文；保留域名仅演示，不会发信。' + LIMIT_NOTICE;
  const fail = error => ({ ok: false, error });
  const clone = value => JSON.parse(JSON.stringify(value));

  function domainName(value) {
    if (typeof value !== 'string') return '';
    const domain = value.trim().toLowerCase();
    if (domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || !/[a-z]$/.test(domain)) return '';
    const parts = domain.split('.');
    if (parts.length < 2 || parts.some(p => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) return '';
    return domain;
  }
  function isWithin(host, domain) { return host === domain || host.endsWith('.' + domain); }
  function reserved(domain) {
    return ['example.org', 'example.com', 'example.net', 'test', 'invalid', 'localhost', 'local', 'example'].some(d => isWithin(domain, d));
  }
  // This is a conservative client-side check, not domain provenance discovery.
  // Only /api/claim/start supplies a public domain; the server remains authoritative.
  function resolveDomain(author, mode) {
    const domain = domainName(author && author.domain);
    if (!domain || (mode !== 'demo' && reserved(domain))) return '';
    try {
      const url = new URL(author.website);
      // Official homepage metadata is parsed only; neither protocol triggers a website request.
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return '';
      const host = domainName(url.hostname);
      if (!host || !isWithin(host, domain)) return '';
      return domain;
    } catch (_) { return ''; }
  }
  function validateEmail(value, institutionDomain) {
    const domain = domainName(institutionDomain);
    if (!domain) return fail('机构域名无可信来源，暂不能发送验证码。');
    if (typeof value !== 'string' || /[\r\n\u0000-\u001f\u007f]/.test(value)) return fail('请填写有效的机构邮箱。');
    const email = value.trim();
    if (email.length > 254) return fail('邮箱地址过长。');
    const parts = email.split('@');
    const local = parts[0];
    if (parts.length !== 2 || !local || local.length > 64 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return fail('请填写完整有效的机构邮箱。');
    const host = domainName(parts[1]);
    if (!host || parts[1] !== parts[1].trim() || !isWithin(host, domain)) return fail('邮箱必须属于 ' + domain + ' 或其子域，不能使用相似后缀。');
    return { ok: true, email: local + '@' + host, domain };
  }
  function validateDecisions(works, decisions) {
    if (!Array.isArray(works) || !works.length) return fail('没有可核对的论文，暂不能认领。');
    if (!Array.isArray(decisions)) return fail('请逐篇明确选择本人、排除或待核对。');
    const ids = new Set(works.map(w => w.id));
    if (ids.size !== works.length || works.some(w => !w.id)) return fail('论文列表不完整，请重新选择档案。');
    const seen = new Set();
    for (const d of decisions) {
      if (!d || !ids.has(d.workId) || seen.has(d.workId) || !['claim', 'exclude', 'unsure'].includes(d.decision)) return fail('论文选择包含未知、重复或无效项目。');
      seen.add(d.workId);
    }
    if (seen.size !== ids.size) return fail('请逐篇明确选择；待核对也需要主动勾选。');
    const claimed = decisions.filter(d => d.decision === 'claim').map(d => d.workId);
    if (!claimed.length) return fail('至少需要确认一篇是本人论文，才能继续认领。');
    return { ok: true, claimed };
  }
  function demoFlow() {
    return {
      id: 'demo-xiaoli-flow',
      author: { id: 'demo-xiaoli', name: '小李', institution: '明德大学（虚构）', website: 'https://mingde.example.org', domain: 'mingde.example.org' },
      works: [
        { id: 'demo-w1', title: '低碳校园的协同实验', year: 2024, doi: '', contribution: '实验设计、初稿撰写', clue: '姓名、明德大学署名与实验记录一致。', suggested: 'claim' },
        { id: 'demo-w2', title: '星系光谱的观测研究', year: 2023, doi: '', contribution: '同名作者，非本人', clue: '作者同名，但属于另一所机构，方向也不同。', suggested: 'exclude' },
        { id: 'demo-w3', title: '开放数据复现札记', year: 2022, doi: '', contribution: '待核对原文署名', clue: '旧稿缺少完整署名材料，先保留为待核对。', suggested: 'unsure' }
      ],
      notice: DEMO_NOTICE
    };
  }
  function createState(mode, flow) {
    if (!['demo', 'public'].includes(mode)) throw new Error('未知认领模式。');
    return { mode, flow: flow ? clone(flow) : null, email: '', decisions: [], challenge: null, verification: null, acknowledged: false };
  }
  function invalidate(state) { return { ...state, challenge: null, verification: null, acknowledged: false }; }
  function setEmail(state, value) {
    const email = String(value == null ? '' : value).slice(0, 254);
    return email === state.email ? state : { ...invalidate(state), email };
  }
  function setDecision(state, workId, decision) {
    if (!state.flow || !state.flow.works.some(w => w.id === workId) || !['claim', 'exclude', 'unsure'].includes(decision)) throw new Error('未知论文或选择。');
    if (state.decisions.some(d => d.workId === workId && d.decision === decision)) return state;
    return { ...invalidate(state), decisions: [...state.decisions.filter(d => d.workId !== workId), { workId, decision }] };
  }
  function binding(state) {
    return JSON.stringify([state.mode, state.flow && state.flow.id, state.flow && state.flow.author.id, state.email.trim(), [...state.decisions].sort((a, b) => String(a.workId).localeCompare(String(b.workId)))]);
  }
  function canSend(state) {
    if (!state || !state.flow) return fail('请先核对并选择机构档案。');
    const selection = validateDecisions(state.flow.works, state.decisions);
    if (!selection.ok) return selection;
    return validateEmail(state.email, resolveDomain(state.flow.author, state.mode));
  }
  function maskEmail(email) {
    const [local, host] = email.split('@');
    return local.slice(0, 1) + '***@' + host;
  }
  function demoOnly(state) { if (state.mode !== 'demo') throw new Error('固定验证码与本地凭证仅限演示模式。'); }
  function sendDemoCode(state, now) {
    demoOnly(state);
    const result = canSend(state);
    if (!result.ok) throw new Error(result.error);
    if (!Number.isFinite(now)) throw new Error('缺少演示时间。');
    return { ...state, verification: null, acknowledged: false, challenge: { binding: binding(state), expiresAt: now + 600000, maskedEmail: maskEmail(result.email) } };
  }
  function verifyDemoCode(state, code, now) {
    demoOnly(state);
    if (!state.challenge) throw new Error('请先发送模拟验证码，再查看虚拟收件箱。');
    if (!Number.isFinite(now) || now >= state.challenge.expiresAt) throw new Error('模拟验证码已过期，请重新发送。');
    if (state.challenge.binding !== binding(state)) throw new Error('资料已变更，请重新发送验证码。');
    if (!/^\d{6}$/.test(String(code)) || code !== DEMO_CODE) throw new Error('验证码不正确，请填写虚拟收件箱中的六位数字。');
    return { ...state, verification: { method: 'demo', binding: binding(state) } };
  }
  function canFinalize(state) {
    const ready = canSend(state);
    if (!ready.ok) return ready;
    const method = state.mode === 'demo' ? 'demo' : 'server';
    if (!state.verification || state.verification.method !== method || state.verification.binding !== binding(state)) return fail('请先完成当前邮箱与论文选择的验证码校验。');
    if (!state.acknowledged) return fail('请先确认已理解凭证的证明范围。');
    return { ok: true };
  }
  function createDemoCertificate(state, options) {
    demoOnly(state);
    const gate = canFinalize(state);
    if (!gate.ok) throw new Error(gate.error);
    const issuedAt = options && options.issuedAt;
    if (!issuedAt || !Number.isFinite(Date.parse(issuedAt))) throw new Error('缺少凭证签发时间。');
    const claimed = new Set(validateDecisions(state.flow.works, state.decisions).claimed);
    return {
      id: 'DEMO-' + new Date(issuedAt).toISOString().replace(/\D/g, '').slice(0, 17),
      title: SEAL_TEXT, sealText: SEAL_TEXT, demo: true, issuedAt,
      author: clone(state.flow.author), works: state.flow.works.filter(w => claimed.has(w.id)).map(clone),
      emailVerification: { verified: true, domain: resolveDomain(state.flow.author, 'demo'), maskedEmail: maskEmail(state.email.trim()) },
      notice: DEMO_NOTICE
    };
  }
  return Object.freeze({ SEAL_TEXT, DEMO_CODE, LIMIT_NOTICE, DEMO_NOTICE, domainName, resolveDomain, validateEmail, validateDecisions, demoFlow, createState, setEmail, setDecision, binding, canSend, canFinalize, sendDemoCode, verifyDemoCode, createDemoCertificate });
});
