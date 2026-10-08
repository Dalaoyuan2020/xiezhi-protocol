(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  if (!commonJS && root.ClaimExperience) return;
  const api = factory(commonJS ? require('./claim-core.js') : root.ClaimCore);
  if (commonJS) module.exports = api;
  else root.ClaimExperience = Object.assign(api, api.install(root.document, root));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';
  const frames = Object.freeze([
    { step: 1, kind: 'search', title: '先搜名字，不急着认人', text: '在首页输入英文名 Zhiyuan Lyu，点击搜索箭头。核对候选与体检报告后，再逐篇认领。', material: '准备：姓名、英文名或作者编号。', action: '点击搜索', duration: 4000 },
    { step: 1, kind: 'profile', title: '选对机构档案', text: '同名的 Zhiyuan Lyu 不止一位。比对机构与研究方向，点河海大学这份档案。', material: '准备：机构官网、本人公开署名。', action: '选择河海大学档案', duration: 4500 },
    { step: 1, kind: 'own', title: '这一篇，是我写的', text: '这篇 2026 年的墒情预印本，被挂到了同名学者名下。署名单位是河海大学，点“是本人论文”认领回来。', material: '准备：原文署名、单位与 DOI。', action: '是本人论文', duration: 4500 },
    { step: 1, kind: 'exclude', title: '这一篇，同名但不是我', text: '另一位 Zhiyuan Lyu 的三维网格论文，单位和方向都不同。点“同名，排除”，不收入凭证。', material: '核对：年份、研究方向、署名单位。', action: '同名，排除', duration: 4500 },
    { step: 1, kind: 'unsure', title: '不确定，就先待核对', text: '一条只有姓名、没有单位的记录（示例）。点“暂待核对”，不把不确定当认领。', material: '待补：原文署名或合作者确认。', action: '暂待核对', duration: 4500 },
    { step: 2, kind: 'email', title: '准备本人可收信的邮箱', text: '推荐使用与机构一致的邮箱（这里打码显示）。机构域名是核对线索，验证码只验证邮箱控制权。', material: '准备：本人可收信的邮箱与机构线索。', action: '核对邮箱线索', duration: 4500 },
    { step: 2, kind: 'send', title: '点发送，再去收信', text: '本教程使用虚拟收件箱。线上真实发信尚未开放；本地或自部署需先配置并验证 SMTP 服务。', material: '本幕只投递虚拟收件箱，不发真实邮件。', action: '发送模拟验证码', duration: 4000 },
    { step: 2, kind: 'inbox', title: '在收件箱找到六位码', text: '查看虚拟收件箱，把六位验证码带回页面。固定码只用于本演示。', material: '真实模式：查本人收件箱及垃圾邮件。', action: '带着验证码返回', duration: 4500 },
    { step: 2, kind: 'verify', title: '填六位码，点校验', text: '填写刚收到的数字并点“校验验证码”。邮箱或论文选择一改，就需重验。', material: '先发送、再校验；验证码有有效期。', action: '校验验证码', duration: 4000 },
    { step: 3, kind: 'ack', title: '确认范围，再生成凭证', text: '只收入已认领的 1 篇。阅读证明范围，勾选确认，再点生成凭证。', material: '邮箱控制权一致，不保证论文作者身份。', action: '确认并生成演示凭证', duration: 4500 },
    { step: 3, kind: 'stamp', title: '落印，是流程的结束', text: '印章下落、压印、墨迹扩散。这张凭证仅演示，非真实认证。', material: '现在可点“亲手操作”，从搜索走完一遍。', action: '亲手操作', duration: 5500 }
  ].map(Object.freeze));

  // The guide walks through the team lead's own public record (with consent):
  // one preprint misattributed to a namesake, one namesake paper, one example.
  const GUIDE_EMAIL = 'x***@hhu.edu.cn';
  const GUIDE_WORKS = Object.freeze({
    own: { label: '2026 · SSRN 预印本', title: 'Information requirements for short-term root-zone soil moisture forecasting', clue: 'Agent 提示：错挂到同名学者名下（置信度中）', after: '认领回来，纳入 1 篇' },
    exclude: { label: '同名学者的论文', title: '三维网格生成方向的一篇论文', clue: '单位和研究方向都不同', after: '不纳入凭证；保留明确选择记录' },
    unsure: { label: '示例记录', title: '一条缺少署名单位的会议记录', clue: '只有姓名，没有单位，暂时无法确认', after: '不纳入凭证；补到原文署名再核对' }
  });

  function createPlayer(options = {}) {
    const clock = options.now || Date.now;
    const later = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    const changed = options.onChange || (() => {});
    let open = false, playing = false, index = 0, reducedMotion = Boolean(options.reducedMotion), revision = 0;
    let timer = null, deadline = 0, remaining = frames[0].duration;
    const getState = () => ({ open, playing, index, reducedMotion, revision, frame: frames[index] });
    const emit = () => changed(getState());
    function clear() { if (timer !== null) cancel(timer); timer = null; }
    function schedule() {
      clear();
      if (!open || !playing) return;
      deadline = clock() + remaining;
      timer = later(() => {
        timer = null;
        if (!open || !playing) return;
        if (index === frames.length - 1) { playing = false; remaining = frames[index].duration; emit(); return; }
        index++; remaining = frames[index].duration; emit(); schedule();
      }, remaining);
    }
    function go(target) {
      if (!open) return;
      clear(); playing = false; index = Math.max(0, Math.min(frames.length - 1, target));
      revision++; remaining = frames[index].duration; emit();
    }
    function pause() {
      if (!open || !playing) return;
      remaining = Math.max(0, deadline - clock()); clear(); playing = false; emit();
    }
    return {
      getState,
      open() { if (open) return false; open = true; index = 0; revision++; remaining = frames[0].duration; playing = !reducedMotion; emit(); schedule(); return true; },
      close() { if (!open) return; clear(); open = false; playing = false; emit(); },
      pause,
      resume() { if (!open || playing) return; playing = true; emit(); schedule(); },
      next() { go(index + 1); }, previous() { go(index - 1); }, go,
      replay() { if (!open) return; clear(); index = 0; revision++; remaining = frames[0].duration; playing = !reducedMotion; emit(); schedule(); },
      setReducedMotion(value) { reducedMotion = Boolean(value); if (reducedMotion) pause(); emit(); }
    };
  }

  const SEEN_KEY = 'xiezhi:guide:seen';

  function install(doc, win) {
    // Both page editions use the same production claim flow and same-origin links.
    function demoUrl() {
      const url = new URL('/live/', win.location.href);
      url.searchParams.set('demo', 'claim-xu');
      const network = new URLSearchParams(win.location.search).get('network');
      if (network === 'mainnet' || network === 'testnet') url.searchParams.set('network', network);
      return url.pathname + url.search;
    }
    let dialog, player, opener, fitted, observer, autoOpenTimer, previousFrame = '', fitRequest = 0;
    const el = (tag, className, text) => { const n = doc.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
    const button = (text, fn, className = 'claim-button claim-button--quiet') => { const n = el('button', className, text); n.type = 'button'; n.addEventListener('click', fn); return n; };
    function sceneButton(text, fn = () => player.next()) { return button(text, fn, 'claim-button claim-demo-target'); }
    function fitScene() {
      if (!dialog || !dialog.open || !fitted) return;
      const stage = dialog.querySelector('.claim-demo-stage');
      // Responsive type/spacing handles normal low screens. Scale only the full
      // scene as a final safety net for unusually small or zoomed viewports.
      const room = Math.max(1, stage.clientHeight - 12);
      const height = Math.max(1, fitted.scrollHeight);
      fitted.style.setProperty('--claim-scene-scale', String(Math.min(1, room / height)));
    }
    function requestFit() { win.cancelAnimationFrame(fitRequest); fitRequest = win.requestAnimationFrame(fitScene); }
    function renderArt(frame) {
      const art = el('div', 'claim-demo-art claim-demo-art--' + frame.kind);
      const note = text => el('p', 'claim-demo-note', text);
      if (frame.kind === 'search') {
        art.append(el('span', 'claim-label', '本人认领 · 模拟界面'));
        const form = el('div', 'claim-demo-field'); form.append(el('span', '', '搜索姓名'), el('strong', 'claim-type', 'Zhiyuan Lyu'));
        art.append(form, sceneButton('搜索档案'), note('不自动取第一个同名结果'));
      } else if (frame.kind === 'profile') {
        const match = el('div', 'claim-demo-mini-card claim-demo-match');
        match.append(el('strong', '', 'Zhiyuan Lv · 河海大学'), note('管道机器人 / 土壤墒情预测'), el('p', 'claim-demo-domain', 'https://www.hhu.edu.cn'));
        art.append(match, el('p', 'claim-demo-other', '另一位 Zhiyuan Lyu · 其他机构 / 研究方向不同'), sceneButton('核对机构，选择河海大学'));
      } else if (['own', 'exclude', 'unsure'].includes(frame.kind)) {
        const work = GUIDE_WORKS[frame.kind];
        art.append(el('span', 'claim-label', work.label), el('h3', '', work.title), note('线索：' + work.clue));
        const choices = el('div', 'claim-demo-options');
        ['是本人论文', '同名，排除', '暂待核对'].forEach(text => {
          if (text === frame.action) choices.append(sceneButton(text));
          else choices.append(el('span', 'claim-demo-choice', text));
        });
        art.append(choices, note(work.after));
      } else if (frame.kind === 'email') {
        art.append(el('span', 'claim-label', '河海大学 · 官网域名'), el('p', 'claim-demo-domain', 'https://www.hhu.edu.cn'));
        const email = el('div', 'claim-demo-field'); email.append(el('span', '', '本人机构邮箱'), el('strong', 'claim-type claim-demo-domain', GUIDE_EMAIL));
        art.append(email, sceneButton('确认邮箱，下一步'), note('机构线索待独立核查；动画演示，不发信'));
      } else if (frame.kind === 'send') {
        art.append(el('span', 'claim-label', '已逐篇核对：1 本人 / 1 排除 / 1 待核对'), el('p', 'claim-demo-domain', GUIDE_EMAIL), sceneButton('发送模拟验证码'));
        const envelope = el('div', 'claim-demo-mail', '模拟邮件 → 虚拟收件箱');
        art.append(envelope, note('动画演示，不会真的发信'));
      } else if (frame.kind === 'inbox') {
        art.append(el('span', 'claim-label', '虚拟收件箱 · 仅演示'), el('p', 'claim-demo-domain', '收件人：' + GUIDE_EMAIL), el('strong', 'claim-demo-code claim-type', Core.DEMO_CODE), note('六位验证码 · 模拟有效期 10 分钟'), sceneButton('记住六位码，返回填写'));
      } else if (frame.kind === 'verify') {
        art.append(el('span', 'claim-label', '验证码已发送到虚拟收件箱'), el('div', 'claim-demo-code claim-demo-field claim-type', Core.DEMO_CODE), sceneButton('校验验证码'), note('校验后才可生成；改邮箱或论文须重验'));
      } else if (frame.kind === 'ack') {
        art.append(el('span', 'claim-label', '模拟验证码校验通过'), el('strong', '', '1 篇认领 · 2026'), note('土壤墒情预测预印本 · 从同名学者名下认领回来'));
        art.append(el('p', 'claim-demo-check', '已确认：邮箱控制权不等于作者身份'), sceneButton('生成演示凭证'));
      } else {
        art.classList.add('claim-demo-paper');
        art.append(el('span', 'claim-label', '演示 · 非真实认证'), el('h3', 'claim-certificate-title', Core.SEAL_TEXT), el('p', '', '吕志远 · 河海大学'), note('2026 · 土壤墒情预测预印本'), note('认领方式：机构邮箱验证'));
        const stamp = el('div', 'claim-stamp'); stamp.setAttribute('aria-label', Core.SEAL_TEXT);
        stamp.append(el('span', 'claim-ink'), el('span', 'claim-seal', Core.SEAL_TEXT)); art.append(stamp);
      }
      return art;
    }
    function render(state) {
      if (!dialog) return;
      dialog.dataset.playing = String(state.playing);
      dialog.dataset.reducedMotion = String(state.reducedMotion);
      if (!state.open) return;
      const key = state.index + ':' + state.revision;
      dialog.dataset.motionPaused = String(!state.playing && key === previousFrame);
      const frame = state.frame;
      if (key !== previousFrame) {
        previousFrame = key;
        fitted.replaceChildren();
        fitted.style.setProperty('--claim-scene-scale', '1');
        dialog.style.setProperty('--claim-frame-duration', frame.duration + 'ms');
        const copy = el('div', 'claim-demo-copy');
        copy.append(el('p', 'claim-eyebrow', '第 ' + frame.step + ' 步 · 第 ' + (state.index + 1) + ' / ' + frames.length + ' 幕'));
        const title = el('h3', '', frame.title); title.id = 'claim-demo-scene-title';
        copy.append(title, el('p', '', frame.text), el('p', 'claim-demo-material', frame.material));
        fitted.append(copy, renderArt(frame));
        const meter = dialog.querySelector('.claim-demo-progress'); meter.replaceChildren(el('span'));
        const status = dialog.querySelector('.claim-demo-announcement');
        status.setAttribute('aria-live', state.playing ? 'off' : 'polite');
        status.textContent = '第 ' + frame.step + ' 步，第 ' + (state.index + 1) + ' 幕：' + frame.title;
        requestFit();
      }
      dialog.querySelectorAll('[data-demo-step]').forEach(n => n.setAttribute('aria-current', Number(n.dataset.demoStep) === frame.step ? 'step' : 'false'));
      const play = dialog.querySelector('[data-demo-play]');
      play.textContent = state.playing ? '暂停' : state.index === frames.length - 1 ? '继续停留' : '继续';
      play.setAttribute('aria-label', state.playing ? '暂停自动播放' : '继续自动播放');
      play.setAttribute('aria-pressed', String(state.playing));
      dialog.querySelector('[data-demo-prev]').disabled = state.index === 0;
      dialog.querySelector('[data-demo-next]').disabled = state.index === frames.length - 1;
      dialog.querySelector('.claim-demo-position').textContent = (state.index + 1) + ' / ' + frames.length;
    }
    function cleanup() {
      // A queued close event can arrive after this same dialog was reopened.
      if (dialog.open) return;
      player.close();
      doc.documentElement.classList.remove('claim-demo-open');
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
      opener = null;
    }
    function closeDemo() { if (dialog && dialog.open) { dialog.close(); cleanup(); } }
    function build() {
      dialog = el('dialog', 'claim-demo'); dialog.id = 'claim-demo';
      dialog.setAttribute('aria-labelledby', 'claim-demo-title');
      dialog.setAttribute('aria-describedby', 'claim-demo-disclaimer');
      dialog.setAttribute('aria-modal', 'true');
      const shell = el('div', 'claim-demo-shell');
      const head = el('header', 'claim-demo-head');
      const brand = el('a', 'claim-demo-brand'); brand.href = '/ui/';
      brand.setAttribute('aria-label', '灋廌覈鑒 首页');
      const logo = el('span', 'claim-demo-logo'); logo.setAttribute('aria-hidden', 'true');
      logo.append(el('span', '', '灋廌'), el('span', '', '覈鑒'));
      const wordmark = el('span', 'claim-demo-wordmark'); wordmark.append(el('strong', '', '灋廌覈鑒'), el('small', '', '学术信誉链 · Xiezhi'));
      brand.append(logo, wordmark);
      const title = el('h2', '', '獬豸三步走'); title.id = 'claim-demo-title';
      const badge = el('span', 'claim-label', '演示 · 非真实认证');
      // The board also points to the two everyday entries: scholars and papers.
      const nav = el('nav', 'claim-demo-nav'); nav.setAttribute('aria-label', '主要功能');
      const scholars = el('a', 'claim-demo-chip', '搜学者'); scholars.href = '/ui/'; scholars.dataset.icon = 'scholar';
      const papers = el('a', 'claim-demo-chip', '搜文章'); papers.href = '/ui/papers.html'; papers.dataset.icon = 'paper';
      nav.append(scholars, papers);
      const close = button('关闭', closeDemo); close.setAttribute('aria-label', '关闭教程（Esc）'); close.autofocus = true;
      head.append(brand, title, badge, nav, close);
      const steps = el('ol', 'claim-demo-steps'); steps.setAttribute('aria-label', '教程步骤');
      ['搜索档案并逐篇核对', '本人邮箱验证', '生成凭证盖章'].forEach((text, i) => { const li = el('li', '', String(i + 1).padStart(2, '0') + ' ' + text); li.dataset.demoStep = String(i + 1); steps.append(li); });
      const stage = el('main', 'claim-demo-stage'); stage.setAttribute('aria-labelledby', 'claim-demo-scene-title');
      fitted = el('div', 'claim-demo-fit'); stage.append(fitted);
      const foot = el('footer', 'claim-demo-foot');
      const controls = el('div', 'claim-demo-controls');
      const prev = button('上一步', () => player.previous()); prev.dataset.demoPrev = '';
      const play = button('暂停', () => player.getState().playing ? player.pause() : player.resume()); play.dataset.demoPlay = '';
      const next = button('下一步', () => player.next()); next.dataset.demoNext = '';
      const replay = button('重播', () => player.replay());
      const tryLink = el('a', 'claim-button', '亲手操作'); tryLink.href = demoUrl(); tryLink.dataset.demoTry = ''; tryLink.setAttribute('aria-label', '亲手体验模拟认领');
      controls.append(prev, play, next, replay, tryLink, el('span', 'claim-demo-position'));
      const disclaimer = el('p', 'claim-demo-disclaimer', '以吕志远公开档案演示核对思路，邮箱打码；本教程不发信、不上链。「亲手操作」进入徐林森虚构案例与本地模拟链。邮箱控制权不等于作者身份。'); disclaimer.id = 'claim-demo-disclaimer';
      const progress = el('div', 'claim-demo-progress'); progress.setAttribute('aria-hidden', 'true');
      const announcement = el('p', 'claim-sr claim-demo-announcement'); announcement.setAttribute('role', 'status');
      foot.append(controls, disclaimer, progress, announcement); shell.append(head, steps, stage, foot); dialog.append(shell); doc.body.append(dialog);
      // Keep full motion in the product; playback can still be paused explicitly.
      player = createPlayer({ onChange: render });
      dialog.addEventListener('cancel', e => { e.preventDefault(); closeDemo(); });
      dialog.addEventListener('close', cleanup);
      dialog.addEventListener('keydown', e => {
        if (e.altKey || e.ctrlKey || e.metaKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); player.next(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); player.previous(); }
      });
      doc.addEventListener('visibilitychange', () => { if (doc.hidden) player.pause(); });
      win.addEventListener('resize', requestFit);
      if (win.visualViewport) win.visualViewport.addEventListener('resize', requestFit);
      if (win.ResizeObserver) { observer = new win.ResizeObserver(requestFit); observer.observe(stage); observer.observe(fitted); }
      if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(requestFit);
    }
    function openDemo(trigger) {
      win.clearTimeout(autoOpenTimer); autoOpenTimer = undefined;
      // A menu can dispatch the custom event and bubble the same click.
      // Return before touching focus, frame, animation or timers in that case.
      if (dialog && dialog.open) return dialog;
      if (!doc.body || !Core) return null;
      if (!dialog) build();
      if (typeof dialog.showModal !== 'function') { win.location.href = demoUrl(); return null; }
      dialog.querySelector('[data-demo-try]').href = demoUrl();
      opener = trigger && typeof trigger.focus === 'function' ? trigger : doc.activeElement;
      dialog.showModal(); doc.documentElement.classList.add('claim-demo-open');
      try { win.localStorage.setItem(SEEN_KEY, '1'); } catch (_) { /* Manual help works without storage. */ }
      player.open(); requestFit(); return dialog;
    }
    doc.addEventListener('click', event => {
      const target = event.target.closest && event.target.closest('[data-claim-demo]');
      if (!target) return;
      event.preventDefault(); openDemo(target);
    });
    doc.addEventListener('claim-demo:open', event => openDemo(event.detail && event.detail.trigger));
    // First visit opens the guide once. ?guide=1 forces it, ?guide=0 and the
    // hands-on demo page skip it; without browser storage it never auto-opens.
    function firstVisit() {
      const params = new URLSearchParams(win.location.search || '');
      const pathname = new URL(win.location.href).pathname;
      if (/\/(?:workbench\/)?live(?:\/|$)/.test(pathname)) return false;
      if (params.get('guide') === '0' || params.get('demo') === '1') return false;
      try {
        const seen = win.localStorage.getItem(SEEN_KEY);
        // Probe both read and write access; a blocked store must not cause repeat popups.
        win.localStorage.setItem(SEEN_KEY, seen || '');
        return params.get('guide') === '1' || !seen;
      } catch (error) { return false; }
    }
    if (firstVisit()) autoOpenTimer = win.setTimeout(() => openDemo(), 400);
    return { openDemo, closeDemo };
  }
  return { frames, createPlayer, install };
});
