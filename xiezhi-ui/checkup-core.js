(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarCheckupCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  const DIMENSIONS = deepFreeze([
    { key: 'identity', label: '身份清晰度', max: 20 },
    { key: 'retractions', label: '撤稿与更正', max: 20 },
    { key: 'openAccess', label: '开放程度', max: 20 },
    { key: 'impact', label: '同领域影响力', max: 20 },
    { key: 'pace', label: '产出节奏', max: 20 }
  ]);

  // This is a published summary of checkup.py v0, not a source-code hash.
  const RULES = deepFreeze({
    version: 'v0',
    hashScope: '本对象是 checkup.py v0 的公开规则摘要；规则哈希不是 Python 源码哈希。',
    dataSource: 'OpenAlex 作者记录和该作者的作品记录；不查询 Crossref。',
    worksScope: '每页请求 200 条；无下一页或已取得至少 400 条时停止。统计只覆盖取得的作品。',
    rounding: '公式中的 round 采用 Python round：半数时取偶数。页面只合计上游已给出的五维分数。',
    dimensions: [
      { key: 'identity', label: '身份清晰度', max: 20,
        formula: '(ORCID 存在 ? 10 : 0) + round(10 × 主领域作品数 / 有 primary_topic.field.display_name 的作品数)',
        missing: '无有效领域时，一致性按 0 计算。',
        fields: ['author.orcid', 'work.primary_topic.field.display_name'] },
      { key: 'retractions', label: '撤稿与更正', max: 20,
        formula: 'max(0, 20 − 10 × is_retracted 为真的作品数)',
        missing: 'v0 仅检查 OpenAlex 撤稿标记，没有单独核查更正记录；0 条撤稿不等于不存在问题。',
        fields: ['work.is_retracted'] },
      { key: 'openAccess', label: '开放程度', max: 20,
        formula: 'round(20 × 开放获取作品数 / 已取得作品总数)',
        missing: '没有作品时按 0 分计算。',
        fields: ['work.open_access.is_oa'] },
      { key: 'impact', label: '同领域影响力', max: 20,
        formula: 'round(min(20, 10 × 非空 FWCI 的中位数))',
        missing: '没有非空 FWCI 时按 0 分计算。FWCI 1.0 为世界平均参照。',
        fields: ['work.fwci'] },
      { key: 'pace', label: '产出节奏', max: 20,
        formula: '单年最多作品数 ≤ 15：20 分；≤ 30：12 分；≤ 60：6 分；其余：0 分。',
        missing: '没有作品时单年最多作品数为 0；按脚本仍为 20 分。',
        fields: ['work.publication_year'] }
    ],
    confidence: '已取得作品数 < 10：低；< 30：中；其余：高。这是数量分档，不是统计置信概率。',
    limits: [
      '本页呈现仓库数据快照及证据说明，没有重新请求或独立核实 OpenAlex 的实时记录。',
      '证据链接打开 OpenAlex 当前记录，可能与快照不同；摘要证据不足以重新运行完整 v0 脚本。',
      '可核查度是演示规则得分，不是人品、学术诚信、研究真实性或学术质量的判定。',
      '本地认领只记录演示声明，不修改 OpenAlex，不执行钱包签名，也不证明论文归属。'
    ]
  });

  function canonicalJSON(value) {
    const seen = new Set();
    function encode(item) {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
      if (typeof item === 'number') {
        if (!Number.isFinite(item)) throw new TypeError('规范 JSON 不接受非有限数字。');
        return JSON.stringify(item);
      }
      if (typeof item !== 'object') throw new TypeError('规范 JSON 只接受 JSON 数据，不接受 undefined、函数或 BigInt。');
      if (seen.has(item)) throw new TypeError('规范 JSON 不接受循环引用。');
      const prototype = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('规范 JSON 只接受普通对象和数组。');
      }
      seen.add(item);
      let result;
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i += 1) {
          if (!Object.prototype.hasOwnProperty.call(item, i)) throw new TypeError('规范 JSON 不接受稀疏数组。');
        }
        result = '[' + item.map(encode).join(',') + ']';
      } else {
        result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
      }
      seen.delete(item);
      return result;
    }
    return encode(value);
  }

  function snapshot(value) {
    return JSON.parse(canonicalJSON(value));
  }

  function requiredText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(label + '必须为非空文本。');
    return value;
  }

  function count(value, label, max) {
    if (!Number.isSafeInteger(value) || value < 0 || (max !== undefined && value > max)) {
      throw new TypeError(label + '必须为合法的非负整数' + (max !== undefined ? '，且不超过 ' + max : '') + '。');
    }
    return value;
  }

  function authorId(value) {
    if (typeof value !== 'string') return null;
    const match = /^(?:https:\/\/openalex\.org\/)?(A[0-9]+)$/.exec(value);
    return match ? match[1] : null;
  }

  function orcidUrl(value) {
    if (typeof value !== 'string') return null;
    const match = /^(?:https:\/\/orcid\.org\/)?([0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X])$/.exec(value);
    return match ? 'https://orcid.org/' + match[1] : null;
  }

  function normalizeCase(raw, meta = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('案例必须为对象。');
    const original = snapshot(raw);
    const synthetic = original.openalex === 'SYNTHETIC' || original.synthetic === true;
    const id = synthetic ? 'SYNTHETIC' : authorId(original.openalex);
    if (!id) throw new TypeError('案例缺少合法 OpenAlex 作者 ID。');
    const name = requiredText(original.name, '姓名');
    if (!Array.isArray(original.institutions) || original.institutions.some(item => typeof item !== 'string')) {
      throw new TypeError('机构必须为文本数组。');
    }
    if (!original.dims || typeof original.dims !== 'object' || Array.isArray(original.dims)) {
      throw new TypeError('案例必须提供完整五维分数。');
    }
    const keys = Object.keys(original.dims);
    if (keys.length !== DIMENSIONS.length || DIMENSIONS.some(dim => !Object.prototype.hasOwnProperty.call(original.dims, dim.label))) {
      throw new TypeError('案例必须且只能提供规定的五个维度。');
    }
    const dims = DIMENSIONS.map((dim, index) => {
      const text = original.dims[dim.label];
      const match = typeof text === 'string' && /^(0|[1-9]|1[0-9]|20)\/20（([\s\S]+)）$/.exec(text);
      if (!match || !match[2].trim()) throw new TypeError(dim.label + '必须为 0–20 的整数分数及原始证据说明，例如 10/20（证据）。');
      const rule = RULES.dimensions[index];
      return {
        key: dim.key,
        label: dim.label,
        value: Number(match[1]),
        max: 20,
        evidence: match[2],
        sourceUrl: synthetic ? null : dim.key === 'identity'
          ? 'https://api.openalex.org/authors/' + id
          : 'https://api.openalex.org/works?filter=author.id:' + id + '&per-page=200',
        rule: rule.formula + ' ' + rule.missing
      };
    });
    let misattributed = null;
    if (original.misattributed !== undefined && original.misattributed !== null) {
      if (synthetic || !authorId(original.misattributed.wrong_profile)) throw new TypeError('错挂档案必须为合法 OpenAlex 作者 ID。');
      misattributed = {
        wrong_profile: authorId(original.misattributed.wrong_profile),
        wrong_orcid: orcidUrl(original.misattributed.wrong_orcid),
        paper: requiredText(original.misattributed.paper, '待认领论文')
      };
    }
    const score = dims.reduce((sum, dim) => sum + dim.value, 0);
    const reportedScore = count(original.score, '上游总分', 100);
    return {
      id, name,
      label: original.case_label ? requiredText(original.case_label, '案例标签') : name,
      institutions: original.institutions.slice(),
      orcid: synthetic ? null : orcidUrl(original.orcid),
      works: count(original.works, '作品数'),
      citedBy: count(original.cited_by, '引用数'),
      hIndex: count(original.h_index, 'h 指数'),
      score, reportedScore, scoreMismatch: score !== reportedScore,
      confidence: requiredText(original.confidence, '置信度'),
      synthetic,
      note: typeof original.note === 'string' ? original.note : '',
      misattributed, dims,
      raw: deepFreeze(original),
      generated: meta.generated === undefined ? null : requiredText(meta.generated, '快照生成日期'),
      source: meta.source === undefined ? 'aia/product/mock_cases.json' : requiredText(meta.source, '快照来源')
    };
  }

  function normalizedBaseline(normalized) {
    if (!normalized || !normalized.raw) throw new TypeError('需要 normalizeCase 生成的案例。');
    const base = normalizeCase(normalized.raw, {
      ...(normalized.generated === null ? {} : { generated: normalized.generated }),
      source: normalized.source
    });
    ['id', 'name', 'institutions', 'orcid', 'works', 'citedBy', 'hIndex', 'score', 'reportedScore',
      'scoreMismatch', 'confidence', 'synthetic', 'misattributed', 'dims'].forEach(field => {
      if (canonicalJSON(normalized[field]) !== canonicalJSON(base[field])) {
        throw new TypeError('案例展示字段与原始快照不一致：' + field + '。');
      }
    });
    return base;
  }

  function expectedClaim(normalized) {
    if (!normalized.misattributed || normalized.synthetic) throw new TypeError('此案例没有可演示认领的错挂论文。');
    return {
      simulation: true,
      paper: normalized.misattributed.paper,
      fromProfile: normalized.misattributed.wrong_profile,
      toProfile: normalized.id,
      method: 'local-demo-acknowledgement'
    };
  }

  function verifiedClaim(normalized, claim) {
    if (claim === null) return null;
    const expected = expectedClaim(normalized);
    if (canonicalJSON(claim) !== canonicalJSON(expected)) throw new TypeError('认领声明与本案例的演示范围不一致。');
    return expected;
  }

  function recomputeAfterClaim(normalized) {
    const base = normalizedBaseline(normalized);
    const claim = expectedClaim(base);
    if (normalized.claim !== undefined && canonicalJSON(normalized.claim) !== canonicalJSON(claim)) {
      throw new TypeError('已有认领声明不符合本案例。');
    }
    return {
      ...base,
      claimSimulation: true,
      baseScore: base.score,
      localWorks: base.works + 1,
      claimedPaper: base.misattributed.paper,
      claim,
      recalculationNotice: '已在本地演示档案加入认领声明，并重新合计现有五维分数。新论文的开放获取、FWCI 等指标尚未回填，因此总分暂为 ' + base.score + ' 分；这不是重新运行完整 v0 打分，也没有修改 OpenAlex 记录。'
    };
  }

  async function sha256(text) {
    if (typeof text !== 'string') throw new TypeError('SHA-256 的输入必须为文本。');
    if (!globalThis.crypto || !globalThis.crypto.subtle || typeof globalThis.crypto.subtle.digest !== 'function') {
      throw new Error('当前浏览器缺少 Web Crypto SHA-256。请通过 localhost 或 HTTPS 打开；不会生成替代或虚构哈希。');
    }
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function isoTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new TypeError('收据时间必须为包含时区的 ISO 时间。');
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new TypeError('收据时间不是有效日期。');
    return parsed.toISOString();
  }

  async function createReceipt(normalized, options = {}) {
    const base = normalizedBaseline(normalized);
    const claim = verifiedClaim(base, options.claim === undefined ? (normalized.claim || null) : options.claim);
    const timestamp = isoTimestamp(options.now === undefined ? new Date().toISOString() : options.now);
    const [subjectIdHash, snapshotHash, rulesHash] = await Promise.all([
      sha256(canonicalJSON({ scheme: base.synthetic ? 'synthetic-example' : 'openalex-author', id: base.id })),
      sha256(canonicalJSON({ case: base.raw, generated: base.generated, source: base.source, claim })),
      sha256(canonicalJSON(RULES))
    ]);
    const receipt = {
      schema: 'scholar-checkup-receipt/v1',
      simulation: true,
      chainStatus: 'not-submitted',
      subjectIdHash, snapshotHash,
      rulesVersion: 'v0', rulesHash,
      score: base.score,
      reportedScore: base.reportedScore,
      scoreMismatch: base.scoreMismatch,
      confidence: base.confidence,
      timestamp
    };
    if (claim) receipt.claim = claim;
    receipt.receiptHash = await sha256(canonicalJSON(receipt));
    return receipt;
  }

  async function verifyReceipt(receipt, normalized, options = {}) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return { valid: false, checks: { structure: false }, errors: ['收据必须为 JSON 对象。'] };
    }
    let expected;
    try {
      expected = await createReceipt(normalized, {
        claim: options.claim === undefined ? (normalized.claim || null) : options.claim,
        now: receipt.timestamp
      });
    } catch (error) {
      if (error.message.includes('Web Crypto')) throw error;
      return { valid: false, checks: { reference: false }, errors: [error.message] };
    }
    const checks = {};
    const fields = ['schema', 'simulation', 'chainStatus', 'subjectIdHash', 'snapshotHash', 'rulesVersion',
      'rulesHash', 'score', 'reportedScore', 'scoreMismatch', 'confidence', 'timestamp', 'claim'];
    fields.forEach(field => {
      checks[field] = canonicalJSON(receipt[field] === undefined ? null : receipt[field]) ===
        canonicalJSON(expected[field] === undefined ? null : expected[field]);
    });
    checks.structure = canonicalJSON(Object.keys(receipt).sort()) === canonicalJSON(Object.keys(expected).sort());
    try {
      const { receiptHash, ...unsigned } = receipt;
      checks.receiptHash = typeof receiptHash === 'string' && receiptHash === await sha256(canonicalJSON(unsigned));
    } catch (error) {
      if (error.message.includes('Web Crypto')) throw error;
      checks.receiptHash = false;
    }
    const errors = Object.entries(checks).filter(([, valid]) => !valid).map(([field]) => '核验不一致：' + field);
    return { valid: errors.length === 0, checks, errors };
  }

  return Object.freeze({ DIMENSIONS, RULES, normalizeCase, canonicalJSON, sha256, createReceipt, verifyReceipt, recomputeAfterClaim });
});
