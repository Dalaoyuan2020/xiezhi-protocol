/* Scholar Checkup · Screen 03. No runtime dependencies or HTML injection. */
(function (global) {
  'use strict';

  const mounted = new WeakMap();
  let sequence = 0;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const fallbackLabels = ['身份清晰度', '撤稿与更正', '开放程度', '同领域影响力', '产出节奏'];
  const shortLabels = ['身份', '更正', '开放', '影响', '节奏'];
  const dimensionColors = ['#68ead0', '#66d7ee', '#8bbcff', '#b8acf1', '#c5dc9a'];

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

  function safeUrl(value) {
    try {
      const parsed = new URL(value);
      return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null;
    } catch (_) { return null; }
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
    let currentDialog = null;
    let dialogTrigger = null;
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
      const trigger = dialogTrigger;
      dialogDisposers.forEach((dispose) => dispose());
      dialogDisposers = [];
      if (currentDialog) {
        if (currentDialog.open) currentDialog.close();
        currentDialog.remove();
      }
      currentDialog = null;
      dialogTrigger = null;
      if (clearHighlight) clearHighlight(restoreFocus);
      clearHighlight = null;
      if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
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
      eyebrow.append(element('span', 'sc-card__step', '03'), element('span', '', 'EVIDENCE PROFILE / 体检卡'));
      const title = element('h2', 'sc-card__name', data.name || '学者快照');
      title.id = instanceId + '-title';
      introduction.append(eyebrow, title, element('p', 'sc-card__case', data.label || '公开学术档案快照'));
      const actions = element('div', 'sc-card__actions');
      const replay = button('↻ 重播动画', 'sc-card__button sc-card__button--quiet', () => replayAnimation());
      replay.title = '仅重播数字与雷达动画，不重新打分';
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
        on(node, 'pointerenter', () => highlight(index));
        on(node, 'pointerleave', () => { if (!currentDialog) highlight(focusedIndex); });
        on(node, 'focus', () => { focusedIndex = index; highlight(index); });
        on(node, 'blur', () => { focusedIndex = -1; if (!currentDialog) highlight(-1); });
      }
      dims.forEach((dim, index) => {
        const control = svgElement('g', { class: 'sc-card__radar-control', role: 'button', tabindex: '0', 'aria-label': dim.label + '，' + dim.value + '/20，查看证据', 'aria-haspopup': 'dialog' });
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
        dimension.setAttribute('aria-haspopup', 'dialog');
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

      function paint(elapsed, finish) {
        const scoreProgress = finish ? 1 : Math.min(1, elapsed / 1050);
        const eased = 1 - Math.pow(1 - scoreProgress, 3);
        const start = isClaimed ? number(data.baseScore, score) : 0;
        const displayScore = start + (score - start) * eased;
        scoreValue.textContent = String(Math.round(displayScore * 10) / 10);
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
        if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          paint(1200, true);
          return;
        }
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
      dismissDialog(false);
      let index = initialIndex;
      const dialog = element('dialog', 'sc-card__dialog');
      const dialogTitleId = instanceId + '-dialog-title';
      dialog.setAttribute('aria-labelledby', dialogTitleId);
      const head = element('div', 'sc-card__dialog-head');
      const headingGroup = element('div', '');
      const eyebrow = element('p', 'sc-card__eyebrow');
      const title = element('h3', '');
      title.id = dialogTitleId;
      headingGroup.append(eyebrow, title);
      const close = button('关闭 ×', 'sc-card__button sc-card__button--secondary', () => dismissDialog(true), true);
      head.append(headingGroup, close);
      const content = element('div', 'sc-card__dialog-content');
      const navigation = element('nav', 'sc-card__dialog-nav');
      navigation.setAttribute('aria-label', '逐项查看证据');
      const counter = element('span', 'sc-card__dialog-counter');
      counter.setAttribute('role', 'status');
      counter.setAttribute('aria-live', 'polite');
      function navigate(step) {
        index = (index + step + dims.length) % dims.length;
        renderEvidence();
        content.scrollTop = 0;
      }
      navigation.append(button('← 上一项', 'sc-card__button sc-card__button--secondary', () => navigate(-1), true), counter, button('下一项 →', 'sc-card__button sc-card__button--secondary', () => navigate(1), true));
      dialog.append(head, content, navigation);

      function renderEvidence() {
        const dim = dims[index];
        highlight(index);
        dialog.style.setProperty('--dimension-color', dimensionColors[index]);
        eyebrow.textContent = 'EVIDENCE / ' + String(index + 1).padStart(2, '0');
        title.textContent = dim.label;
        counter.textContent = String(index + 1).padStart(2, '0') + ' / 05';
        content.replaceChildren();
        if (data.synthetic) content.append(element('div', 'sc-card__synthetic', '虚构样例 · 以下证据为演示数据'));
        const score = element('div', 'sc-card__dialog-score');
        score.append(element('strong', '', dim.value), element('span', '', '/ 20 分'), element('span', 'sc-card__dialog-score-label', '本项占总分 ' + dim.value + ' 分'));
        content.append(score);
        const body = element('div', 'sc-card__dialog-body');
        const evidenceGroup = element('section', 'sc-card__evidence-highlight');
        evidenceGroup.append(element('h4', '', '01 / 这项分数依据什么'), element('p', '', dim.evidence || '快照中未记录此项证据，无法进一步核验。'));
        const ruleGroup = element('section', '');
        ruleGroup.append(element('h4', '', '02 / v0 评分规则'), element('p', '', dim.rule || '本项按 v0 启发式规则计算，上限 20 分。完整阈值以仓库 checkup.py 的对应版本为准。'));
        const snapshotGroup = element('section', '');
        snapshotGroup.append(element('h4', '', '03 / 数据从哪里来'), element('p', '', data.synthetic ? '虚构样例；没有对应的真实 OpenAlex 学者记录。' : (data.source || '仓库中的 OpenAlex 数据快照')), element('p', 'sc-card__dialog-meta', '快照时间：' + (data.generated || '未提供') + ' · 未向数据源实时复核'));
        const sourceUrl = !data.synthetic && safeUrl(dim.sourceUrl);
        if (sourceUrl) {
          const link = element('a', 'sc-card__source-link', '查看 OpenAlex 原始记录 ↗');
          link.href = sourceUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          snapshotGroup.append(link);
        } else snapshotGroup.append(element('p', 'sc-card__dialog-meta', data.synthetic ? '虚构案例不提供外部学者记录链接。' : '此项未提供可用的原始记录链接。'));
        body.append(evidenceGroup, ruleGroup, snapshotGroup);
        if (data.claimSimulation) body.append(element('p', 'sc-card__notice sc-card__notice--claim', data.recalculationNotice || '已做本地认领演示；本项仍使用原始快照字段，不代表数据源已更正。'));
        body.append(element('p', 'sc-card__dialog-limit', '可核查度 ≠ 人品分。单项高低不构成科研诚信结论；“未发现撤稿记录”也不等于论文结论已经验证。'));
        content.append(body);
      }

      on(dialog, 'close', () => dismissDialog(true), true);
      on(dialog, 'click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismissDialog(true);
      }, true);
      on(dialog, 'keydown', (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          navigate(event.key === 'ArrowLeft' ? -1 : 1);
        }
      }, true);
      card.append(dialog);
      currentDialog = dialog;
      dialogTrigger = trigger;
      clearHighlight = (restoreFocus) => highlight(restoreFocus ? initialIndex : -1);
      renderEvidence();
      dialog.showModal();
      close.focus();
    }

    const instance = {
      update(nextData) {
        if (closed) return;
        data = nextData || {};
        render();
      },
      replay() { if (!closed) replayAnimation(); },
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

  global.ScholarCheckupCard = Object.freeze({ mount });
})(window);
