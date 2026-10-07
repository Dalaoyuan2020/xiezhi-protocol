/* Server-held claims with scoped email verification and explicit wallet or local-chain anchoring. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const delay = ms => new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms));
  const labels = { claim: '是我的', exclude: '不是我的', unsure: '不确定' };
  let epoch = 0, token = '', flow = null, mail = {}, chain = {}, step = 0, busy = false;
  let selections = new Map(), reviewed = new Set(), expanded = false, cooldownUntil = 0, cooldownTimer;
  let resetPending = Promise.resolve(), currentCertificate = null, pollingTimer;
  let emailValue = '', deliveryValue = 'preview', demoPreview = false;
  let anchorMode = 'local', pendingTxHash = '', submissionUncertain = false, restoredReceipt = false, draftView = '';
  let reportSeen = false, challengeUntil = 0, walletRequestOpen = false;
  const DRAFT_PREFIX = 'scholar-claim-draft/v2:';
  class StaleFlow extends Error {}

  async function raw(path, body) {
    const response = await fetch('/claim-api' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': token }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === '/finalize' ? 90000 : 45000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || data.message || '服务暂时不可用，请稍后重试。'), { status: response.status });
    return data;
  }
  async function api(path, body) {
    const version = epoch;
    const data = await raw(path, body);
    if (version !== epoch) throw new StaleFlow();
    return data;
  }
  async function session(force = false) {
    if (token && !force) return null;
    const data = await api('/session');
    token = data.csrfToken;
    mail = data.mail || {}; chain = data.chain || {};
    return data;
  }
  function accept(data) {
    if (data.flow) flow = data.flow;
    if (data.mail) mail = data.mail;
    if (data.chain) chain = data.chain;
    if (flow?.email) {
      cooldownUntil = Date.now() + Math.max(0, Number(flow.email.retryAfter) || 0) * 1000;
      challengeUntil = Date.now() + Math.max(0, Number(flow.email.expiresIn) || 0) * 1000;
    }
  }
  function progress(stage = 0, detail = '') {
    let slot = el('claim-journey');
    if (!slot) {
      slot = document.createElement('section'); slot.id = 'claim-journey'; slot.className = 'cf-journey';
      slot.setAttribute('aria-label', '从检索到存证的完整流程');
      const host = el('live-main'); host?.insertBefore(slot, host.firstElementChild);
    }
    const items = ['检索学者', '体检报告', '认领论文', '邮箱核验', '盖章存证'];
    slot.innerHTML = `<ol>${items.map((name, i) => `<li class="${stage > i ? 'done' : stage === i ? 'active' : ''}"${stage === i ? ' aria-current="step"' : ''}><span>${stage > i ? '✓' : String(i + 1).padStart(2, '0')}</span><b>${name}</b></li>`).join('')}</ol><p role="status">${escape(detail || (stage === 5 ? '凭证已生成，可下载并独立核对链上记录。' : `第 ${stage + 1} 步 / 共 5 步 · ${items[stage]}`))}</p>`;
  }
  function pinFlow() {
    if (!flow?.id) return;
    const url = new URL(location.href); url.searchParams.set('claim', flow.id);
    if (flow.mode === 'demo') url.searchParams.set('demo', 'claim-xu');
    history.replaceState(null, '', url.pathname + url.search);
  }
  function saveDraft() {
    if (!flow?.id) return;
    const data = { savedAt: Date.now(), view: draftView, selections: decisionsBody(), reviewed: [...reviewed], pendingTxHash, submissionUncertain, reportSeen, anchorMode };
    try { sessionStorage.setItem(DRAFT_PREFIX + flow.id, JSON.stringify(data)); } catch { /* Private or full storage: server-confirmed steps remain recoverable. */ }
  }
  function loadDraft() {
    try {
      const data = JSON.parse(sessionStorage.getItem(DRAFT_PREFIX + flow.id) || 'null');
      return data && Date.now() - data.savedAt < 6 * 3600_000 && Array.isArray(data.selections) && Array.isArray(data.reviewed) ? data : null;
    } catch { return null; }
  }
  function verifiedEmail() { return Boolean(flow?.email?.verified || flow?.mode === 'demo' && flow?.email?.previewConfirmed); }
  function sameSelections() {
    const server = new Map((flow?.decisions || []).map(item => [item.workId, item.decision]));
    return server.size === (flow?.works || []).length && decisionsBody().every(item => server.get(item.workId) === item.decision);
  }
  function restoreValues() {
    const works = flow.works || [], validIds = new Set(works.map(work => work.id));
    selections = new Map((flow.decisions || []).map(item => [item.workId, item.decision]));
    reviewed = new Set((flow.decisions || []).map(item => item.workId));
    const draft = loadDraft();
    if (draft && !flow.finalizing && !flow.mainnetAnchor && !flow.certificate) {
      for (const item of draft.selections) if (validIds.has(item.workId) && Object.hasOwn(labels, item.decision)) selections.set(item.workId, item.decision);
      reviewed = new Set(draft.reviewed.filter(id => validIds.has(id)));
    }
    draftView = draft?.view || ''; reportSeen = Boolean(draft?.reportSeen || flow.decisions?.length);
    pendingTxHash = flow.mainnetAnchor?.transactionHash || (/^0x[a-f0-9]{64}$/i.test(draft?.pendingTxHash || '') ? draft.pendingTxHash : '');
    submissionUncertain = Boolean(draft?.submissionUncertain && !pendingTxHash);
    anchorMode = flow.mode === 'demo' ? 'local' : flow.mainnetAnchor ? 'mainnet' : draft?.anchorMode === 'local' ? 'local' : 'mainnet';
    deliveryValue = flow.email?.delivery || (flow.mode === 'demo' ? 'preview' : 'smtp');
    currentCertificate = flow.certificate || null; demoPreview = flow.mode === 'demo';
    pinFlow();
  }
  function renderRecovered() {
    if (flow.certificate) { currentCertificate = flow.certificate; restoredReceipt = true; renderCertificate(); }
    else if (flow.mainnetAnchor) { anchorMode = 'mainnet'; pendingTxHash = flow.mainnetAnchor.transactionHash || pendingTxHash; renderAnchorPending(); }
    else if (flow.finalizing) { anchorMode = 'local'; renderConfirm(); notice('上次存证尚未取得确认结果。再次确认会查询或完成同一份凭证，不会重复创建记录。'); }
    else if (flow.mode === 'demo' && !reportSeen && draftView !== 'papers' && !flow.decisions?.length) renderDemoReport();
    else if (draftView === 'papers' || !sameSelections()) renderPapers();
    else if (verifiedEmail()) renderConfirm();
    else if (flow.decisions?.length === flow.works?.length) renderEmail();
    else if (flow.mode === 'demo' && !reportSeen) renderDemoReport();
    else renderPapers();
  }
  async function restore(options = {}) {
    try {
      const data = await session(true);
      const saved = data.flow;
      const matches = saved && (options.claimId ? options.claimId === saved.id : options.demo ? saved.mode === 'demo' : !options.query || options.query === saved.author?.id);
      if (!matches) {
        if (options.claimId) {
          shell('<p class="cf-info">这份认领会话已过期，或已在其他窗口换成了另一个档案。旧邮箱验证不会用于新档案。</p><button id="cf-new-search" class="cf-primary" type="button">返回检索，重新开始</button>', '当前会话中没有这份进度');
          el('cf-new-search').onclick = () => { const url = new URL(location.href); url.searchParams.delete('claim'); location.assign(url.pathname + url.search); };
          return true;
        }
        return false;
      }
      accept(data); restoreValues(); renderRecovered();
      if (el('net')) el('net').textContent = `已恢复 ${flow.author.name} 的${flow.certificate ? '存证凭证' : '认领进度'}`;
      if (el('q') && flow.mode === 'public') el('q').value = options.query || flow.author.id;
      return true;
    } catch (error) {
      if (error instanceof StaleFlow || !options.claimId) return false;
      shell('<p class="cf-info">暂时无法读取已保存的认领进度。不会自动重建或重新发送链上交易。</p><button id="cf-restore-retry" class="cf-primary" type="button">重新获取进度</button>', '连接恢复后，可以接着完成');
      notice(error.message, true);
      el('cf-restore-retry').onclick = event => action(event.currentTarget, () => restore(options));
      return true;
    }
  }
  async function refreshState() {
    const expected = flow?.id;
    const data = await session(true);
    if (!data.flow || data.flow.id !== expected) throw new Error('这份会话已过期或已被其他窗口切换。请返回检索重新选择档案，旧邮箱验证不会被沿用。');
    accept(data); restoreValues(); renderRecovered();
    notice('已从服务器恢复当前进度。');
  }
  function showRoot() { el('claimbox').classList.remove('hidden'); }
  function focusHeading() { const heading = el('cf-title'); if (heading) { heading.focus({ preventScroll: true }); heading.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' }); } }
  function notice(message, error = false) { const target = el('cf-status'); if (target) { target.textContent = message; target.classList.toggle('cf-error', error); } }
  function setBusy(value) {
    busy = value;
    const root = el('claim-app'); root?.setAttribute('aria-busy', String(value));
    root?.querySelectorAll('button').forEach(button => { button.disabled = value || button.dataset.locked === 'true'; });
    if (!value) updateControls();
  }
  async function action(button, task) {
    if (busy) return;
    const version = epoch; setBusy(true); notice('');
    try { await task(); }
    catch (error) { if ([401, 403].includes(error.status)) token = ''; if (version === epoch && !(error instanceof StaleFlow)) notice(error.name === 'TimeoutError' ? '请求超时。你已填写的内容保留，可重试或核对链上状态。' : error.message, true); }
    finally { if (version === epoch) { setBusy(false); if (button?.isConnected) button.focus({ preventScroll: true }); } }
  }
  function shell(content, title, intro = '') {
    showRoot();
    const active = Boolean(flow || demoPreview);
    document.body.classList.toggle('claim-active', active);
    const skip = document.querySelector('a.skip');
    if (skip) { skip.href = active ? '#cf-title' : '#q'; skip.textContent = active ? '跳到当前认领步骤' : '跳到学者核验'; }
    const demo = flow?.mode === 'demo' || demoPreview;
    el('claim-app').innerHTML = `<div class="cf-heading"><div><div class="cf-eyebrow">${demo ? 'INTERACTIVE CASE · 明确标注的模拟资料' : 'CLAIM & VERIFY · 可复核的个人声明'}</div><h2 id="cf-title" tabindex="-1">${escape(title)}</h2></div><span class="cf-mode">${demo ? '模拟认领案例' : '公开档案 · 个人声明'}</span></div>
      ${intro ? `<p class="cf-intro">${escape(intro)}</p>` : ''}

      ${content}<p id="cf-status" class="cf-status" role="status" aria-live="polite"></p>${flow ? '<div class="cf-session-tools"><span>已提交步骤可从会话恢复</span><button id="cf-refresh-state" class="cf-text-button" type="button">恢复／刷新进度</button></div>' : ''}`;
    bind(); updateControls();
    if (step) progress(step === 1 ? 2 : step < 4 ? 3 : step === 4 ? 4 : 5, step === 3 ? '邮箱核验完成，请最后确认存证内容。' : '');
  }
  function decisionsBody() { return (flow?.works || []).map(work => ({ workId: work.id, decision: selections.get(work.id) || 'unsure' })); }
  function counts() { const values = decisionsBody(); return { claim: values.filter(item => item.decision === 'claim').length, exclude: values.filter(item => item.decision === 'exclude').length, unsure: values.filter(item => item.decision === 'unsure').length }; }
  function summary() { const n = counts(); return `<span><b>${n.claim}</b> 篇认领</span><span><b>${n.exclude}</b> 篇排除</span><span><b>${n.unsure}</b> 篇待核实</span>`; }
  function updateControls() {
    if (busy) return;
    const send = el('cf-send');
    if (send) {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      const smtpUnavailable = el('cf-delivery')?.value === 'smtp' && !mail.configured;
      send.disabled = left > 0 || smtpUnavailable;
      send.textContent = left ? `${left} 秒后重发` : '发送验证码';
    }
    const next = el('cf-papers-next'); if (next) next.disabled = reviewed.size < (flow?.works || []).length;
    const progress = el('cf-review-count'); if (progress) progress.textContent = `已确认 ${reviewed.size} / ${(flow?.works || []).length} 篇`;
    const totals = el('cf-summary'); if (totals) totals.innerHTML = summary();
    const confirm = el('cf-finalize'); if (confirm) confirm.disabled = !el('cf-agreement')?.checked;
    const codeStatus = el('cf-code-expiry');
    if (codeStatus && flow?.email && !verifiedEmail()) { const seconds = Math.max(0, Math.ceil((challengeUntil - Date.now()) / 1000)); codeStatus.textContent = flow.email.challengeActive === false ? '验证码已失效，请重新发送。' : seconds ? `当前验证码剩余约 ${Math.ceil(seconds / 60)} 分钟。` : '若之前的验证码已过期，请重新发送。'; }
  }
  function renderPapers() {
    step = 1; draftView = 'papers'; saveDraft();
    const works = flow.works || [];
    const list = expanded ? works : works.slice(0, 5);
    shell(`<div class="cf-profile"><div class="cf-avatar">${escape((flow.author?.name || '学').slice(0, 1))}</div><div><strong>${escape(flow.author?.name)}</strong><p>${escape(flow.author?.institution || '机构尚未收录')} · ${escape(flow.author?.id)}</p></div><span>${works.length} 篇材料</span></div>
      <div class="cf-paper-list">${list.map((work, i) => `<article class="cf-paper${reviewed.has(work.id) ? ' reviewed' : ''}"><div class="cf-paper-index">${String(i + 1).padStart(2, '0')}</div><div class="cf-paper-content"><h3>${escape(work.title)}</h3><p class="cf-paper-meta">${escape(work.year || '年份未收录')} · ${escape(work.source || '公开文献记录')}${work.fictional ? ' · 虚构论文，仅供演练' : ''}</p>${work.doi ? `<p class="cf-doi">DOI ${escape(work.doi)}</p>` : ''}${work.fictional && work.hint ? `<p class="cf-paper-hint">${escape(work.hint)}</p>` : ''}<div class="cf-choices" role="group" aria-label="${escape(work.title)}：认领选择">${Object.entries(labels).map(([value, label]) => `<button type="button" data-choice="${value}" data-work="${escape(work.id)}" aria-pressed="${reviewed.has(work.id) && selections.get(work.id) === value}">${value === 'claim' ? '✓' : value === 'exclude' ? '×' : '?'} ${label}</button>`).join('')}</div></div></article>`).join('') || '<p class="cf-info">此档案暂未取到论文。可验证邮箱并保存一份不包含论文认领的个人声明。</p>'}</div>
      ${works.length > 5 ? `<button class="cf-text-button" type="button" id="cf-expand">${expanded ? '收起论文' : `展开全部 ${works.length} 篇论文`}</button>` : ''}
      <div class="cf-review-tools"><span id="cf-review-count"></span>${works.length ? '<button class="cf-text-button" id="cf-mark-unsure" type="button">其余标为不确定</button>' : ''}</div>
      <div id="cf-summary" class="cf-summary">${summary()}</div>
      <div class="cf-actions"><p>不确定也可以继续；不会自动判为错挂或给学术分加分。</p><button type="button" id="cf-papers-next" class="cf-primary">下一步 · 验证邮箱 <span aria-hidden="true">→</span></button></div>`, '这些论文，哪些是你的？', flow.mode === 'demo' ? '本例使用“徐林森”作为演练名称，机构与论文均为虚构，不是对真实学者的结论。每篇请亲自选一次。' : '这些论文来自服务端读取的公开记录。请逐篇作出声明；作者身份及论文归属仍需独立核查。');
  }
  function renderEmail() {
    step = 2; draftView = 'email'; saveDraft();
    const demo = flow.mode === 'demo';
    if (!demo) deliveryValue = 'smtp';
    shell(`<div class="cf-email-layout"><form id="cf-email-form" class="cf-email-form">
      <label for="cf-email">接收验证结果的邮箱</label><input id="cf-email" name="email" type="email" autocomplete="email" maxlength="254" value="${escape(emailValue)}" placeholder="name@university.edu" required>
      ${demo ? `<label for="cf-delivery">验证方式</label><select id="cf-delivery"><option value="preview"${deliveryValue === 'preview' ? ' selected' : ''}>本地模拟邮件 · 页面预览验证码</option><option value="smtp"${deliveryValue === 'smtp' ? ' selected' : ''}${mail.configured ? '' : ' disabled'}>真实邮箱 · SMTP 发信${mail.configured ? '' : '（暂未配置）'}</option></select>` : '<input id="cf-delivery" type="hidden" value="smtp">'}
      ${!demo && !mail.configured ? '<p class="cf-info">真实发信服务尚未配置，请管理员在独立管理页配置 SMTP 后重试。不会用页面展示验证码替代真实邮箱验证。</p>' : ''}
      <button id="cf-send" class="cf-secondary" type="submit">发送验证码</button>${flow.email ? `<p class="cf-email-bound">当前验证码对应 ${escape(flow.email.masked)}。${flow.email.delivery === 'preview' ? '模拟验证码不保存到浏览器；刷新后可等待冷却结束重新生成。' : '仍可输入之前收到的有效验证码；更换邮箱需要重新发送。'}</p>` : ''}${verifiedEmail() ? '<button id="cf-email-continue" class="cf-primary" type="button">使用已验证邮箱，继续确认 →</button>' : ''}<div id="cf-email-sent" class="cf-mail-status" role="status" aria-live="polite"></div>
      <div id="cf-preview" class="cf-mail-preview" hidden></div>
      <label for="cf-code">邮件中的 6 位验证码</label><p id="cf-code-expiry" class="cf-code-expiry" role="status"></p><div class="cf-code-row"><input id="cf-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><button type="button" id="cf-verify" class="cf-primary">验证邮箱 →</button></div>
      </form><aside class="cf-email-aside"><div class="cf-envelope" aria-hidden="true">✉</div><h3>确认这封邮件，是你收到的</h3><p>验证只证明你控制这个邮箱，不证明你是论文作者。认领声明将保留“待独立核查”状态。</p><p>${demo ? '模拟邮件只在这个演练案例使用；模拟验证会明确写入凭证。' : '真实验证码只发到邮箱。我们不在页面或凭证中公开验证码。'}</p><div class="cf-summary">${summary()}</div></aside></div>
      <div class="cf-actions"><button id="cf-back-papers" class="cf-text-button" type="button">← 返回修改认领</button><p>换人或重新检索后，需要重新验证邮箱。</p></div>`, '用邮箱，确认这份声明来自你', '验证通过后还有一步最终确认。此时尚未写入区块链。');
    clearInterval(cooldownTimer); cooldownTimer = setInterval(updateControls, 1000);
  }
  function renderConfirm() {
    step = 3; draftView = 'confirm'; saveDraft();
    const localOnly = flow.mode === 'demo';
    shell(`<div class="cf-confirm-card"><div class="cf-confirm-top"><div><span class="cf-kicker">待签发的认领声明</span><h3>${escape(flow.author?.name)}</h3><p>${escape(flow.author?.institution || '机构尚未收录')}</p></div><span class="cf-verified">✓ ${flow.email?.delivery === 'preview' ? '模拟邮箱验证完成' : '邮箱验证完成'}</span></div><div class="cf-summary">${summary()}</div><ul class="cf-final-papers">${(flow.works || []).map(work => `<li><span class="cf-decision ${selections.get(work.id)}">${escape(labels[selections.get(work.id) || 'unsure'])}</span><span>${escape(work.title)}</span></li>`).join('')}</ul><p class="cf-info">已验证：${escape(flow.email?.masked || '当前会话邮箱')}。上链只提交凭证指纹；邮箱控制权和个人声明不等于作者身份认证。</p></div>
      <fieldset class="cf-anchor-options"${flow.finalizing ? ' disabled' : ''}><legend>选择存证网络</legend>${localOnly ? '<p>本案例仅使用本地模拟链 1337，不请求钱包，也不花主网 Gas。</p>' : `<label><input type="radio" name="claim-network" value="mainnet"${anchorMode === 'mainnet' ? ' checked' : ''}><span><b>BOT Chain 主网</b><small>由你的钱包确认交易；需要主网 BOT 支付 Gas。页面不会替你签名。</small></span></label><label><input type="radio" name="claim-network" value="local"${anchorMode === 'local' ? ' checked' : ''}><span><b>本地验证</b><small>使用本地模拟链核对完整流程，不是主网存证，也不花主网 Gas。</small></span></label>`}</fieldset>
      <label class="cf-agreement"><input id="cf-agreement" type="checkbox"><span>我已核对论文选择与存证网络。${localOnly ? '我知道这是虚构案例演练。' : '我知道个人声明仍需独立核查。'}确认后材料会冻结，后续只查询或重试同一份凭证。</span></label>
      <div class="cf-actions">${flow.finalizing ? '<span class="cf-info">正在恢复同一份存证，不会重新认领论文。</span>' : '<button id="cf-back-email" class="cf-text-button" type="button">← 返回邮箱步骤</button>'}<button id="cf-finalize" class="cf-primary" type="button" disabled>${anchorMode === 'mainnet' ? '确认 · 连接钱包存证' : '确认 · 本地存证并盖章'} <span aria-hidden="true">↗</span></button></div>`, '最后核对一次，再留下凭证', '先确认材料和网络；只有链上交易已确认，才展示存证成功和盖章动画。');
  }
  function blockCards(data) {
    return [...(data.blocks || [])].sort((a, b) => a.number - b.number).slice(-5).map(block => `<div class="cf-block"><span>BLOCK</span><strong>#${escape(block.number)}</strong><code>${escape(String(block.hash || '').slice(0, 14))}…</code><small>${escape(block.transactionCount ?? 0)} 笔交易</small></div>`).join('');
  }
  function chainPanel(data) {
    if (data?.chainId === 677) return `<section class="cf-chain cf-mainnet-chain" aria-label="BOT Chain 主网存证"><span class="cf-kicker">BOT CHAIN MAINNET · 677</span><h3>主网确认的存证记录</h3><div class="cf-blocks"><div class="cf-block"><span>CONFIRMED BLOCK</span><strong>#${escape(data.blockNumber)}</strong><code>${escape(String(data.blockHash || '').slice(0, 14))}…</code><small>凭证指纹已写入</small></div></div><a class="cf-explorer-link" href="https://scan.botchain.ai/tx/${escape(data.transactionHash)}" target="_blank" rel="noopener noreferrer">打开这笔真实主网交易 ↗</a><p>区块号与交易哈希来自服务端核验的主网回执。链上记录不代表作者身份或学术质量认证。</p></section>`;
    return `<section class="cf-chain" aria-label="本地区块链"><div class="cf-chain-heading"><div><span class="cf-kicker">LOCAL EVM · CHAIN ${escape(data.chainId || 1337)}</span><h3>区块正在留下痕迹</h3></div><span class="cf-block-height">区块高度 <b id="cf-block-number">${escape(data.blockNumber ?? '—')}</b></span></div><p>本地模拟链 · 非 BOT 主网。下面的区块和交易来自本地节点的实际回执。</p><div id="cf-blocks" class="cf-blocks">${blockCards(data) || '<span class="cf-empty-chain">正在读取本地区块…</span>'}</div><p id="cf-chain-error" class="cf-chain-error" role="status"></p></section>`;
  }
  async function refreshChain() {
    if (currentCertificate?.receipt?.chainId === 677 || flow?.mainnetAnchor) return chain;
    const data = await api('/chain'); chain = data;
    if (el('cf-block-number')) el('cf-block-number').textContent = data.blockNumber ?? '—';
    if (el('cf-blocks')) { el('cf-blocks').innerHTML = blockCards(data); el('cf-blocks').scrollLeft = el('cf-blocks').scrollWidth; }
    if (el('cf-chain-error')) el('cf-chain-error').textContent = '';
    return data;
  }
  function validReceipt(certificate) {
    const receipt = certificate?.receipt;
    return certificate?.payload && /^0x[a-f0-9]{64}$/i.test(certificate.hash || '') && /^0x[a-f0-9]{64}$/i.test(receipt?.transactionHash || '') && [1337, 677].includes(receipt.chainId) && Number.isSafeInteger(Number(receipt.blockNumber));
  }
  async function acceptReceipt(result, animate = true) {
    accept(result);
    const certificate = result.certificate || result.flow?.certificate;
    if (!validReceipt(certificate)) throw new Error('还没有可核对的完整链上回执。');
    currentCertificate = certificate; restoredReceipt = !animate;
    pendingTxHash = certificate.receipt.transactionHash; submissionUncertain = false;
    if (flow) flow.certificate = certificate;
    draftView = 'certificate'; saveDraft();
    renderCertificate(); focusHeading();
  }
  async function recoverAfterFailure() {
    const expected = flow?.id, result = await session(true);
    if (!result.flow || result.flow.id !== expected) return false;
    accept(result);
    if (result.flow.certificate) { await acceptReceipt(result, false); notice('已找回刚才完成的存证；没有再次发送交易。'); return true; }
    return false;
  }
  async function finalizeLocal() {
    const version = epoch; step = 4; draftView = 'sealing'; saveDraft();
    shell(`<div class="cf-signing"><div class="cf-signing-orbit" aria-hidden="true"><img src="/brand/seal.png" alt=""></div><h3>正在提交本地存证</h3><ol id="cf-signing-log" aria-live="polite"><li>已收到最终确认，正在请求服务器生成凭证。</li></ol></div>${chainPanel(chain)}`, '让声明，有一份可复核的记录', '只有节点确认交易后，页面才显示存证完成。');
    setBusy(true);
    try {
      const result = await api('/finalize', { flowId: flow.id }); accept(result);
      if (!validReceipt(result.certificate)) throw new Error('尚未取得完整的链上回执。');
      el('cf-signing-log').insertAdjacentHTML('beforeend', '<li>凭证指纹已写入本地 EVM 节点。</li>');
      await delay(500); if (version !== epoch) throw new StaleFlow();
      el('cf-signing-log').insertAdjacentHTML('beforeend', `<li>交易已确认，写入区块 #${escape(result.certificate.receipt.blockNumber)}。</li>`);
      try { await refreshChain(); } catch (error) { if (error instanceof StaleFlow) throw error; }
      await delay(750); if (version !== epoch) throw new StaleFlow();
      await acceptReceipt(result, true);
    } catch (error) {
      if (version !== epoch || error instanceof StaleFlow) return;
      try { if (await recoverAfterFailure()) return; } catch (recoveryError) { if (recoveryError instanceof StaleFlow) return; }
      renderConfirm(); notice(`暂时没有取得确认结果：${error.message}。请先“恢复／刷新进度”；确认重试仍使用同一份凭证。`, true);
    } finally { if (version === epoch) setBusy(false); }
  }
  function walletProvider() {
    const provider = window.ethereum;
    if (!provider?.request) throw new Error('没有检测到支持 EVM 的浏览器钱包。请使用钱包内置浏览器打开，或安装兼容钱包；也可以在准备交易前选择本地验证。');
    return provider;
  }
  async function requestWallet(provider, method, params = []) {
    let timer;
    try { return await Promise.race([provider.request({ method, params }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('钱包等待超时，请打开钱包确认当前交易状态。')), 120000); })]); }
    finally { clearTimeout(timer); }
  }
  async function useMainnet(provider) {
    const chainId = await requestWallet(provider, 'eth_chainId');
    if (String(chainId).toLowerCase() === '0x2a5') return;
    try { await requestWallet(provider, 'wallet_switchEthereumChain', [{ chainId: '0x2a5' }]); }
    catch (error) {
      if (Number(error.code) !== 4902) throw error;
      await requestWallet(provider, 'wallet_addEthereumChain', [{ chainId: '0x2a5', chainName: 'BOT Chain', nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 }, rpcUrls: ['https://rpc.botchain.ai'], blockExplorerUrls: ['https://scan.botchain.ai'] }]);
      await requestWallet(provider, 'wallet_switchEthereumChain', [{ chainId: '0x2a5' }]);
    }
    if (String(await requestWallet(provider, 'eth_chainId')).toLowerCase() !== '0x2a5') throw new Error('钱包尚未切换到 BOT Chain 主网 677，未发送交易。');
  }
  function renderAnchorPending(message = '') {
    step = 4; draftView = 'sealing'; anchorMode = 'mainnet';
    const txHash = flow.mainnetAnchor?.transactionHash || pendingTxHash;
    if (txHash) pendingTxHash = txHash;
    saveDraft();
    shell(`<div class="cf-mainnet-state"><span class="cf-network-pill">BOT CHAIN MAINNET · 677</span><h3>${txHash ? '交易已发送，等待链上核验' : submissionUncertain ? '请先核对钱包是否已经发送' : '材料已冻结，等待你的钱包签名'}</h3><p>${txHash ? '刷新页面会恢复这笔交易。接下来只查询同一个交易哈希，不重复广播。' : '论文和邮箱验证结果已固定。只有你在钱包里确认，才会广播交易并消耗 Gas。'}</p>${txHash ? `<a class="cf-explorer-link" href="https://scan.botchain.ai/tx/${escape(txHash)}" target="_blank" rel="noopener noreferrer">在 BOT 浏览器查看交易 ↗</a><code class="cf-pending-hash">${escape(txHash)}</code><button id="cf-check-mainnet" class="cf-primary" type="button">查询这笔交易的确认结果</button><details class="cf-manual-hash"><summary>钱包已加速、替换交易，或需要纠正哈希？</summary><label for="cf-transaction-hash">填写钱包中最新的交易哈希</label><input id="cf-transaction-hash" type="text" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"><button id="cf-submit-hash" class="cf-secondary" type="button">核对替换后的交易</button></details>` : `<button id="cf-sign-mainnet" class="cf-primary" type="button"${submissionUncertain ? ' disabled data-locked="true"' : ''}>连接钱包，确认存证交易</button>${submissionUncertain ? '<p class="cf-info">钱包可能已广播，但页面没有收到哈希。先在钱包活动记录中核对，避免重复发送。</p><button id="cf-retry-wallet" class="cf-secondary" type="button">已确认钱包未发送，重新签名</button>' : ''}<details class="cf-manual-hash"><summary>钱包已经发送，但页面没有收到结果？</summary><label for="cf-transaction-hash">粘贴钱包活动记录中的交易哈希</label><input id="cf-transaction-hash" type="text" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"><button id="cf-submit-hash" class="cf-secondary" type="button">核对已发送交易</button></details>`}</div>`, '把凭证指纹写入 BOT Chain', '主网交易由你的钱包亲自签名。交易被核验为成功之前，不显示盖章成功。');
    if (message) notice(message, true);
  }
  async function checkMainnet() {
    const hash = pendingTxHash || flow.mainnetAnchor?.transactionHash;
    if (!/^0x[a-f0-9]{64}$/i.test(hash || '')) throw new Error('尚未拿到有效交易哈希。请先在钱包里确认交易。');
    pendingTxHash = hash; submissionUncertain = false; saveDraft();
    const result = await api('/confirm-anchor', { flowId: flow.id, transactionHash: hash }); accept(result);
    if (result.certificate) { await acceptReceipt(result, true); return; }
    renderAnchorPending();
    notice(result.pending ? '交易仍在等待确认。可以稍后再查，或查看浏览器；不会重复发送交易。' : '暂未得到确认结果，请稍后重新查询。');
  }
  async function startMainnet() {
    const version = epoch;
    if (pendingTxHash || flow.mainnetAnchor?.transactionHash) return checkMainnet();
    const provider = walletProvider();
    let sending = false; walletRequestOpen = true;
    try {
      notice('请在钱包中选择账户并确认 BOT Chain 网络。');
      const accounts = await requestWallet(provider, 'eth_requestAccounts');
      if (version !== epoch) throw new StaleFlow();
      const account = accounts?.[0]; if (!/^0x[a-f0-9]{40}$/i.test(account || '')) throw new Error('钱包未提供有效账户，未发送交易。');
      await useMainnet(provider); if (version !== epoch) throw new StaleFlow();
      const result = await api('/prepare-anchor', { flowId: flow.id, walletAddress: account, acknowledged: true }); accept(result);
      const transaction = result.anchor?.transaction;
      if (!transaction || transaction.from?.toLowerCase() !== account.toLowerCase() || transaction.chainId?.toLowerCase() !== '0x2a5' || transaction.value !== '0x0' || !/^0x[a-f0-9]{40}$/i.test(transaction.to || '') || !/^0x[a-f0-9]+$/i.test(transaction.data || '')) throw new Error('服务器返回的交易准备数据不完整，未发送交易。');
      renderAnchorPending(); setBusy(true); notice('请在钱包内核对合约和 Gas。页面正在等待你的签名。');
      // A refresh may happen after the wallet broadcasts but before its promise resolves.
      // Persist uncertainty before opening the send request so resuming never offers an
      // unconditional second transaction when we have no returned hash yet.
      sending = true; submissionUncertain = true; saveDraft();
      const transactionHash = await requestWallet(provider, 'eth_sendTransaction', [{ from: transaction.from, to: transaction.to, data: transaction.data, value: '0x0', chainId: '0x2a5' }]);
      if (version !== epoch) throw new StaleFlow();
      if (!/^0x[a-f0-9]{64}$/i.test(transactionHash || '')) throw new Error('钱包没有返回有效交易哈希，请核对钱包活动记录。');
      pendingTxHash = transactionHash; sending = false; submissionUncertain = false; saveDraft();
      renderAnchorPending(); setBusy(true);
      await checkMainnet();
    } catch (error) {
      if (version !== epoch || error instanceof StaleFlow) return;
      if (sending) submissionUncertain = Number(error.code) !== 4001;
      if (flow.mainnetAnchor || pendingTxHash) { saveDraft(); renderAnchorPending(Number(error.code) === 4001 ? '你取消了钱包确认，没有由此发送新交易。可以准备好后重试。' : error.message); }
      else throw error;
    } finally { walletRequestOpen = false; }
  }
  async function finalize() {
    if (flow.mode !== 'demo' && anchorMode === 'mainnet') return startMainnet();
    return finalizeLocal();
  }
  function renderCertificate() {
    step = 5; draftView = 'certificate'; saveDraft();
    const cert = currentCertificate, data = cert.payload, receipt = cert.receipt, mainnet = receipt.chainId === 677;
    const networkLabel = mainnet ? 'BOT Chain 主网' : '本地模拟链';
    shell(`<article class="cf-certificate"><div class="cf-certificate-top"><span>学术信誉链 · 认领凭证</span><span>${data.mode === 'demo' ? '模拟案例' : '个人声明'} / ${mainnet ? 'BOT MAINNET' : 'LOCAL'}</span></div><div class="cf-certificate-main"><div class="cf-certificate-copy"><span class="cf-kicker">CLAIM RECEIPT</span><h3>${escape(data.author?.name)} 的论文认领声明</h3><p class="cf-certificate-state">✓ ${mainnet ? '主网' : '本地'}存证完成 · 作者归属待独立核查</p><p>${data.emailVerification?.mode === 'preview' ? '本地模拟邮件验证' : '邮箱控制权已验证'} · ${escape(data.emailVerification?.masked || '邮箱仅保留摘要')}</p></div><div class="cf-stamp-wrap"><img class="cf-stamp${restoredReceipt ? ' cf-stamp-restored' : ''}" src="/brand/seal.png" alt="${mainnet ? '主网' : '本地'}存证章，不代表作者身份认证"><span>${mainnet ? '主网' : '本地'}存证</span></div></div><div class="cf-summary">${summary()}</div><div class="cf-completion"><div><span>材料整理完成度</span><strong id="cf-completion-score">${escape(data.assessment?.score ?? '—')}</strong></div><p>表示这份声明的整理情况，与学术体检分不同。认领操作不自动增加学术信誉分。</p></div><dl class="cf-fingerprints"><div><dt>凭证指纹</dt><dd><code>${escape(cert.hash)}</code></dd></div><div><dt>${mainnet ? '真实主网交易' : '真实本地交易'}</dt><dd><code>${escape(receipt.transactionHash)}</code></dd></div><div><dt>记录位置</dt><dd>Chain ${escape(receipt.chainId)} · 区块 #${escape(receipt.blockNumber)} · ${escape(receipt.label || networkLabel)}</dd></div><div><dt>签发时间</dt><dd>${escape(new Date(data.issuedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}（北京时间）</dd></div></dl><p class="cf-certificate-note">${escape(data.notice || '凭证记录了你的声明与验证方式；不代表已完成作者身份、论文归属或科研质量核验。')}</p></article>
      <div class="cf-receipt-actions"><button id="cf-download" class="cf-primary" type="button">下载凭证 JSON ↓</button><button id="cf-recheck" class="cf-secondary" type="button">重算指纹 · 核对链上记录</button><button id="cf-tamper" class="cf-text-button" type="button">试试：改一个字再核对</button></div><p id="cf-recheck-result" class="cf-recheck-result" role="status" aria-live="polite"></p>${chainPanel(mainnet ? receipt : { ...chain, blockNumber: chain.blockNumber ?? receipt.blockNumber })}<p class="cf-finish-note">流程已完成。刷新后仍可查看、下载这份凭证，并重新核对${escape(networkLabel)}记录。</p>`, restoredReceipt ? '已找回你的存证凭证。' : '已盖章。现在，亲手验证它。', '刚刚的选择、邮箱验证和最后确认，都已经写进可下载的凭证。链上记录可以核对这份凭证有没有被改动。');
    if (el('cf-blocks')) el('cf-blocks').scrollLeft = el('cf-blocks').scrollWidth;
    const target = el('cf-completion-score'), score = Number(data.assessment?.score);
    if (!restoredReceipt && Number.isFinite(score) && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const start = performance.now(); const version = epoch;
      const tick = time => { if (version !== epoch || !target.isConnected) return; const fraction = Math.min(1, (time - start) / 1100); target.textContent = Math.round(score * (1 - (1 - fraction) ** 3)); if (fraction < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    }
    clearTimeout(pollingTimer);
    const version = epoch;
    if (!mainnet) pollingTimer = setTimeout(() => { if (version === epoch) refreshChain().catch(() => { if (el('cf-chain-error')) el('cf-chain-error').textContent = '本地节点暂不可达，已取得的交易回执仍保留在凭证中。'; }); }, 1500);
  }
  function downloadCertificate() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(currentCertificate, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `xiezhi-claim-${String(flow.author?.id || 'receipt').replace(/[^a-zA-Z0-9_-]/g, '')}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function recheck(tampered = false) {
    el('cf-recheck-result').textContent = '正在重算凭证指纹，并核对相应链上的记录…';
    const certificate = structuredClone(currentCertificate);
    if (tampered) certificate.payload.author.name += '（被改动）';
    const result = await api('/certificate/verify', { certificate });
    const target = el('cf-recheck-result');
    target.classList.toggle('cf-invalid', !result.valid || result.issuedByThisService !== true);
    target.textContent = result.valid ? result.issuedByThisService === true ? `✓ 本站签发记录与${currentCertificate.receipt.chainId === 677 ? 'BOT Chain 主网' : '本地模拟链'}上的凭证指纹一致；仍不等于作者身份认证。` : '链上指纹一致，但未找到本站签发记录；不能据此认证邮箱或作者。' : tampered ? '已识别改动：修改姓名后的副本与链上记录不一致。你的原始凭证保持不变。' : '✕ 不一致：凭证内容或链上记录未能匹配，请核对原始凭证与网络。';
  }
  function bind() {
    const on = (id, event, handler) => el(id)?.addEventListener(event, handler);
    el('claim-app').querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.work; selections.set(id, button.dataset.choice); reviewed.add(id);
      button.closest('.cf-choices').querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      button.closest('.cf-paper').classList.add('reviewed'); saveDraft(); updateControls();
    }));
    on('cf-expand', 'click', () => { expanded = !expanded; renderPapers(); });
    on('cf-mark-unsure', 'click', () => { for (const work of flow.works || []) if (!reviewed.has(work.id)) { selections.set(work.id, 'unsure'); reviewed.add(work.id); } renderPapers(); });
    on('cf-papers-next', 'click', event => action(event.currentTarget, async () => {
      if (!sameSelections()) { accept(await api('/selection', { flowId: flow.id, decisions: decisionsBody() })); cooldownUntil = 0; }
      if (verifiedEmail()) renderConfirm(); else renderEmail(); focusHeading();
    }));
    on('cf-back-papers', 'click', () => { emailValue = el('cf-email').value; renderPapers(); focusHeading(); });
    on('cf-back-email', 'click', () => { renderEmail(); focusHeading(); });
    on('cf-email-continue', 'click', () => { if (verifiedEmail()) { renderConfirm(); focusHeading(); } });
    on('cf-refresh-state', 'click', event => action(event.currentTarget, refreshState));
    on('cf-report-next', 'click', () => { reportSeen = true; renderPapers(); focusHeading(); });
    on('cf-email', 'input', () => { emailValue = el('cf-email').value; });
    on('cf-delivery', 'change', () => { deliveryValue = el('cf-delivery').value; updateControls(); });
    on('cf-email-form', 'submit', event => {
      event.preventDefault(); if (el('cf-send').disabled) return;
      action(el('cf-send'), async () => {
        emailValue = el('cf-email').value.trim(); deliveryValue = el('cf-delivery').value;
        const data = await api('/email/send', { flowId: flow.id, email: emailValue, delivery: deliveryValue }); accept(data);
        cooldownUntil = Date.now() + Math.max(1, Number(data.retryAfter) || 60) * 1000;
        challengeUntil = Date.now() + Math.max(1, Number(data.expiresIn) || 600) * 1000;
        el('cf-email-sent').textContent = data.delivery === 'preview' ? '本地模拟邮件已生成；不会向此邮箱发送邮件。' : '验证码已交给发信服务，请检查收件箱和垃圾邮件。';
        const preview = el('cf-preview'); preview.hidden = !(flow.mode === 'demo' && data.delivery === 'preview' && data.demoCode);
        if (!preview.hidden) preview.innerHTML = `<span>本地模拟邮件 · 仅演练</span><strong>${escape(data.demoCode)}</strong><small>10 分钟内有效。这不证明你拥有真实邮箱。</small>`;
        el('cf-code').focus();
      });
    });
    on('cf-verify', 'click', event => action(event.currentTarget, async () => {
      const code = el('cf-code').value.trim(); if (!/^\d{6}$/.test(code)) throw new Error('请输入邮件中的 6 位数字验证码。');
      accept(await api('/email/verify', { flowId: flow.id, code })); renderConfirm(); focusHeading();
    }));
    on('cf-code', 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); el('cf-verify').click(); } });
    on('cf-agreement', 'change', updateControls);
    el('claim-app').querySelectorAll('input[name=claim-network]').forEach(input => input.addEventListener('change', () => { anchorMode = input.value; saveDraft(); const button = el('cf-finalize'); if (button) button.textContent = anchorMode === 'mainnet' ? '确认 · 连接钱包存证 ↗' : '确认 · 本地存证并盖章 ↗'; }));
    on('cf-sign-mainnet', 'click', event => action(event.currentTarget, startMainnet));
    on('cf-retry-wallet', 'click', () => { submissionUncertain = false; saveDraft(); renderAnchorPending(); });
    on('cf-check-mainnet', 'click', event => action(event.currentTarget, checkMainnet));
    on('cf-submit-hash', 'click', event => action(event.currentTarget, async () => { const value = el('cf-transaction-hash').value.trim(); if (!/^0x[a-f0-9]{64}$/i.test(value)) throw new Error('请填写钱包中的完整 0x 交易哈希。'); pendingTxHash = value; saveDraft(); await checkMainnet(); }));
    on('cf-finalize', 'click', event => action(event.currentTarget, finalize));
    on('cf-download', 'click', downloadCertificate);
    on('cf-recheck', 'click', event => action(event.currentTarget, () => recheck(false)));
    on('cf-tamper', 'click', event => action(event.currentTarget, () => recheck(true)));
  }
  function reset() {
    epoch++; clearInterval(cooldownTimer); clearTimeout(pollingTimer);
    document.body.classList.remove('claim-active');
    const skip = document.querySelector('a.skip');
    if (skip) { skip.href = '#q'; skip.textContent = '跳到学者核验'; }
    flow = null; currentCertificate = null; step = 0; busy = false;
    selections = new Map(); reviewed = new Set(); expanded = false; cooldownUntil = 0; emailValue = ''; demoPreview = false;
    pendingTxHash = ''; submissionUncertain = false; restoredReceipt = false; draftView = ''; reportSeen = false; challengeUntil = 0;
    if (el('claim-app')) el('claim-app').innerHTML = '';
    el('claimbox')?.classList.add('hidden');
    if (token) resetPending = resetPending.catch(() => {}).then(() => raw('/reset', {})).catch(error => { if ([401, 403].includes(error.status)) token = ''; });
  }
  async function start(mode, authorId) {
    const version = epoch;
    await resetPending; if (version !== epoch) throw new StaleFlow();
    await session(); if (version !== epoch) throw new StaleFlow();
    const data = await api('/start', { mode, ...(authorId ? { authorId } : {}) }); accept(data);
    if (!flow?.id) throw new Error('未能创建认领流程，请重试。');
    selections = new Map((flow.decisions || []).map(item => [item.workId, item.decision])); reviewed = new Set();
    deliveryValue = mode === 'demo' ? 'preview' : 'smtp'; anchorMode = mode === 'demo' ? 'local' : 'mainnet';
    pendingTxHash = ''; submissionUncertain = false; restoredReceipt = false; reportSeen = mode !== 'demo'; draftView = mode === 'demo' ? 'report' : 'papers'; pinFlow(); saveDraft();
    if (mode === 'demo') try { chain = await api('/chain'); } catch (error) { if (error instanceof StaleFlow) throw error; }
  }
  function offer(author) {
    step = 0; progress(2, '体检报告已生成。接下来逐篇确认论文归属。');
    shell(`<div class="cf-offer"><div><h3>体检之后，把论文一篇篇核对清楚</h3><p>认领论文 → 验证邮箱 → 确认存证网络 → 生成凭证、盖章并核对交易。</p></div><button id="cf-start-public" class="cf-primary" type="button">继续 · 认领论文 →</button></div>`, '接下来，由你确认论文归属', '邮箱只验证控制权；自己的认领声明不会直接变成作者身份认证。');
    el('cf-start-public').addEventListener('click', event => action(event.currentTarget, async () => { await start('public', author.id); renderPapers(); focusHeading(); }));
  }
  function renderDemoReport() {
    step = 0; draftView = 'report'; saveDraft(); progress(1, '模拟材料体检已完成，论文归属等待你逐篇核对。');
    const works = flow.works || [], identifiers = new Set(works.map(work => work.id));
    const complete = works.filter(work => work.title && work.year && work.source).length;
    shell(`<div class="cf-demo-report"><span class="cf-network-pill">明确标注的模拟材料 · 不是实际学者评分</span><h3>${escape(flow.author.name)} · 案例体检报告</h3><p>读取 ${works.length} 篇固定案例材料，检查编号与基本字段。没有向真实学者的公开档案写入任何结果。</p><div class="cf-report-metrics"><div><strong>${works.length}</strong><span>篇待核对材料</span></div><div><strong>${complete}/${works.length}</strong><span>标题、年份、来源齐备</span></div><div><strong>${identifiers.size === works.length ? '无重复' : '需检查'}</strong><span>材料编号</span></div></div><ul>${works.map(work => `<li><b>${escape(work.title)}</b><span>${escape(work.hint || '请根据材料作出认领选择。')}</span></li>`).join('')}</ul><p class="cf-info">本报告只检查模拟材料是否齐备，不生成实际徐林森的学术信誉分。接下来亲自选择“是我的 / 不是我的 / 不确定”。</p><button id="cf-report-next" class="cf-primary" type="button">报告看完了，开始认领论文 →</button></div>`, '材料准备好了，由你来确认归属', '这一步是材料体检。作者身份与论文归属仍需要证据和独立核查。');
  }
  async function startDemo() {
    reset(); demoPreview = true; progress(0, '选择明确标注的模拟档案，走一遍完整流程。');
    shell(`<div class="cf-demo-welcome"><div class="cf-demo-orbit" aria-hidden="true"><img src="/brand/seal.png" alt=""></div><h3>选一个档案，完整走一遍</h3><p>演练使用固定模拟材料，不请求真实学者的论文，也不把模拟资料混入公开搜索结果。</p><button id="cf-demo-select" class="cf-demo-candidate" type="button"><span class="cf-avatar">徐</span><span><strong>徐林森 · 模拟认领案例</strong><small>演示研究所（虚构） · 模拟论文 · 可交互</small></span><span aria-hidden="true">→</span></button><a class="cf-demo-public" href="?q=%E5%BE%90%E6%9E%97%E6%A3%AE">查看“徐林森”的真实公开检索候选 →</a></div>`, '公开查询之外，还有一次完整演练', '从逐篇认领开始，亲手验证邮箱、确认声明，最后看到本地链产生新区块。');
    focusHeading();
    el('cf-demo-select').addEventListener('click', event => action(event.currentTarget, async () => {
      await start('demo'); const version = epoch; progress(1, '读取固定模拟材料，生成可核对的材料体检报告。');
      shell('<ol id="cf-demo-log" class="cf-demo-log" aria-live="polite"><li>已选择明确标注的模拟档案。</li></ol>', '正在准备你的演练材料', '以下步骤读取本地固定案例，不是对真实学者的外部检索。');
      setBusy(true);
      for (const text of [`载入 ${flow.works.length} 篇虚构论文，保留每篇材料编号。`, '已准备三种归属选择：是我的、不是我的、不确定。', '下一步由你核对，系统不会替你认领。']) { await delay(420); if (version !== epoch) throw new StaleFlow(); el('cf-demo-log').insertAdjacentHTML('beforeend', `<li>${escape(text)}</li>`); }
      await delay(240); if (version !== epoch) throw new StaleFlow(); renderDemoReport(); focusHeading();
    }));
  }
  window.ClaimFlow = Object.freeze({ reset, offer, startDemo, restore, progress, canLeave: () => !walletRequestOpen });
})();
