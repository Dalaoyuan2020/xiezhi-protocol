/* Evidence is a view of the saved record. It never fills missing inputs from scores. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarEvidenceCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function text(value, fallback) { return typeof value === 'string' && value.trim() ? value : fallback; }
  function frozen(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
    return value;
  }
  function row(field, value, status, label) { return { field, label: label || field, value: String(value), status }; }
  function validNumber(value, max) { return Number.isFinite(value) && value >= 0 && (max === undefined || value <= max); }
  function summary(evidence, expression, format, max) {
    const match = expression.exec(evidence);
    if (!match || !validNumber(Number(match[1]), max)) return null;
    return format(match);
  }
  function worksEvidence(profile, scored, synthetic) {
    const raw = profile.raw || profile;
    const hasCount = Number.isSafeInteger(raw.works) && raw.works >= 0;
    // The case snapshot names checkup.py v0 as its source. That script returns works = len(ws),
    // whereas the separately collected candidate snapshot uses the author's library count.
    const kind = !scored ? 'author-record' : synthetic ? 'synthetic-sample'
      : /checkup\.py\s+v0/.test(profile.source || '') ? 'script-sample' : 'unconfirmed';
    const labels = {
      'author-record': '作者库收录作品数 · 候选快照',
      'script-sample': '已取得样本数 · 脚本输出 works',
      'synthetic-sample': '演示样本数 · 虚构 works 字段',
      unconfirmed: '快照 works 字段 · 采样口径待核实'
    };
    return { kind, row: row('works', hasCount ? raw.works : '字段缺失', hasCount ? 'raw' : 'missing', labels[kind]) };
  }
  function rowsForDimension(key, evidence, profile, works) {
    const raw = profile.raw || profile;
    const rows = [];
    const missing = [];
    let extracted = null;
    if (key === 'identity') {
      rows.push(row('orcid', raw.orcid === null ? 'null · 快照未提供 ORCID' : text(raw.orcid, '字段缺失'), Object.prototype.hasOwnProperty.call(raw, 'orcid') ? 'raw' : 'missing', 'ORCID 原始字段'));
      const match = /主领域\s+([^；，。]+?)\s+占\s+(\d+(?:\.\d+)?)%(?=$|[；，。\s])/.exec(evidence);
      if (match && validNumber(Number(match[2]), 100)) extracted = match[1].trim() + ' · ' + match[2] + '%';
      if (extracted !== null) rows.push(row('主领域及占比', extracted, 'summary'));
      missing.push('主领域作品数、有 primary_topic.field 的作品数及逐作品领域字段');
    } else if (key === 'retractions') {
      extracted = summary(evidence, /(?:^|[；，\s])撤稿\s+(\d+)\s+篇(?=$|[；，。\s])/, m => m[1] + ' 篇');
      if (extracted !== null) rows.push(row('撤稿数', extracted, 'summary'));
      missing.push('逐作品 is_retracted 标记及独立更正记录');
    } else if (key === 'openAccess') {
      extracted = summary(evidence, /(?:^|[；，\s])开放获取\s+(\d+(?:\.\d+)?)%(?=$|[；，。\s])/, m => m[1] + '%', 100);
      if (extracted !== null) rows.push(row('开放获取占比', extracted, 'summary'));
      missing.push('开放获取作品数及逐作品 open_access.is_oa');
      if (works.kind === 'unconfirmed') missing.push('评分分母的采样口径（快照 works 值已保存，但来源未确认其含义）');
    } else if (key === 'impact') {
      extracted = summary(evidence, /(?:^|[；，\s])FWCI\s+中位数\s+(\d+(?:\.\d+)?)(?=$|[；，。\s])/, m => m[1]);
      if (extracted !== null) rows.push(row('FWCI 中位数', extracted, 'summary'));
      missing.push('非空 FWCI 样本数及逐作品 FWCI 数值');
    } else if (key === 'pace') {
      extracted = summary(evidence, /(?:^|[；，\s])单年最多\s+(\d+)\s+篇(?:，\s*((?:19|20)\d{2}))?(?=$|[；，。\s])/, m => m[1] + ' 篇' + (m[2] ? ' · ' + m[2] + ' 年' : ' · 年份未保存'));
      if (extracted !== null) rows.push(row('单年峰值', extracted, 'summary'));
      missing.push('逐年作品计数及逐作品 publication_year');
    }
    rows.push(works.row);
    if (extracted === null) rows.push(row('摘要解析', '未解析 · 保留上方原始说明', 'missing'));
    missing.forEach(value => rows.push(row('缺失输入', value + ' · 快照未保存', 'missing')));
    return { rows, missing, parsed: extracted !== null };
  }
  function createModel(profile, options) {
    profile = profile || {}; options = options || {};
    const scored = Array.isArray(profile.dims);
    const raw = profile.raw || profile;
    const synthetic = Boolean(profile.synthetic);
    const id = text(profile.id, text(profile.openalex, 'ID 未提供'));
    const validId = /^A\d+$/.test(id);
    const expectedSource = validId && !synthetic ? 'https://api.openalex.org/authors/' + id : null;
    const authorUrl = scored ? expectedSource : profile.sourceUrl === expectedSource ? expectedSource : null;
    const rules = options.rules || {};
    const works = worksEvidence(profile, scored, synthetic);
    const identity = [
      row(scored ? 'openalex' : 'id', id, 'raw', '档案 ID'),
      row('orcid', raw.orcid === null ? 'null · 快照未提供 ORCID' : text(raw.orcid, '字段缺失'), Object.prototype.hasOwnProperty.call(raw, 'orcid') ? 'raw' : 'missing', 'ORCID'),
      row('institutions', Array.isArray(profile.institutions) && profile.institutions.length ? profile.institutions.join(' / ') : '未提供', Array.isArray(profile.institutions) ? 'raw' : 'missing', '公开库当前单位'),
      works.row
    ];
    const dimensions = scored ? profile.dims.map((dim, index) => {
      const input = rowsForDimension(dim.key, text(dim.evidence, ''), profile, works);
      const rule = Array.isArray(rules.dimensions) ? rules.dimensions[index] : null;
      return {
        key: dim.key, label: dim.label, score: dim.value, max: dim.max || 20,
        rawText: raw.dims && typeof raw.dims[dim.label] === 'string' ? raw.dims[dim.label] : text(dim.evidence, '此项说明未保存'),
        evidence: text(dim.evidence, '此项说明未保存'),
        inputRows: input.rows, missing: input.missing, summaryParsed: input.parsed,
        rule: rule ? rule.formula : text(dim.rule, '规则摘要未保存'),
        ruleLimit: rule ? rule.missing : '未保存逐作品输入，无法从本地摘要独立复算。',
        currentUrl: synthetic || !validId ? null : dim.key === 'identity' ? authorUrl : 'https://api.openalex.org/works?filter=author.id:' + id + '&per-page=200'
      };
    }) : [];
    return frozen({
      kind: scored ? 'scored' : 'candidate', id, name: text(profile.name, '学者档案'), synthetic,
      snapshotDate: text(profile.snapshotDate, text(profile.generated, text(options.generated, '未提供'))),
      fetchedAt: text(profile.fetchedAt, ''), source: text(profile.provenance, text(profile.source, '本地公开候选快照')),
      snapshotHref: scored ? '../product/mock_cases.json' : 'search-data.json',
      snapshotLabel: scored ? 'mock_cases.json · 本地评分快照' : 'search-data.json · 本地候选快照',
      ruleVersion: scored ? text(rules.version, 'v0') : null,
      worksCountKind: works.kind,
      worksScope: scored ? text(rules.worksScope, '统计范围说明未保存。') : '本地候选快照 · 仅作者身份及来源线索',
      scopeLimit: !scored ? '候选 works 为作者库收录作品数。候选快照没有五维评分，不能引用其他案例分数。'
        : works.kind === 'script-sample' ? 'works 是 checkup.py v0 输出的已取得作品数（快照记录），可作为总样本数。快照未保存逐作品明细、开放获取分子及有效领域或 FWCI 的样本数；不能从已取整摘要或分数反推这些输入。'
          : works.kind === 'synthetic-sample' ? 'works 是虚构快照中的演示样本数，不是真实取得记录。快照没有逐作品明细；缺失分子和有效样本数不会由摘要或分数反推。'
            : '快照已保存 works 字段，来源说明未确认其采样口径。逐作品明细及开放获取、有效领域或 FWCI 的输入仍不完整；无法据此独立复算。',
      identity, dimensions, authorUrl,
      affiliations: Array.isArray(profile.affiliations) ? profile.affiliations.map(item => ({ name: text(item.name, '单位未提供'), years: Array.isArray(item.years) ? item.years.map(String) : [] })) : [],
      topics: Array.isArray(profile.topics) ? profile.topics.map(String) : [],
      identityNote: text(profile.identityNote, ''), note: text(profile.note, ''),
      claimNotice: profile.claimSimulation ? text(profile.recalculationNotice, '本地认领演示沿用原快照分项；原始输入未增加。') : '',
      missingInputs: scored,
      limit: '可核查度 ≠ 人品分。公开库可能合并或拆分作者，身份与单位仍需核对；未发现撤稿记录不等于研究结论已验证。'
    });
  }
  return Object.freeze({ createModel });
});
