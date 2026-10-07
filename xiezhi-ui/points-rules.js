(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarPointsRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // The issuer's points-v0 policy, shared by the CLI and browser. These are
  // service rules, not additional enforcement inside the deployed ledger.
  const VERSION = 'points-v0';
  const RULES = Object.freeze(Object.fromEntries(Object.entries({
    NEWCOMER: { kind: 'award', amount: 20, label: '新手保护：认领 ORCID 成果后的初始廌点（一次）' },
    CLAIM_FIX: { kind: 'award', amount: 5, label: '认领并纠正一篇错挂论文' },
    CHECK: { kind: 'award', amount: 3, label: '核对一条参考文献或论文归属（多人比对一致）' },
    REVIEW: { kind: 'award', amount: 5, label: '完成一份被采纳的审稿意见（仅高分可接）' },
    REPRODUCE: { kind: 'award', amount: 8, label: '复现一个主张，独立复跑对得上' },
    MAINTAIN: { kind: 'award', amount: 2, label: '日常运维任务（数据纠错等）' },
    SUBMIT_LOW: { kind: 'spend', amount: 10, label: '低分档投稿：消耗廌点' },
  }).map(([key, rule]) => [key, Object.freeze(rule)])));
  const TIERS = Object.freeze([
    Object.freeze({ id: 'LOW', min: 0, label: '低分 · 投稿需消耗廌点', submitCost: RULES.SUBMIT_LOW.amount, canReview: false, priority: false }),
    Object.freeze({ id: 'MID', min: 60, label: '中分 · 入门，投稿免费', submitCost: 0, canReview: false, priority: false }),
    Object.freeze({ id: 'HIGH', min: 80, label: '高分 · 投稿免费 + 期刊优先 + 可审稿', submitCost: 0, canReview: true, priority: true }),
  ]);
  const tierOf = score => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100 ? [...TIERS].reverse().find(tier => score >= tier.min) : null;
  return Object.freeze({ VERSION, RULES_VERSION: VERSION, RULES, TIERS, tierOf });
});
