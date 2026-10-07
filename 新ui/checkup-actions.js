(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarCheckupActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This is an undeployed product proposal, not an amendment to checkup.py v0.
  const CONTRIBUTION_RULE = Object.freeze({
    version: 'contribution-demo-draft',
    deployed: false,
    separateFromPublicScore: true,
    claim: 5,
    references: 3,
    reproduction: 8
  });
  const instances = new WeakMap();
  let sequence = 0;

  function deriveActions(normalized) {
    if (!normalized || !Number.isFinite(normalized.score) || normalized.score < 0 || normalized.score > 100) {
      throw new TypeError('个人行动需要 0–100 的 normalized.score。');
    }
    const lowConfidence = /^\s*(?:低|low\b)/i.test(String(normalized.confidence || ''));
    const synthetic = Boolean(normalized.synthetic);
    const claimPending = Boolean(normalized.claimSimulation) && !synthetic;
    return Object.freeze({
      publicScore: normalized.score,
      recommendReviewer: normalized.score >= 75,
      showTasks: normalized.score < 75 || lowConfidence,
      lowConfidence,
      synthetic,
      claimAvailable: Boolean(normalized.misattributed) && !claimPending && !synthetic,
      claimPending,
      claimStatus: synthetic ? 'synthetic' : claimPending ? 'pending-orcid-verification' : normalized.misattributed ? 'available-demo' : 'no-misattributed-paper',
      creditedContributionPoints: 0,
      potentialContributionPoints: CONTRIBUTION_RULE.claim + CONTRIBUTION_RULE.references + CONTRIBUTION_RULE.reproduction,
      contributionRule: CONTRIBUTION_RULE
    });
  }

  function mount(root, normalized, options) {
    if (!root || !root.ownerDocument || typeof root.replaceChildren !== 'function') throw new TypeError('ScholarCheckupActions.mount requires a root element.');
    if (instances.has(root)) instances.get(root).destroy();
    options = options || {};
    const doc = root.ownerDocument;
    const id = 'sc-actions-' + (++sequence);
    let data = normalized;
    let model;
    let handlers = [];
    let modalHandlers = [];
    let modal = null;
    let destroyed = false;

    function node(tag, className, text) {
      const result = doc.createElement(tag);
      if (className) result.className = className;
      if (text !== undefined) result.textContent = String(text);
      return result;
    }

    function on(target, event, handler, inModal) {
      target.addEventListener(event, handler);
      (inModal ? modalHandlers : handlers).push(() => target.removeEventListener(event, handler));
    }

    function button(text, className, handler, inModal) {
      const result = node('button', className, text);
      result.type = 'button';
      on(result, 'click', handler, inModal);
      return result;
    }

    function clearModal() {
      modalHandlers.forEach(dispose => dispose());
      modalHandlers = [];
      if (modal) {
        if (modal.open) modal.close();
        modal.remove();
        modal = null;
      }
    }

    function cleanup() {
      clearModal();
      handlers.forEach(dispose => dispose());
      handlers = [];
    }

    function list(items, className) {
      const result = node('ul', className);
      items.forEach(item => result.append(node('li', '', item)));
      return result;
    }

    function openDialog(kind, trigger) {
      clearModal();
      const descriptions = {
        reviewer: {
          title: '推荐成为审稿专家',
          label: 'REVIEWER / 推荐说明',
          badge: '演示推荐 · 未报名',
          intro: '当前公开数据快照达到 75 分推荐线。它只是发出邀请的参考条件，不证明专业水平，也不授予审稿资格。',
          sections: [
            ['正式参与前，需要完成', ['通过 ORCID 等身份渠道核验本人身份；页面中存在 ORCID 字段不等于已核验。', '提供与稿件研究领域相符的经验和代表工作，由邀请机构核查领域匹配。', '披露与作者、机构和稿件相关的利益冲突；存在冲突时回避该次审稿。', '提交经核验的审稿记录，由机构确认质量与有效期；资格不能仅靠公开分数长期保留。']],
            ['当前会发生什么', ['本弹窗只展示推荐条件，不提交报名、不发送邀请、不生成专家资格或审稿收据。正式规则和身份验证尚未接入。']]
          ]
        },
        claim: {
          title: '认领论文，先核对归属',
          label: 'TASK 01 / 认领核验要求',
          badge: '贡献分草案 +5 · 未部署',
          intro: model.claimPending ? '已完成本地认领演示，尚未通过 ORCID 核验。公开体检分仍为 ' + model.publicScore + '，贡献分尚未入账。' : '针对一篇明确错挂的论文提出归属声明。认领声明本身不是归属证明，也不会直接增加 v0 体检分。',
          sections: [
            ['任务范围', [data.misattributed && data.misattributed.paper ? '待核对论文：' + data.misattributed.paper : '此快照没有可操作的错挂论文记录；不能凭空认领其他论文。']],
            ['需要交付', ['论文标识或版本指纹、错误档案与正确档案的标识。', 'ORCID 授权核验结果，以及论文作者信息与本人身份一致的佐证。']],
            ['由谁核验', ['身份核验服务检查 ORCID 控制权；数据维护方或独立核查者核对论文归属，保留确认、驳回与申诉记录。']],
            ['怎样计分', ['拟议贡献规则：核验通过后，可单独计 +5 行为贡献分；重复认领不能重复计分。该规则尚未部署。', '当前仅演示本地声明。未做 ORCID 授权，未修改 OpenAlex，未写入区块链。v0 分数需取得新字段后按原规则重算。']]
          ]
        },
        references: {
          title: '复核一份参考文献清单',
          label: 'TASK 02 / 任务草案',
          badge: '贡献分草案 +3 · 未部署',
          intro: '这是可审阅的任务方案，尚未发布或分配真实稿件。查看方案不代表领取任务，也不会产生已完成的记录。',
          sections: [
            ['事先锁定的范围', ['选择一份有权访问的稿件和其中 10 条参考文献，锁定清单版本、稿件指纹及核查时间。逐条核对标题、作者、年份、DOI 等标识及撤稿状态。']],
            ['需要交付', ['逐条记录匹配的数据源、原始链接、查询时间、核查结果与差异说明。未检索到时标记待核实，不能直接写成“伪造”。', '提交机器可读的核查表和证据文件指纹；保留可复查的原始查询结果。']],
            ['由谁验收', ['独立核查者根据相同清单复核证据及疑点，确认范围完整、结论能追溯。作者本人不能独自验收自己的工作。']],
            ['怎样计分', ['拟议贡献规则：独立验收后，可单独计 +3 行为贡献分。同一清单版本不能重复入账；这不会直接给 v0 体检分加 3。', '链上核查凭据需要真实提交并确认。当前没有材料上传、验收或上链，不生成伪造的工作完成记录。']]
          ]
        },
        reproduction: {
          title: '复现一个明确的主张',
          label: 'TASK 03 / 任务草案',
          badge: '贡献分草案 +8 · 未部署',
          intro: '先约定研究主张、实验版本和验收条件，再做复现。当前展示任务范围，不会运行代码或自动发布委托。',
          sections: [
            ['事先锁定的范围', ['明确主张编号、代码提交、数据版本、依赖环境、命令、随机种子、运行次数和允许误差。实验无法启动时的排查交付也应事先约定。']],
            ['需要交付', ['环境清单、代码改动、完整命令、原始输出、执行日志及结果分析，并提供版本与文件指纹。只上传截图不能证明任务执行完成。']],
            ['由谁验收', ['独立核查者实际复跑关键步骤，检查输入版本与输出。结果与原论文不一致也可构成有效交付；不一致本身不等于论文被证伪。']],
            ['怎样计分', ['拟议贡献规则：材料完整且独立复跑核验通过后，可单独计 +8 行为贡献分；不以结果“好看”作为加分条件。规则尚未部署。', '当前未提交日志、未独立复跑、未登记链上凭据，贡献分不入账，也不改变 v0 公开体检分。']]
          ]
        }
      };
      const description = descriptions[kind];
      const dialog = node('dialog', 'sc-actions__dialog');
      dialog.setAttribute('aria-labelledby', id + '-dialog-title');
      dialog.setAttribute('aria-describedby', id + '-dialog-intro');
      const head = node('div', 'sc-actions__dialog-head');
      const titleGroup = node('div', '');
      titleGroup.append(node('p', 'sc-actions__eyebrow', description.label));
      const title = node('h3', '', description.title);
      title.id = id + '-dialog-title';
      titleGroup.append(title);
      const close = button('关闭 ×', 'sc-actions__button sc-actions__button--quiet', () => dialog.close(), true);
      head.append(titleGroup, close);
      dialog.append(head, node('p', 'sc-actions__dialog-badge', description.badge));
      if (model.synthetic) dialog.append(node('p', 'sc-actions__synthetic', '虚构样例 · 不对应真实学者、真实任务或资格申请'));
      const intro = node('p', 'sc-actions__dialog-intro', description.intro);
      intro.id = id + '-dialog-intro';
      dialog.append(intro);
      description.sections.forEach(([heading, items]) => {
        const section = node('section', 'sc-actions__dialog-section');
        section.append(node('h4', '', heading), list(items, 'sc-actions__requirements'));
        dialog.append(section);
      });
      const footer = node('div', 'sc-actions__dialog-footer');
      footer.append(button('已了解，返回体检卡', 'sc-actions__button sc-actions__button--primary', () => dialog.close(), true));
      dialog.append(footer);
      on(dialog, 'close', () => { if (trigger && trigger.isConnected) trigger.focus(); }, true);
      on(dialog, 'click', event => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
      }, true);
      root.querySelector('.sc-actions').append(dialog);
      modal = dialog;
      dialog.showModal();
      close.focus();
    }

    function render() {
      model = deriveActions(data);
      cleanup();
      root.replaceChildren();
      const section = node('section', 'sc-actions');
      section.setAttribute('aria-labelledby', id + '-title');
      const header = node('header', 'sc-actions__header');
      const titles = node('div', '');
      titles.append(node('p', 'sc-actions__eyebrow', 'NEXT / 个人行动'));
      const title = node('h2', '', '让下一步，也能被验证');
      title.id = id + '-title';
      titles.append(title);
      header.append(titles, node('span', 'sc-actions__mode', '演示方案 · 尚未部署'));
      section.append(header);
      if (model.synthetic) section.append(node('p', 'sc-actions__synthetic', '虚构样例 · 以下为界面演示，不操作真实身份或学术记录'));

      if (model.recommendReviewer) {
        const recommendation = node('section', 'sc-actions__recommendation');
        const copy = node('div', 'sc-actions__recommendation-copy');
        copy.append(node('p', 'sc-actions__recommendation-label', '公开数据快照 ' + model.publicScore + ' 分 · 达到 75 分推荐线'), node('h3', '', '把经验变成可追溯的审稿贡献'), node('p', '', '身份、专业领域、利益冲突与审稿记录仍需核验。公开分数只是推荐入口。'));
        const reviewButton = button('推荐成为审稿专家 ↗', 'sc-actions__button sc-actions__button--primary', () => openDialog('reviewer', reviewButton));
        reviewButton.setAttribute('aria-haspopup', 'dialog');
        recommendation.append(copy, reviewButton);
        section.append(recommendation);
      }

      if (model.showTasks) {
        const taskHeader = node('div', 'sc-actions__task-header');
        taskHeader.append(node('h3', '', '提分任务'), node('p', '', model.lowConfidence ? '当前置信度低，先补充可核查的记录。' : '从一项有证据、有验收的贡献开始。'));
        section.append(taskHeader);
        const ledger = node('div', 'sc-actions__ledger');
        const publicScore = node('div', 'sc-actions__ledger-score');
        publicScore.append(node('span', '', '公开体检分 · v0'), node('strong', '', model.publicScore + ' / 100'));
        const proposed = node('div', 'sc-actions__ledger-proposal');
        proposed.append(node('strong', '', '行为贡献分 · 独立草案'), node('p', '', '以下 +5 / +3 / +8 是拟议贡献规则，不与 v0 相加。当前已入账 0 分；完成演示也不等于核验通过。'));
        ledger.append(publicScore, proposed);
        section.append(ledger);
        const grid = node('div', 'sc-actions__grid');
        const tasks = [
          { id: 'claim', number: '01', title: '认领错挂论文', points: CONTRIBUTION_RULE.claim, description: 'ORCID 身份与论文归属对得上，才形成可验证的认领。', verification: '核验：ORCID 授权 + 独立归属核对' },
          { id: 'references', number: '02', title: '复核参考文献', points: CONTRIBUTION_RULE.references, description: '逐条找到原始记录，让标题、作者、DOI 与核查结论都可追溯。', verification: '验收：核查清单 + 独立证据复核' },
          { id: 'reproduction', number: '03', title: '复现一个主张', points: CONTRIBUTION_RULE.reproduction, description: '交付完整环境和日志，让另一个人能按相同条件再次运行。', verification: '验收：原始日志 + 独立复跑' }
        ];
        tasks.forEach(task => {
          const taskCard = node('article', 'sc-actions__task');
          const top = node('div', 'sc-actions__task-top');
          top.append(node('span', 'sc-actions__task-number', task.number), node('span', 'sc-actions__potential', '+' + task.points + ' 贡献分 · 草案'));
          taskCard.append(top, node('h4', '', task.title), node('p', 'sc-actions__task-description', task.description), node('p', 'sc-actions__verification', task.verification));
          const state = task.id === 'claim' && model.claimPending ? '已演示认领 · 待 ORCID 核验' : task.id === 'claim' && model.synthetic ? '虚构案例 · 仅看规则' : task.id === 'claim' && !model.claimAvailable ? '当前无可认领的错挂记录' : '待核验 · 尚未入账';
          taskCard.append(node('p', 'sc-actions__task-state', state));
          const controls = node('div', 'sc-actions__task-controls');
          if (task.id === 'claim') {
            const claimButton = button(model.claimPending ? '已演示认领' : '认领 · 演示', 'sc-actions__button sc-actions__button--primary', () => {
              if (!model.claimAvailable || typeof options.onClaim !== 'function') return;
              options.onClaim(data);
            });
            claimButton.disabled = !model.claimAvailable || typeof options.onClaim !== 'function';
            if (model.claimAvailable && typeof options.onClaim !== 'function') claimButton.title = '当前页面尚未接入认领演示入口';
            controls.append(claimButton);
          }
          const details = button(task.id === 'claim' ? '核验要求' : '查看任务方案 ↗', 'sc-actions__button sc-actions__button--quiet', () => openDialog(task.id, details));
          details.setAttribute('aria-haspopup', 'dialog');
          controls.append(details);
          taskCard.append(controls);
          grid.append(taskCard);
        });
        section.append(grid);
      }

      const risks = node('details', 'sc-actions__risk');
      risks.append(node('summary', '', '哪些行为会触发复核？'));
      const riskBody = node('div', 'sc-actions__risk-body');
      riskBody.append(list([
        '同一稿件指纹在至少 2 家可信期刊同时在审：提示“疑似一稿多投，请核实”。可信期刊登记结案后解除对应在审状态；结案后改投不会单凭两条投稿记录触发该提示。',
        '近 7 天投稿达到 10 篇：提示“投稿频率异常”。频率提示本身不构成违规结论。'
      ], 'sc-actions__requirements'), node('p', '', '只有在行为事实核实、适用的公开规则明确后，才能决定是否调整分数。本演示不自动扣分，也没有定义扣分值；风险提示不是对当前学者的指控。'));
      risks.append(riskBody);
      section.append(risks);
      root.append(section);
    }

    const api = {
      update(next) {
        if (destroyed) return;
        deriveActions(next);
        data = next;
        render();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        cleanup();
        root.replaceChildren();
        instances.delete(root);
      }
    };
    render();
    instances.set(root, api);
    return api;
  }

  return Object.freeze({ mount, deriveActions, CONTRIBUTION_RULE });
});
