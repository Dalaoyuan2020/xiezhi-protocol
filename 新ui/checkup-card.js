/* Scholar Checkup · Screen 03. No runtime dependencies or HTML injection. */
(function (global) {
  'use strict';

  const mounted = new WeakMap();
  let sequence = 0;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const fallbackLabels = ['身份清晰度', '撤稿与更正', '开放程度', '同领域影响力', '产出节奏'];
  const shortLabels = ['身份', '更正', '开放', '影响', '节奏'];
  const fallbackColors = ['#2f6b57', '#346b7a', '#526f93', '#72638c', '#6c7b45'];
  function colorsFor(node) {
    const style = global.getComputedStyle ? global.getComputedStyle(node) : null;
    return fallbackColors.map((fallback, index) => {
      const token = style?.getPropertyValue('--sc-dim-' + (index + 1))?.trim() || '';
      return /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(token) ? token : fallback;
    });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgElement(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function number(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : (fallback || 0);
  }

  // One content model, with a real complementary aside on wide screens and a native modal on small ones.
  function evidenceModel(profile, options) {
    if (!global.ScholarEvidenceCore) throw new Error('证据组件尚未加载。');
    return global.ScholarEvidenceCore.createModel(profile, { ...options, rules: global.ScholarCheckupCore?.RULES });
  }

  function evidencePanel(host, trigger, onDismiss, options) {
    options = options || {};
    const layoutHost = options.layoutHost || host;
    const titleId = 'sc-evidence-title-' + (++sequence);
    const panelId = 'sc-evidence-' + sequence;
    const head = element('div', 'sc-card__dialog-head');
    const group = element('div', 'sc-evidence-panel__heading');
    const eyebrow = element('p', 'sc-card__eyebrow');
    const title = element('h3', '');
    title.id = titleId;
    group.append(eyebrow, title);
    const close = element('button', 'sc-card__button sc-card__button--secondary', '关闭 ×');
    close.type = 'button';
    close.dataset.readerEvidenceClose = 'true';
    close.setAttribute('aria-label', '关闭证据面板');
    head.append(group, close);
    const content = element('div', 'sc-card__dialog-content');
    const navigation = element('nav', 'sc-card__dialog-nav');
    navigation.setAttribute('aria-label', '逐项查看证据');
    let container = null;
    let primary = null;
    let destroyed = false;
    let opened = false;
    let presentation = '';
    let containerDisposers = [];
    const disposers = [];
    let media = null;
    try { if (global.matchMedia) media = global.matchMedia('(min-width: 1280px)'); } catch (_) { /* use viewport fallback */ }
    function wide() { return media ? media.matches : Number(global.innerWidth) >= 1280; }
    function on(type, target, handler, local) {
      target.addEventListener(type, handler);
      (local ? containerDisposers : disposers).push(() => target.removeEventListener(type, handler));
    }
    function includes(node, target) {
      if (!node || !target) return false;
      if (typeof node.contains === 'function') return node.contains(target);
      for (let current = target; current; current = current.parentNode) if (current === node) return true;
      return false;
    }
    function usableTrigger() {
      if (!trigger?.isConnected || trigger.disabled) return false;
      for (let current = trigger; current; current = current.parentNode) if (current.hidden) return false;
      return true;
    }
    function releaseLayout() {
      if (!primary) return;
      Array.from(primary.childNodes || primary.children).forEach(node => layoutHost.append(node));
      primary.remove();
      primary = null;
      layoutHost.classList.toggle('sc-evidence-host', false);
      delete layoutHost.dataset.readerEvidenceLayout;
    }
    function createLayout() {
      if (primary) return;
      primary = element('div', 'sc-evidence-primary');
      Array.from(layoutHost.childNodes || layoutHost.children).filter(node => node !== container).forEach(node => primary.append(node));
      layoutHost.append(primary);
      layoutHost.classList.add('sc-evidence-host');
      layoutHost.dataset.readerEvidenceLayout = 'side';
    }
    function present() {
      if (!opened || destroyed) return;
      const next = wide() ? 'side' : 'modal';
      if (next === presentation) return;
      const active = document.activeElement;
      const panelHadFocus = includes(container, active);
      containerDisposers.forEach(dispose => dispose());
      containerDisposers = [];
      const previous = container;
      if (previous?.open && typeof previous.close === 'function') previous.close();
      if (next === 'modal') releaseLayout();
      const node = element(next === 'side' ? 'aside' : 'dialog', 'sc-evidence-panel');
      container = node;
      node.id = panelId;
      node.dataset.readerEvidence = 'true';
      node.dataset.presentation = next;
      node.dataset.profileId = options.profileId || '';
      node.setAttribute('aria-labelledby', titleId);
      if (next === 'side') node.setAttribute('role', 'complementary');
      else node.setAttribute('aria-modal', 'true');
      node.append(head, navigation, content);
      if (previous) previous.remove();
      presentation = next;
      if (next === 'side') createLayout();
      layoutHost.append(node);
      on('keydown', node, event => {
        if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
        else if (options.onNavigate && !['SELECT', 'INPUT', 'TEXTAREA'].includes(event.target?.tagName) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault(); options.onNavigate(event.key === 'ArrowLeft' ? -1 : 1);
        }
      }, true);
      if (next === 'modal') {
        on('cancel', node, event => { event.preventDefault(); dismiss(); }, true);
        on('close', node, dismiss, true);
        on('click', node, event => {
          if (event.target !== node) return;
          const rect = node.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
        }, true);
        node.showModal();
      }
      if (panelHadFocus && active?.isConnected) active.focus({ preventScroll: true });
      else if (!previous || next === 'modal') close.focus({ preventScroll: true });
      if (!previous && next === 'side') node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      if (options.onPresentation) options.onPresentation(next);
    }
    function destroy(restoreFocus) {
      if (destroyed) return;
      destroyed = true;
      disposers.forEach(dispose => dispose());
      containerDisposers.forEach(dispose => dispose());
      if (container?.open && typeof container.close === 'function') container.close();
      container?.remove();
      releaseLayout();
      trigger?.setAttribute('aria-expanded', 'false');
      if (restoreFocus && usableTrigger()) trigger.focus({ preventScroll: true });
    }
    function dismiss() { if (onDismiss) onDismiss(true); else destroy(true); }
    on('click', close, dismiss);
    if (global.addEventListener) on('keydown', global, event => {
      if (presentation === 'side' && event.key === 'Escape' && includes(layoutHost, event.target)) { event.preventDefault(); dismiss(); }
    });
    if (media?.addEventListener) {
      media.addEventListener('change', present);
      disposers.push(() => media.removeEventListener('change', present));
    } else if (media?.addListener) {
      media.addListener(present);
      disposers.push(() => media.removeListener(present));
    } else if (global.addEventListener) on('resize', global, present);
    return { get node() { return container; }, eyebrow, title, content, navigation, destroy,
      setTrigger(next) { trigger?.setAttribute('aria-expanded', 'false'); trigger = next; trigger?.setAttribute('aria-expanded', 'true'); trigger?.setAttribute('aria-controls', panelId); },
      open() { opened = true; trigger?.setAttribute('aria-controls', panelId); trigger?.setAttribute('aria-expanded', 'true'); present(); } };
  }

  function inputTable(rows) {
    const table = element('table', 'sc-evidence-table');
    table.append(element('caption', '', '证据输入 · 原始字段 / 摘要值 / 缺失输入'));
    const head = element('thead', '');
    const header = element('tr', '');
    ['字段或输入', '快照保存值'].forEach(label => { const cell = element('th', '', label); cell.setAttribute('scope', 'col'); header.append(cell); });
    head.append(header);
    const body = element('tbody', '');
    const labels = { raw: '原始字段', summary: '文字摘要', missing: '缺失输入' };
    rows.forEach(row => {
      const tr = element('tr', ''); tr.dataset.evidenceStatus = row.status;
      const label = element('th', '', row.label); label.setAttribute('scope', 'row');
      label.append(element('span', 'sc-evidence-table__status', labels[row.status]));
      const cell = element('td', '', row.value);
      tr.append(label, cell); body.append(tr);
    });
    table.append(head, body);
    return table;
  }

  function sourcesSection(model, currentUrl) {
    const source = element('section', 'sc-evidence-sources');
    source.dataset.evidenceSources = 'true';
    source.append(element('h4', '', '来源、时间与统计范围'), element('p', '', model.source),
      element('p', 'sc-card__dialog-meta', '快照日期：' + model.snapshotDate + ' · 非实时查询'));
    if (model.fetchedAt) source.append(element('p', 'sc-card__dialog-meta', '获取时间：' + model.fetchedAt));
    const saved = element('a', 'sc-card__source-link', '打开 ' + model.snapshotLabel + ' ↗');
    saved.dataset.evidenceSource = 'snapshot'; saved.href = model.snapshotHref; saved.target = '_blank'; saved.rel = 'noopener noreferrer';
    source.append(saved);
    if (model.kind === 'scored') source.append(element('p', 'sc-card__dialog-meta', '规则版本：' + model.ruleVersion + ' · ' + model.worksScope));
    source.append(element('p', 'sc-card__dialog-meta', model.scopeLimit));
    if (currentUrl) {
      const link = element('a', 'sc-card__source-link', '打开 OpenAlex 当前记录 ↗');
      link.dataset.evidenceSource = 'current'; link.href = currentUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      source.append(link, element('p', 'sc-card__dialog-meta', '外部链接读取的是当前记录，可能与本地快照不同。'));
    } else source.append(element('p', 'sc-card__dialog-meta', model.synthetic ? '虚构案例不提供外部学者记录链接。' : '快照未提供与此档案匹配的原始记录链接。'));
    return source;
  }

  function mountCandidateEvidence(root, candidate, options) {
    if (!root || typeof root.replaceChildren !== 'function') throw new TypeError('Candidate evidence requires a root element.');
    if (mounted.has(root)) mounted.get(root).destroy();
    options = options || {};
    const model = evidenceModel(candidate || {}, options);
    let panel = null;
    let destroyed = false;
    let anchor = 0;
    root.replaceChildren();
    root.classList.add('sc-card');
    const trigger = element('button', 'sc-card__button sc-card__button--primary', '查看档案证据');
    trigger.type = 'button'; trigger.dataset.readerEvidenceOpen = 'candidate'; trigger.setAttribute('aria-expanded', 'false');
    const notice = element('p', 'sc-card__dialog-meta', '来源与身份线索可查看 · 当前没有五维评分');
    root.append(trigger, notice);
    function dismiss(restoreFocus) {
      if (panel) { const previous = panel; anchor = previous.content.scrollTop || 0; panel = null; previous.destroy(restoreFocus); }
    }
    function open() {
      if (destroyed || panel) return;
      panel = evidencePanel(root, trigger, dismiss, { layoutHost: options.layoutHost, profileId: model.id, onPresentation: () => panel.node.style.setProperty('--dimension-color', colorsFor(root)[0]) });
      panel.eyebrow.textContent = '档案证据 / 未评分'; panel.title.textContent = model.name;
      panel.navigation.hidden = true;
      const body = element('div', 'sc-card__dialog-body');
      const identity = element('section', 'sc-card__evidence-highlight');
      identity.append(element('h4', '', '身份与单位线索'), inputTable(model.identity));
      if (model.affiliations.length) {
        const list = element('ul', 'sc-evidence-affiliations');
        model.affiliations.forEach(item => list.append(element('li', '', item.name + (item.years.length ? ' · 年份：' + item.years.join('、') : ' · 年份未提供'))));
        identity.append(element('p', 'sc-card__dialog-meta', '公开快照中的历史署名单位：'), list);
      }
      if (model.identityNote) identity.append(element('p', '', model.identityNote));
      const note = element('section', '');
      note.append(element('h4', '', '记录与局限'), element('p', '', model.note || '快照没有进一步的身份核验说明。'));
      if (model.topics.length) note.append(element('p', '', '公开库研究方向：' + model.topics.join(' / ')));
      note.append(element('p', 'sc-card__dialog-limit', '当前没有这位候选的完整五维评分；身份线索需要结合原始记录核对。'));
      body.append(identity, note, sourcesSection(model, model.authorUrl), element('p', 'sc-card__dialog-limit', model.limit));
      panel.content.append(body);
      panel.open(); panel.node.style.setProperty('--dimension-color', colorsFor(root)[0]);
      panel.content.scrollTop = anchor;
    }
    trigger.addEventListener('click', open);
    const instance = { dismissEvidence: dismiss, destroy() { if (destroyed) return; destroyed = true; dismiss(false); trigger.removeEventListener('click', open); root.replaceChildren(); mounted.delete(root); } };
    mounted.set(root, instance);
    return instance;
  }

  function mount(root, normalized, options) {
    if (!root || typeof root.replaceChildren !== 'function') throw new TypeError('ScholarCheckupCard.mount requires a root element.');
    if (mounted.has(root)) mounted.get(root).destroy();
    options = options || {};
    const instanceId = 'sc-card-' + (++sequence);
    const frames = new Set();
    let disposers = [];
    let dialogDisposers = [];
    let data = normalized || {};
    let closed = false;
    const reading = { index: 0, selected: false, anchors: new Map() };
    let currentPanel = null;
    let clearHighlight = null;
    let replayAnimation = () => {};

    function on(target, event, handler, dialogEvent) {
      target.addEventListener(event, handler);
      (dialogEvent ? dialogDisposers : disposers).push(() => target.removeEventListener(event, handler));
    }

    function schedule(callback) {
      const frame = global.requestAnimationFrame((time) => {
        frames.delete(frame);
        callback(time);
      });
      frames.add(frame);
    }

    function stopAnimation() {
      frames.forEach((frame) => global.cancelAnimationFrame(frame));
      frames.clear();
    }

    function dismissDialog(restoreFocus) {
      dialogDisposers.forEach((dispose) => dispose());
      dialogDisposers = [];
      if (currentPanel) { reading.anchors.set(reading.index, currentPanel.content.scrollTop || 0); currentPanel.destroy(restoreFocus); }
      currentPanel = null;
      if (clearHighlight) clearHighlight(restoreFocus);
      clearHighlight = null;
    }

    function cleanup() {
      stopAnimation();
      dismissDialog(false);
      disposers.forEach((dispose) => dispose());
      disposers = [];
      replayAnimation = () => {};
    }

    function button(label, className, callback, dialogEvent) {
      const node = element('button', className, label);
      node.type = 'button';
      on(node, 'click', callback, dialogEvent);
      return node;
    }

    function render() {
      cleanup();
      root.replaceChildren();
      const dimensionColors = colorsFor(root);
      const dims = fallbackLabels.map((label, index) => {
        const original = Array.isArray(data.dims) ? data.dims[index] || {} : {};
        return { ...original, label: original.label || label, value: Math.min(20, Math.max(0, number(original.value))), max: 20 };
      });
      const score = Math.round(dims.reduce((sum, dim) => sum + dim.value, 0) * 10) / 10;
      const synthetic = Boolean(data.synthetic);
      const isClaimed = Boolean(data.claimSimulation);
      const card = element('section', 'sc-card');
      card.setAttribute('aria-labelledby', instanceId + '-title');
      card.dataset.synthetic = String(synthetic);

      const top = element('header', 'sc-card__header');
      const introduction = element('div', 'sc-card__identity');
      const eyebrow = element('div', 'sc-card__eyebrow');
      eyebrow.append(element('span', 'sc-card__step', '02'), element('span', '', 'EVIDENCE PROFILE / 体检卡'));
      const title = element('h2', 'sc-card__name', data.name || '学者快照');
      title.id = instanceId + '-title';
      introduction.append(eyebrow, title, element('p', 'sc-card__case', data.label || '公开学术档案快照'));
      const actions = element('div', 'sc-card__actions');
      const evidence = button('查看证据', 'sc-card__button sc-card__button--primary', event => openEvidence(dims, null, event.currentTarget, card, highlight));
      evidence.dataset.readerEvidenceOpen = 'score';
      evidence.setAttribute('aria-expanded', 'false');
      actions.append(evidence);
      const replay = button('↻ 重播图形', 'sc-card__button sc-card__button--quiet', () => replayAnimation());
      replay.title = '仅重播仪表弧线与雷达，不改变得分或状态';
      actions.append(replay);
      if (data.misattributed) {
        const claim = button(isClaimed ? '已本地认领 ✓' : '本人认领 · 演示', 'sc-card__button sc-card__button--secondary', () => {
          if (!claim.disabled && typeof options.onClaim === 'function') options.onClaim(data);
        });
        claim.disabled = isClaimed || typeof options.onClaim !== 'function';
        actions.append(claim);
      }
      if (typeof options.onReceipt === 'function') {
        actions.append(button('查看收据 →', 'sc-card__button sc-card__button--primary', () => options.onReceipt(data)));
      }
      top.append(introduction, actions);
      card.append(top);

      if (synthetic) {
        const watermark = element('div', 'sc-card__synthetic', '虚构样例 · SYNTHETIC');
        watermark.append(element('span', '', '演示数据，不对应真实学者'));
        card.append(watermark);
      }

      const dashboard = element('div', 'sc-card__dashboard');
      const instrument = element('div', 'sc-card__instrument');
      const scorePanel = element('div', 'sc-card__score-panel');
      scorePanel.append(element('p', 'sc-card__metric-label', '公开记录可核查度'));
      const gauge = element('div', 'sc-card__gauge');
      const gaugeSvg = svgElement('svg', { viewBox: '0 0 240 240', 'aria-hidden': 'true', class: 'sc-card__gauge-svg' });
      const circumference = 2 * Math.PI * 94;
      const arcLength = circumference * 0.75;
      for (let index = 0; index <= 40; index += 1) {
        const angle = (135 + 270 * index / 40) * Math.PI / 180;
        const inner = index % 5 === 0 ? 105 : 108;
        gaugeSvg.append(svgElement('line', {
          x1: 120 + Math.cos(angle) * inner, y1: 120 + Math.sin(angle) * inner,
          x2: 120 + Math.cos(angle) * 112, y2: 120 + Math.sin(angle) * 112,
          class: 'sc-card__gauge-tick' + (index % 5 === 0 ? ' sc-card__gauge-tick--major' : '')
        }));
      }
      gaugeSvg.append(svgElement('circle', { cx: 120, cy: 120, r: 94, fill: 'none', 'stroke-dasharray': arcLength + ' ' + circumference, transform: 'rotate(135 120 120)', class: 'sc-card__gauge-track' }));
      const gaugeArc = svgElement('circle', { cx: 120, cy: 120, r: 94, fill: 'none', 'stroke-dasharray': '0 ' + circumference, transform: 'rotate(135 120 120)', class: 'sc-card__gauge-progress' });
      gaugeSvg.append(gaugeArc);
      const scoreLine = element('div', 'sc-card__score-line');
      const scoreValue = element('span', 'sc-card__score-value', score);
      scoreValue.setAttribute('aria-hidden', 'true');
      scoreLine.setAttribute('role', 'img');
      scoreLine.setAttribute('aria-label', '公开记录可核查度 ' + score + ' 分，满分 100');
      scoreLine.append(scoreValue, element('span', 'sc-card__score-denominator', '满分 100'));
      gauge.append(gaugeSvg, scoreLine);
      const confidence = element('div', 'sc-card__confidence');
      const confidenceText = String(data.confidence || '未提供');
      const confidenceLevel = /^[低中高]/.test(confidenceText) ? confidenceText[0] : confidenceText;
      confidence.dataset.level = confidenceLevel === '低' ? 'low' : confidenceLevel === '中' ? 'medium' : confidenceLevel === '高' ? 'high' : 'unknown';
      confidence.append(element('span', 'sc-card__status-dot'), element('span', '', '置信度 · ' + confidenceLevel));
      const confidenceDetail = confidenceText.length > 1 && /^[低中高]（.+）$/.test(confidenceText)
        ? confidenceText.slice(2, -1) + ' · 非统计概率' : '按样本量分档，非统计概率';
      scorePanel.append(gauge, confidence, element('p', 'sc-card__confidence-note', confidenceDetail), element('p', 'sc-card__score-caption', '5 项证据 · 每项 20 分'));
      const ruleBadge = element('div', 'sc-card__rule-badge');
      ruleBadge.append(element('span', '', 'v0'), element('span', '', '启发式规则 / 快照未实时复核'));
      scorePanel.append(ruleBadge);

      const radarPanel = element('div', 'sc-card__radar-panel');
      const radarHead = element('div', 'sc-card__radar-heading');
      radarHead.append(element('span', '', '五维证据分布'), element('span', '', '0 — 20'));
      const radar = svgElement('svg', { viewBox: '0 0 400 340', role: 'group', 'aria-labelledby': instanceId + '-radar-title', class: 'sc-card__radar' });
      const radarTitle = svgElement('title', { id: instanceId + '-radar-title' });
      radarTitle.textContent = '五维雷达图。点击各维度或按 Tab 和回车查看证据。';
      radar.append(radarTitle);
      const center = { x: 200, y: 158 };
      const radius = 105;
      const point = (index, value) => {
        const angle = (-90 + 72 * index) * Math.PI / 180;
        return { x: center.x + Math.cos(angle) * radius * value, y: center.y + Math.sin(angle) * radius * value };
      };
      const polygonPoints = (values) => values.map((value, index) => {
        const xy = point(index, value);
        return xy.x.toFixed(2) + ',' + xy.y.toFixed(2);
      }).join(' ');
      [0.25, 0.5, 0.75, 1].forEach((scale) => {
        radar.append(svgElement('polygon', { points: polygonPoints(dims.map(() => scale)), class: 'sc-card__radar-grid' }));
        const scaleLabel = svgElement('text', { x: center.x + 7, y: center.y - radius * scale + 5, class: 'sc-card__radar-scale', 'aria-hidden': 'true' });
        scaleLabel.textContent = scale * 20;
        radar.append(scaleLabel);
      });
      const radarAxes = dims.map((dim, index) => {
        const tip = point(index, 1);
        const axis = svgElement('line', { x1: center.x, y1: center.y, x2: tip.x, y2: tip.y, class: 'sc-card__radar-axis' });
        axis.style.setProperty('--dimension-color', dimensionColors[index]);
        radar.append(axis);
        return axis;
      });
      const fill = svgElement('polygon', { points: polygonPoints(dims.map(() => 0)), class: 'sc-card__radar-fill' });
      radar.append(fill);
      const radarCaption = element('p', 'sc-card__radar-caption', '点击图中维度，追查每一分');
      const dimensionButtons = [];
      const radarDots = [];
      const radarControls = [];
      let focusedIndex = -1;
      function highlight(index) {
        dimensionButtons.forEach((node, i) => node.classList.toggle('is-active', i === index));
        radarControls.forEach((node, i) => node.classList.toggle('is-active', i === index));
        radarDots.forEach((node, i) => node.classList.toggle('is-active', i === index));
        radarAxes.forEach((node, i) => node.classList.toggle('is-active', i === index));
        radarCaption.textContent = index < 0 ? '点击图中维度，追查每一分' : dims[index].label + ' · ' + dims[index].value + '/20 · 查看证据 ↗';
      }
      function linkHighlight(node, index) {
        on(node, 'pointerenter', () => { if (!currentPanel) highlight(index); });
        on(node, 'pointerleave', () => highlight(currentPanel || reading.selected ? reading.index : focusedIndex));
        on(node, 'focus', () => { focusedIndex = index; if (!currentPanel) highlight(reading.selected ? reading.index : index); });
        on(node, 'blur', () => { focusedIndex = -1; highlight(currentPanel || reading.selected ? reading.index : -1); });
      }
      dims.forEach((dim, index) => {
        const control = svgElement('g', { class: 'sc-card__radar-control', role: 'button', tabindex: '0', 'aria-label': dim.label + '，' + dim.value + '/20，查看证据' });
        control.style.setProperty('--dimension-color', dimensionColors[index]);
        const anchor = point(index, 1.39);
        const labelBackground = svgElement('rect', { x: anchor.x - 40, y: anchor.y - 20, width: 80, height: 60, rx: 8, class: 'sc-card__radar-label-bg' });
        const text = svgElement('text', { x: anchor.x, y: anchor.y, 'text-anchor': 'middle', class: 'sc-card__radar-label', 'aria-hidden': 'true' });
        text.textContent = shortLabels[index];
        const value = svgElement('tspan', { x: anchor.x, dy: 20, class: 'sc-card__radar-number' });
        value.textContent = dim.value + '/20';
        text.append(value);
        const dot = svgElement('circle', { cx: center.x, cy: center.y, r: 5, class: 'sc-card__radar-dot', 'aria-hidden': 'true' });
        dot.style.setProperty('--dimension-color', dimensionColors[index]);
        // Keep the data point outside the button: its changing position must not
        // enlarge the label's hit box into the empty space inside the chart.
        radar.append(dot);
        control.append(labelBackground, text);
        on(control, 'click', () => openEvidence(dims, index, control, card, highlight));
        on(control, 'keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openEvidence(dims, index, control, card, highlight);
          }
        });
        linkHighlight(control, index);
        radarControls.push(control);
        radarDots.push(dot);
        radar.append(control);
      });
      radarPanel.append(radarHead, radar, radarCaption);
      instrument.append(scorePanel, radarPanel);

      const dimensions = element('section', 'sc-card__dimensions');
      dimensions.setAttribute('aria-labelledby', instanceId + '-evidence-title');
      const dimensionsHead = element('div', 'sc-card__section-heading');
      const dimensionsTitle = element('h3', '', '每一分，都有来路');
      dimensionsTitle.id = instanceId + '-evidence-title';
      dimensionsHead.append(dimensionsTitle, element('span', '', '5 项证据 ↗'));
      dimensions.append(dimensionsHead);
      const progressFills = [];
      dims.forEach((dim, index) => {
        const dimension = button('', 'sc-card__dimension', () => openEvidence(dims, index, dimension, card, highlight));
        dimension.style.setProperty('--dimension-color', dimensionColors[index]);
        dimension.setAttribute('aria-label', dim.label + '，' + dim.value + ' 分，满分 20 分。查看证据和规则');
        dimension.dataset.evidenceDimension = String(index);
        dimension.setAttribute('aria-expanded', 'false');
        const ordinal = element('span', 'sc-card__dimension-index', String(index + 1).padStart(2, '0'));
        const body = element('span', 'sc-card__dimension-body');
        const heading = element('span', 'sc-card__dimension-heading');
        const value = element('span', 'sc-card__dimension-value');
        value.append(element('strong', '', dim.value), element('span', '', ' / 20'));
        heading.append(element('span', '', dim.label), value);
        const progress = element('span', 'sc-card__progress');
        progress.setAttribute('aria-hidden', 'true');
        const progressFill = element('span', 'sc-card__progress-fill');
        progressFill.style.transform = 'scaleX(0)';
        progress.append(progressFill);
        progressFills.push(progressFill);
        body.append(heading, progress, element('span', 'sc-card__dimension-evidence', dim.evidence || '源快照未提供此项证据说明'));
        const arrow = element('span', 'sc-card__dimension-arrow', '↗');
        arrow.setAttribute('aria-hidden', 'true');
        dimension.append(ordinal, body, arrow);
        linkHighlight(dimension, index);
        dimensionButtons.push(dimension);
        dimensions.append(dimension);
      });
      dashboard.append(instrument, dimensions);
      card.append(dashboard);

      const disclaimer = element('div', 'sc-card__disclaimer');
      disclaimer.append(element('strong', '', '可核查度 ≠ 人品分。'), element('span', '', '它衡量公开记录能支撑多少信任，不判定研究真实性。'));
      card.append(disclaimer);
      if (data.scoreMismatch || number(data.reportedScore, score) !== score) {
        const notice = element('p', 'sc-card__notice sc-card__notice--warning');
        notice.append(element('strong', '', '源数据待核对'), document.createTextNode(' · 原总分 ' + number(data.reportedScore, score) + '，五项合计 ' + score + '。本卡显示 ' + score + ' 分，原始快照保留 ' + number(data.reportedScore, score) + '。'));
        card.append(notice);
      }
      if (isClaimed) {
        const notice = element('div', 'sc-card__notice sc-card__notice--claim');
        notice.append(element('strong', '', '本地认领演示已完成 · 分数重新核对'), element('p', '', data.recalculationNotice || '认领仅更新本地演示档案。缺少新增论文的评分字段，沿用原快照分项；不推测增加分数，也未修改 OpenAlex。'));
        notice.append(element('p', 'sc-card__claim-count', '本地档案 ' + number(data.localWorks, number(data.works) + 1) + ' 篇 / 原始快照 ' + number(data.works) + ' 篇 · ' + number(data.baseScore, score) + ' → ' + score + ' 分'));
        card.append(notice);
      }

      const context = element('footer', 'sc-card__context');
      const profile = element('div', 'sc-card__profile');
      const metrics = element('div', 'sc-card__metrics');
      [[isClaimed ? number(data.localWorks, number(data.works) + 1) : number(data.works), isClaimed ? '本地论文数' : '快照论文数'], [number(data.citedBy), '快照被引'], [number(data.hIndex), 'h-index']].forEach(([value, name]) => {
        const metric = element('div', 'sc-card__metric');
        metric.append(element('strong', '', new Intl.NumberFormat('zh-CN').format(value)), element('span', '', name));
        metrics.append(metric);
      });
      const institutions = Array.isArray(data.institutions) ? data.institutions.join(' / ') : '';
      const provenance = element('div', 'sc-card__profile-source');
      provenance.append(element('p', 'sc-card__institutions', '快照单位：' + (institutions || '未记录')), element('p', 'sc-card__provenance', '快照 ' + (data.generated || '时间未提供') + ' · ' + (synthetic ? '虚构样例' : '身份与单位需本人核验')));
      profile.append(metrics, provenance);
      context.append(profile);
      if (data.note) {
        const note = element('details', 'sc-card__snapshot-note');
        note.append(element('summary', '', '案例说明与快照疑点'), element('p', '', data.note));
        context.append(note);
      }
      card.append(context);
      root.append(card);
      if (reading.selected) highlight(reading.index);

      function paint(elapsed, finish) {
        const scoreProgress = finish ? 1 : Math.min(1, elapsed / 1050);
        const eased = 1 - Math.pow(1 - scoreProgress, 3);
        const start = isClaimed ? number(data.baseScore, score) : 0;
        const displayScore = start + (score - start) * eased;
        gaugeArc.setAttribute('stroke-dasharray', (arcLength * displayScore / 100) + ' ' + circumference);
        const ratios = dims.map((dim, index) => {
          const progress = finish ? 1 : Math.min(1, Math.max(0, (elapsed - index * 115) / 680));
          const ratio = (dim.value / 20) * (1 - Math.pow(1 - progress, 3));
          progressFills[index].style.transform = 'scaleX(' + ratio + ')';
          const xy = point(index, ratio);
          radarDots[index].setAttribute('cx', String(xy.x));
          radarDots[index].setAttribute('cy', String(xy.y));
          return ratio;
        });
        fill.setAttribute('points', polygonPoints(ratios));
      }
      replayAnimation = function () {
        stopAnimation();
        paint(0, false);
        let startTime;
        function tick(time) {
          if (startTime === undefined) startTime = time;
          const elapsed = time - startTime;
          paint(elapsed, elapsed >= 1200);
          if (elapsed < 1200) schedule(tick);
        }
        schedule(tick);
      };
      replayAnimation();
    }

    function openEvidence(dims, initialIndex, trigger, card, highlight) {
      if (currentPanel) {
        currentPanel.setTrigger(trigger);
        if (initialIndex !== null) currentPanel.select(initialIndex);
        return;
      }
      const model = evidenceModel(data, options);
      let index = initialIndex === null ? reading.index : initialIndex;
      const panel = evidencePanel(root, trigger, dismissDialog, {
        profileId: model.id,
        onNavigate: step => selectDimension((index + step + dims.length) % dims.length),
        onPresentation: () => { panel.node.style.setProperty('--dimension-color', colorsFor(root)[index]); }
      });
      const { eyebrow, title, content, navigation } = panel;
      const selectId = instanceId + '-evidence-select';
      const label = element('label', 'sc-evidence-panel__select-label', '查看维度'); label.setAttribute('for', selectId);
      const select = element('select', 'sc-evidence-panel__select'); select.id = selectId;
      select.dataset.readerEvidenceDimension = 'true'; select.setAttribute('aria-label', '选择证据维度');
      dims.forEach((dim, i) => { const option = element('option', '', String(i + 1).padStart(2, '0') + ' · ' + dim.label); option.value = String(i); select.append(option); });
      navigation.append(label, select);
      on(select, 'change', () => selectDimension(Number(select.value)), true);
      function selectDimension(next) {
        if (!Number.isInteger(next) || next < 0 || next >= dims.length || next === index) return;
        reading.anchors.set(index, content.scrollTop || 0);
        index = next; renderEvidence();
      }
      function renderEvidence() {
        const dim = model.dimensions[index];
        reading.index = index; reading.selected = true;
        highlight(index); select.value = String(index);
        if (panel.node) panel.node.style.setProperty('--dimension-color', colorsFor(root)[index]);
        eyebrow.textContent = '证据阅读 / ' + String(index + 1).padStart(2, '0') + ' OF 05';
        title.textContent = dim.label;
        content.replaceChildren();
        content.append(element('p', 'sc-card__dialog-meta sc-evidence-panel__profile', model.name + ' · ' + model.id));
        if (model.synthetic) content.append(element('div', 'sc-card__synthetic', '虚构样例 · 以下证据为演示数据'));
        const score = element('div', 'sc-card__dialog-score');
        score.append(element('strong', '', dim.score), element('span', '', '/ 20 分'), element('span', 'sc-card__dialog-score-label', '快照记录分数'));
        content.append(score);
        const body = element('div', 'sc-card__dialog-body');
        const evidenceGroup = element('section', 'sc-card__evidence-highlight');
        evidenceGroup.append(element('h4', '', '原始快照说明'), element('p', '', dim.rawText));
        const inputs = element('section', 'sc-evidence-inputs');
        inputs.append(inputTable(dim.inputRows), element('p', 'sc-card__dialog-meta', '文字摘要仅从已保存的说明抽取，百分比可能已取整。缺失的计数和逐作品明细没有从分数反推。'));
        const ruleGroup = element('section', '');
        ruleGroup.append(element('h4', '', model.ruleVersion + ' 规则与复算边界'), element('p', '', dim.rule), element('p', 'sc-card__dialog-meta', dim.ruleLimit));
        const ruleLink = element('a', 'sc-card__source-link', '查看 checkup.py 评分脚本 ↗');
        ruleLink.href = '../product/checkup.py'; ruleLink.target = '_blank'; ruleLink.rel = 'noopener noreferrer';
        ruleGroup.append(ruleLink, element('p', 'sc-card__dialog-limit', '输入不完整 · 本页仅展示记录分数并合计现有分项，无法独立复算完整 v0 评分。'));
        body.append(evidenceGroup, inputs, ruleGroup);
        if (model.claimNotice) body.append(element('p', 'sc-card__notice sc-card__notice--claim', model.claimNotice));
        body.append(sourcesSection(model, dim.currentUrl), element('p', 'sc-card__dialog-limit', model.limit));
        content.append(body);
        content.scrollTop = reading.anchors.get(index) || 0;
      }
      currentPanel = panel;
      panel.select = selectDimension;
      clearHighlight = () => highlight(reading.selected ? reading.index : -1);
      renderEvidence(); panel.open();
    }

    const instance = {
      update(nextData) {
        if (closed) return;
        dismissDialog(false);
        if (data.id !== nextData?.id) { reading.index = 0; reading.selected = false; reading.anchors.clear(); }
        data = nextData || {};
        render();
      },
      replay() { if (!closed) replayAnimation(); },
      dismissEvidence(restoreFocus) { dismissDialog(Boolean(restoreFocus)); },
      destroy() {
        if (closed) return;
        closed = true;
        cleanup();
        root.replaceChildren();
        mounted.delete(root);
      }
    };
    mounted.set(root, instance);
    render();
    return instance;
  }

  global.ScholarCheckupCard = Object.freeze({ mount, mountCandidateEvidence });
})(window);
