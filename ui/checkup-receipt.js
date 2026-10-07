(function (global) {
  'use strict';

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function button(text, className, handler) {
    var element = node('button', 'sc-receipt-button ' + (className || ''), text);
    element.type = 'button';
    if (handler) element.addEventListener('click', handler);
    return element;
  }

  function message(error) {
    return error && error.message ? error.message : String(error || '操作未完成，请重试。');
  }

  function mount(root, initial, options) {
    if (!root || root.nodeType !== 1) throw new TypeError('收据组件需要一个 DOM 容器。');
    options = options || {};
    var current = initial;
    var receipt = null;
    var receiptSnapshot = null;
    var history = [];
    var busy = false;
    var verifying = false;
    var claiming = false;
    var destroyed = false;
    var epoch = 0;
    var timers = new Map();
    var animations = new Set();
    var dialog = null;
    var status = '';
    var statusKind = '';
    var verification = null;
    var block = 25592150;
    var media = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

    function core() {
      if (!global.ScholarCheckupCore) throw new Error('数据与收据模块尚未加载，请刷新页面。');
      return global.ScholarCheckupCore;
    }

    function fingerprint(value) {
      return JSON.stringify([value.id, value.raw, value.generated, value.source, value.dims, value.score, value.claim || null, !!value.claimSimulation, value.localWorks]);
    }

    function valid(token) { return !destroyed && token === epoch; }

    function delay(ms, token) {
      if (media.matches) return Promise.resolve(valid(token));
      return new Promise(function (resolve) {
        var id = global.setTimeout(function () { timers.delete(id); resolve(valid(token)); }, ms);
        timers.set(id, resolve);
      });
    }

    function cancelPending() {
      epoch += 1;
      timers.forEach(function (resolve, id) { global.clearTimeout(id); resolve(false); });
      timers.clear();
      animations.forEach(function (animation) { animation.cancel(); });
      animations.clear();
      if (dialog) {
        if (dialog.open) dialog.close();
        dialog.remove();
        dialog = null;
      }
    }

    function setStatus(text, kind) {
      status = text;
      statusKind = kind || '';
      var target = root.querySelector('[data-sc-receipt-status]');
      if (target) {
        target.textContent = text;
        target.className = 'sc-receipt-status' + (kind ? ' sc-receipt-status--' + kind : '');
      }
    }

    function download(value, suffix) {
      var url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
      var link = node('a');
      link.href = url;
      link.download = 'scholar-checkup-' + String(current.id || 'case').replace(/[^a-z0-9_-]/gi, '_') + '-' + suffix + '.json';
      document.body.append(link);
      link.click();
      link.remove();
      global.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    async function copyHash() {
      if (!receipt) return;
      var token = epoch;
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('当前浏览器不支持直接复制，请选中下方完整哈希复制。');
        await navigator.clipboard.writeText(receipt.receiptHash);
        if (valid(token)) setStatus('收据哈希已复制。', 'success');
      } catch (error) {
        if (valid(token)) setStatus(message(error), 'error');
      }
    }

    async function verify() {
      if (!receipt || busy || verifying || claiming) return;
      var token = epoch;
      var checking = receipt;
      verifying = true;
      verification = null;
      status = '正在重新计算快照、规则和收据哈希…';
      statusKind = '';
      render();
      try {
        var result = await core().verifyReceipt(checking, current);
        if (!valid(token)) return;
        verification = result;
        status = result.valid ? '本地核验通过：当前数据、规则与收据逐项匹配。' : '核验失败：当前数据或收据内容与原始绑定不一致。';
        statusKind = result.valid ? 'success' : 'error';
      } catch (error) {
        if (!valid(token)) return;
        status = '核验未完成：' + message(error);
        statusKind = 'error';
      }
      if (valid(token)) { verifying = false; render(); }
    }

    async function generate() {
      if (busy || claiming || verifying) return;
      var token = epoch;
      busy = true;
      verification = null;
      status = '正在计算真实 SHA-256 哈希。此过程只在本地进行。';
      statusKind = '';
      render();
      try {
        var snapshot = current;
        var generated = await core().createReceipt(snapshot);
        if (!valid(token)) return;
        var hashOutput = root.querySelector('[data-sc-receipt-hash]');
        var progress = root.querySelectorAll('[data-sc-receipt-step]');
        if (hashOutput) {
          hashOutput.textContent = '';
          hashOutput.classList.add('sc-receipt-hash--typing');
          for (var i = 0; i < generated.receiptHash.length; i += media.matches ? generated.receiptHash.length : 3) {
            hashOutput.textContent = generated.receiptHash.slice(0, i + (media.matches ? generated.receiptHash.length : 3));
            if (!(await delay(24, token))) return;
          }
          hashOutput.classList.remove('sc-receipt-hash--typing');
        }
        for (var step = 0; step < progress.length; step += 1) {
          if (!(await delay(step ? 420 : 200, token))) return;
          progress[step].classList.add('sc-receipt-step--done');
          var icon = progress[step].querySelector('.sc-receipt-step-icon');
          if (icon) icon.textContent = '✓';
          if (step === 2) block += 1;
        }
        if (!valid(token)) return;
        if (receipt) history.unshift({ receipt: receipt, snapshot: receiptSnapshot, reason: '重新生成前的收据' });
        receipt = generated;
        receiptSnapshot = snapshot;
        busy = false;
        status = '收据已生成 · 本地模拟确认，尚未广播到任何区块链。';
        statusKind = 'success';
        render();
      } catch (error) {
        if (!valid(token)) return;
        busy = false;
        status = '生成失败：' + message(error);
        statusKind = 'error';
        render();
      }
    }

    function openClaim() {
      if (claiming || busy || !current.misattributed || current.claimSimulation) return;
      var opener = document.activeElement;
      var popup = node('dialog', 'sc-receipt-dialog');
      dialog = popup;
      popup.setAttribute('aria-labelledby', 'sc-receipt-claim-title');
      popup.setAttribute('aria-describedby', 'sc-receipt-claim-description');
      var title = node('h3', '', '确认本人认领 · 本地演示');
      title.id = 'sc-receipt-claim-title';
      var description = node('p', '', '这一步模拟钱包签名的确认环节，不会连接钱包、请求真实签名或修改 OpenAlex。认领只记录在当前浏览器演示中。');
      description.id = 'sc-receipt-claim-description';
      var paper = node('blockquote', '', current.misattributed.paper);
      var note = node('p', 'sc-receipt-dialog-note', '认领后重新计算五维分数。缺少新增论文的逐篇指标时，分数保持不变；不会为了动画自动加分。旧收据将标记为历史。');
      var actions = node('div', 'sc-receipt-actions');
      var cancel = button('取消', '', function () { popup.close(); });
      var confirm = button('确认模拟认领', 'sc-receipt-button--primary', function () {
        popup.close();
        runClaim();
      });
      actions.append(cancel, confirm);
      popup.append(node('span', 'sc-receipt-eyebrow', 'LOCAL DEMO · NO WALLET REQUEST'), title, description, paper, note, actions);
      popup.addEventListener('click', function (event) {
        if (event.target === popup) {
          var rect = popup.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) popup.close();
        }
      });
      popup.addEventListener('close', function () {
        if (dialog === popup) dialog = null;
        popup.remove();
        if (opener && opener.isConnected) opener.focus();
      }, { once: true });
      document.body.append(popup);
      popup.showModal();
      cancel.focus();
    }

    async function runClaim() {
      if (claiming || !current.misattributed || current.claimSimulation) return;
      var token = epoch;
      var before = current;
      claiming = true;
      status = '模拟确认已记录，正在将论文移入本地认领档案…';
      statusKind = '';
      render();
      var chip = root.querySelector('[data-sc-receipt-paper]');
      var origin = root.querySelector('[data-sc-receipt-origin]');
      var destination = root.querySelector('[data-sc-receipt-destination]');
      if (chip && origin && destination && !media.matches && typeof chip.animate === 'function') {
        var from = origin.getBoundingClientRect();
        var to = destination.getBoundingClientRect();
        var animation = chip.animate([
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: 'translate(' + ((to.left - from.left) / 2) + 'px, ' + ((to.top - from.top) / 2 - 25) + 'px) scale(1.04)', opacity: 1, offset: 0.5 },
          { transform: 'translate(' + (to.left - from.left) + 'px, ' + (to.top - from.top) + 'px) scale(1)', opacity: 1 }
        ], { duration: 1350, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' });
        animations.add(animation);
        try { await animation.finished; } catch (_) { /* A new case or unmount cancelled this animation. */ }
        if (!valid(token)) return;
        animations.delete(animation);
      } else if (!(await delay(350, token))) return;
      if (!valid(token)) return;
      setStatus('论文已进入本地认领档案，正在按原规则重新计算…');
      if (!(await delay(500, token))) return;
      try {
        var updated = typeof options.onClaim === 'function' ? await options.onClaim(before) : core().recomputeAfterClaim(before);
        if (!valid(token)) return;
        if (updated) update(updated);
        else {
          claiming = false;
          status = '认领动画完成，等待体检卡返回重算结果。';
          statusKind = '';
          render();
        }
      } catch (error) {
        if (!valid(token)) return;
        claiming = false;
        status = '认领未完成：' + message(error);
        statusKind = 'error';
        render();
      }
    }

    function detail(label, value, mono) {
      var entry = node('div', 'sc-receipt-detail');
      entry.append(node('dt', '', label), node('dd', mono ? 'sc-receipt-mono' : '', value));
      return entry;
    }

    function renderClaim(section) {
      if (!current.misattributed) return;
      var claimed = !!current.claimSimulation;
      var claimBox = node('section', 'sc-receipt-claim');
      var claimHeader = node('div', 'sc-receipt-claim-heading');
      var heading = node('div');
      heading.append(node('span', 'sc-receipt-eyebrow', 'IDENTITY REPAIR'), node('h3', '', claimed ? '论文已回到你的本地档案' : '把属于你的论文，认领回来'));
      claimHeader.append(heading, node('span', 'sc-receipt-tag sc-receipt-tag--amber', '本地模拟 · 不改上游记录'));
      claimBox.append(claimHeader);
      var scene = node('div', 'sc-receipt-claim-scene' + (claimed ? ' sc-receipt-claim-scene--claimed' : ''));
      var origin = node('div', 'sc-receipt-profile sc-receipt-profile--origin');
      origin.setAttribute('data-sc-receipt-origin', '');
      origin.append(node('span', 'sc-receipt-profile-label', '错挂档案 · 燃烧方向'), node('strong', '', '另一位 Zhiyuan Lyu'), node('code', '', current.misattributed.wrong_profile));
      var destination = node('div', 'sc-receipt-profile sc-receipt-profile--destination');
      destination.setAttribute('data-sc-receipt-destination', '');
      destination.append(node('span', 'sc-receipt-profile-label', '本人档案 · 管道机器人'), node('strong', '', current.name), node('code', '', current.id));
      var count = node('div', 'sc-receipt-paper-count');
      count.append(node('strong', '', claimed ? current.localWorks : current.works), node('span', '', claimed ? ' 篇 · 本地演示' : ' 篇 · 原始记录'));
      destination.append(count);
      var flight = node('div', 'sc-receipt-paper' + (claiming ? ' sc-receipt-paper--moving' : ''));
      flight.setAttribute('data-sc-receipt-paper', '');
      flight.append(node('span', '', claimed ? '✓ 已本地认领 · 墒情论文' : '↗ 待认领 · 墒情论文'), node('small', '', current.misattributed.paper));
      if (claimed) destination.append(flight); else origin.append(flight);
      scene.append(origin, node('span', 'sc-receipt-flight-arrow', '→'), destination);
      claimBox.append(scene);
      if (claimed) {
        var recap = node('div', 'sc-receipt-recalculation');
        recap.append(node('strong', '', String(current.baseScore) + ' → ' + String(current.score) + ' 分'), node('p', '', current.recalculationNotice || '原规则已重新计算。缺少新增论文的逐篇指标，当前总分保持不变。'));
        claimBox.append(recap);
      } else {
        var action = button(claiming ? '正在认领与重算…' : '本人认领 →', 'sc-receipt-button--claim', openClaim);
        action.disabled = busy || claiming || verifying;
        claimBox.append(action, node('p', 'sc-receipt-small', '先确认归属，再重算分数。演示不连接钱包，也不会替你修改公开学术库。'));
      }
      section.append(claimBox);
    }

    function render() {
      if (destroyed) return;
      var section = node('section', 'sc-receipt');
      section.setAttribute('aria-label', '上链收据与本人认领');
      section.setAttribute('aria-busy', String(busy || claiming || verifying));
      var header = node('header', 'sc-receipt-header');
      var titles = node('div');
      titles.append(node('span', 'sc-receipt-eyebrow', '04 / VERIFIABLE RECEIPT'), node('h2', '', '让这一次体检，有据可查。'), node('p', '', '把身份、数据和评分规则绑定在一张收据里。谁改了什么，都能重新核对。'));
      header.append(titles, node('span', 'sc-receipt-tag', 'SHA-256 · 本地生成'));
      section.append(header);
      if (current.synthetic) section.append(node('div', 'sc-receipt-synthetic', '虚构样例 · 此收据不对应真实学者'));
      var panel = node('div', 'sc-receipt-panel');
      var top = node('div', 'sc-receipt-panel-top');
      var identity = node('div');
      identity.append(node('span', 'sc-receipt-eyebrow', current.claimSimulation ? 'LOCAL CLAIM SNAPSHOT' : 'RESEARCHER SNAPSHOT'), node('h3', '', current.name), node('p', 'sc-receipt-mono sc-receipt-small', current.id));
      var score = node('div', 'sc-receipt-score');
      score.append(node('strong', '', current.score), node('span', '', ' / 100'));
      top.append(identity, score);
      panel.append(top);
      var chain = node('div', 'sc-receipt-chain');
      chain.append(node('span', 'sc-receipt-chain-dot'), node('strong', '', '模拟确认 · 尚未广播'), node('span', 'sc-receipt-mono', '演示区块 #' + block.toLocaleString('en-US')));
      panel.append(chain);
      var hashBox = node('div', 'sc-receipt-hash-box');
      hashBox.append(node('span', 'sc-receipt-eyebrow', 'RECEIPT HASH / SHA-256'));
      var hash = node('code', 'sc-receipt-hash', receipt ? receipt.receiptHash : '等待生成：绑定当前学者、快照与规则');
      hash.setAttribute('data-sc-receipt-hash', '');
      hash.setAttribute('aria-label', '完整收据哈希');
      hashBox.append(hash);
      panel.append(hashBox);
      var steps = node('ol', 'sc-receipt-steps');
      ['数据快照绑定', '评分规则固定', '本地模拟确认'].forEach(function (label, index) {
        var step = node('li', 'sc-receipt-step' + (receipt && !busy ? ' sc-receipt-step--done' : ''));
        step.setAttribute('data-sc-receipt-step', String(index));
        step.append(node('span', 'sc-receipt-step-icon', receipt && !busy ? '✓' : String(index + 1)), node('span', '', label));
        steps.append(step);
      });
      panel.append(steps);
      if (receipt) {
        var details = node('dl', 'sc-receipt-details');
        details.append(detail('学者 ID 哈希', receipt.subjectIdHash, true), detail('数据快照哈希', receipt.snapshotHash, true), detail('评分规则哈希', receipt.rulesHash, true), detail('规则版本', receipt.rulesVersion, true), detail('生成时间', receipt.timestamp, true), detail('置信度', receipt.confidence), detail('快照归属', receipt.claim ? '已附本地模拟认领声明' : '公开记录原始归属'));
        if (receipt.scoreMismatch) details.append(detail('总分校验', '来源总分 ' + receipt.reportedScore + '；本收据记录五维合计 ' + receipt.score));
        panel.append(details);
      } else panel.append(node('p', 'sc-receipt-intro', '点击生成后，将得到可核验的本地收据 JSON。本区域的区块确认仅为演示动画；真实评分记录请查看上方链上记录。'));
      var actions = node('div', 'sc-receipt-actions');
      var generateButton = button(busy ? '正在生成收据…' : receipt ? '重新生成收据' : '生成收据 →', 'sc-receipt-button--primary', generate);
      generateButton.disabled = busy || verifying || claiming;
      actions.append(generateButton);
      if (receipt) {
        var verifyButton = button(verifying ? '正在核验…' : '核验本地数据', '', verify);
        verifyButton.disabled = busy || verifying || claiming;
        actions.append(verifyButton);
        var exportButton = button('导出 JSON ↓', '', function () { download(receipt, 'receipt'); });
        exportButton.disabled = busy;
        actions.append(exportButton);
        var copyButton = button('复制哈希', 'sc-receipt-button--quiet', copyHash);
        copyButton.disabled = busy;
        actions.append(copyButton);
      }
      var explorer = button('本地快照 · 无链上交易', 'sc-receipt-button--quiet');
      explorer.disabled = true;
      explorer.title = '没有真实交易，尚未提供区块浏览器链接。';
      actions.append(explorer);
      panel.append(actions);
      var statusNode = node('p', 'sc-receipt-status' + (statusKind ? ' sc-receipt-status--' + statusKind : ''), status);
      statusNode.setAttribute('data-sc-receipt-status', '');
      statusNode.setAttribute('role', 'status');
      statusNode.setAttribute('aria-live', 'polite');
      statusNode.setAttribute('aria-atomic', 'true');
      panel.append(statusNode);
      if (verification) {
        var result = node('details', 'sc-receipt-verification');
        result.open = !verification.valid;
        result.append(node('summary', '', verification.valid ? '✓ 查看逐项核验结果' : '核验失败 · 查看差异'));
        var checks = node('ul');
        Object.keys(verification.checks || {}).forEach(function (key) {
          checks.append(node('li', verification.checks[key] ? 'sc-receipt-check-pass' : 'sc-receipt-check-fail', (verification.checks[key] ? '✓ ' : '✕ ') + key));
        });
        result.append(checks);
        (verification.errors || []).forEach(function (error) { result.append(node('p', 'sc-receipt-check-fail', error)); });
        panel.append(result);
      }
      panel.append(node('p', 'sc-receipt-disclaimer', '哈希能证明材料是否变化，不能证明论文结论真实。当前为本地演示：没有真实签名、交易或链上最终确认。'));
      section.append(panel);
      renderClaim(section);
      if (history.length) {
        var archive = node('details', 'sc-receipt-history');
        archive.append(node('summary', '', '历史收据 · ' + history.length + ' 份（不代表当前状态）'));
        history.forEach(function (entry, index) {
          var row = node('div', 'sc-receipt-history-row');
          var description = node('div');
          description.append(node('strong', '', entry.reason), node('p', 'sc-receipt-small', entry.receipt.timestamp), node('code', 'sc-receipt-history-hash', entry.receipt.receiptHash));
          row.append(description, button('导出历史 JSON', '', function () { download(entry.receipt, 'history-' + (index + 1)); }));
          archive.append(row);
        });
        section.append(archive);
      }
      if (typeof options.onBack === 'function') section.append(button('← 返回体检卡', 'sc-receipt-button--quiet sc-receipt-back', options.onBack));
      root.replaceChildren(section);
    }

    function update(next) {
      if (destroyed || !next) return;
      var sameIdentity = current.id === next.id;
      var changed = fingerprint(current) !== fingerprint(next);
      cancelPending();
      busy = false;
      verifying = false;
      claiming = false;
      verification = null;
      if (!sameIdentity) {
        receipt = null;
        receiptSnapshot = null;
        history = [];
        status = '';
        statusKind = '';
      } else if (changed) {
        if (receipt) history.unshift({ receipt: receipt, snapshot: receiptSnapshot, reason: next.claimSimulation ? '本人认领前的收据' : '数据更新前的收据' });
        receipt = null;
        receiptSnapshot = null;
        status = next.claimSimulation ? '已完成本地认领并重算。请为认领后的数据生成新收据。' : '数据已更新，请重新生成收据。';
        statusKind = 'success';
      }
      current = next;
      render();
    }

    render();
    return {
      update: update,
      openClaim: openClaim,
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        cancelPending();
        root.replaceChildren();
      }
    };
  }

  global.ScholarCheckupReceipt = Object.freeze({ mount: mount });
})(window);
