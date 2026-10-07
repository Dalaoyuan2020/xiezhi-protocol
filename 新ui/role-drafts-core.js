(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScholarRoleDrafts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const MAX_BYTES = 256 * 1024;
  const MAX_ATTACHMENTS = 40;
  const MAX_ATTACHMENT_LENGTH = 240;
  const RECOMMENDATIONS = Object.freeze(['', 'major-revision', 'minor-revision', 'accept', 'reject', 'unable-to-assess']);
  const RECOMMENDATION_LABELS = Object.freeze({ '': '尚未填写', 'major-revision': '大修后再评估', 'minor-revision': '小修后再评估', accept: '建议接收', reject: '建议不接收', 'unable-to-assess': '材料不足，暂无法判断' });
  const FIELDS = Object.freeze({
    reviewer: Object.freeze({
      summary: Object.freeze({ label: '研究理解与总体评价', max: 8000, required: true }),
      strengths: Object.freeze({ label: '主要优点', max: 8000, required: true }),
      concerns: Object.freeze({ label: '主要问题与证据依据', max: 12000, required: true }),
      questions: Object.freeze({ label: '给作者的问题或修改建议', max: 8000 }),
      recommendation: Object.freeze({ label: '草稿建议', max: 32, required: true }),
      conflictStatement: Object.freeze({ label: '利益冲突与评议范围说明', max: 4000, required: true }),
      notes: Object.freeze({ label: '个人工作备注', max: 8000 })
    }),
    submitter: Object.freeze({
      title: Object.freeze({ label: '稿件题目', max: 240, required: true }),
      authors: Object.freeze({ label: '作者与单位', max: 4000, required: true }),
      orcid: Object.freeze({ label: '联系人 ORCID', max: 64 }),
      targetJournal: Object.freeze({ label: '拟投期刊或渠道', max: 240 }),
      keywords: Object.freeze({ label: '关键词', max: 500 }),
      abstract: Object.freeze({ label: '摘要', max: 12000, required: true }),
      methods: Object.freeze({ label: '方法或材料说明', max: 16000, required: true }),
      attachments: Object.freeze({ label: '附件清单', max: 12000, required: true }),
      ethics: Object.freeze({ label: '伦理或数据来源声明', max: 8000, required: true }),
      dataAvailability: Object.freeze({ label: '数据与代码可用性说明', max: 8000 })
    })
  });
  const SAMPLE = Object.freeze({
    id: 'FICTIONAL-REVIEW-001',
    fictional: true,
    title: '校园共享自习座位信息对等待时间的影响：一项虚构试点研究',
    authors: '示例作者甲、示例作者乙（均为虚构人物）',
    abstract: '本示例讨论共享座位信息是否可能缩短自习室的等待时间。研究设计假设在同一校园的两个自习室招募 24 名志愿者，以四周观察比较启用座位信息前后的自报等待时间。示例结果呈现下降趋势，但不支持因果结论。文中全部人物、场景和数值为教学演示编写，不对应真实研究。',
    methods: '虚构设计：第 1–2 周不提供座位信息，第 3–4 周在入口显示人工每 30 分钟更新的空位数。24 名志愿者每周记录两次到达时间、入座时间和当时是否查看信息。计划以每位参与者的周平均等待时间作为分析单位，配对比较前后变化；未安排随机分组，也未控制考试周、天气或自习室容量。示例未提供原始记录、统计代码或伦理批准文件。',
    results: '虚构结果：24 名志愿者中 20 人完成全部四周记录。完成者的平均等待时间在前两周为 12.4 分钟，在后两周为 8.7 分钟；差值为 3.7 分钟。示例只给出总体平均值，未提供方差、置信区间、缺失记录分布或预先设定的分析计划。数字只用于练习如何发现证据缺口。',
    limitations: '样本为便利抽样且规模较小；前后比较可能混入时间趋势；4 人未完成记录，缺失原因未知；自报等待时间可能存在测量误差；无法区分信息展示与座位供给变化的影响。缺乏原始数据时，无法验证数值或复算结论。应先明确这些限制，再形成评议建议。'
  });

  function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function roleSpec(role) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, role)) throw new TypeError('未知工作视角。');
    return FIELDS[role];
  }
  function storageKey(role) { roleSpec(role); return 'xiezhi.local-draft.' + role + '.v1'; }
  function blankFields(role) { return Object.fromEntries(Object.keys(roleSpec(role)).map(key => [key, ''])); }
  function utf8Bytes(text) { return new TextEncoder().encode(text).length; }
  function validTime(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function normalizeFields(role, input, requireAll) {
    const spec = roleSpec(role);
    if (!plainObject(input)) throw new TypeError('草稿字段必须为文本对象。');
    if (Object.keys(input).some(key => !Object.prototype.hasOwnProperty.call(spec, key))) throw new TypeError('草稿包含无法识别的字段。');
    const fields = blankFields(role);
    for (const [key, config] of Object.entries(spec)) {
      if (requireAll && !Object.prototype.hasOwnProperty.call(input, key)) throw new TypeError('草稿缺少字段：' + config.label + '。');
      const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : '';
      if (typeof value !== 'string') throw new TypeError(config.label + '必须为文本。');
      if (value.length > config.max) throw new TypeError(config.label + '超过 ' + config.max + ' 字符上限。');
      fields[key] = value;
    }
    if (role === 'reviewer' && !RECOMMENDATIONS.includes(fields.recommendation)) throw new TypeError('无法识别草稿建议。');
    return fields;
  }
  function createDraft(role, fields, capturedAt) {
    const timestamp = capturedAt === undefined ? new Date().toISOString() : capturedAt;
    if (!validTime(timestamp)) throw new TypeError('草稿时间无效。');
    const draft = { format: 'xiezhi-local-draft', schemaVersion: VERSION, role, localDraft: true, noSubmission: true, submissionStatus: 'not-submitted', capturedAt: timestamp, fields: normalizeFields(role, fields, false) };
    if (role === 'reviewer') draft.material = { id: SAMPLE.id, fictional: true, authorizedReviewTask: false };
    return draft;
  }
  function verifyDraft(input, role) {
    roleSpec(role);
    if (!plainObject(input) || input.format !== 'xiezhi-local-draft' || input.schemaVersion !== VERSION || input.role !== role || input.localDraft !== true || input.noSubmission !== true || input.submissionStatus !== 'not-submitted') throw new TypeError('本地草稿格式或工作视角不匹配；未恢复任何内容。');
    const allowed = ['format', 'schemaVersion', 'role', 'localDraft', 'noSubmission', 'submissionStatus', 'capturedAt', 'fields'].concat(role === 'reviewer' ? ['material'] : []);
    if (Object.keys(input).some(key => !allowed.includes(key)) || !validTime(input.capturedAt)) throw new TypeError('草稿字段或记录时间无效；未恢复任何内容。');
    if (role === 'reviewer' && (!plainObject(input.material) || input.material.id !== SAMPLE.id || input.material.fictional !== true || input.material.authorizedReviewTask !== false || Object.keys(input.material).length !== 3)) throw new TypeError('草稿材料必须对应本页的虚构示例，不能作为真实审稿任务恢复。');
    return createDraft(role, normalizeFields(role, input.fields, true), input.capturedAt);
  }
  function serializeDraft(draft) {
    const verified = verifyDraft(draft, draft.role);
    const text = JSON.stringify(verified);
    if (utf8Bytes(text) > MAX_BYTES) throw new TypeError('草稿超过 256 KiB 上限，请缩短文本后再保存或导出。');
    return text;
  }
  function parseDraft(raw, role) {
    if (typeof raw !== 'string' || raw.length > MAX_BYTES || utf8Bytes(raw) > MAX_BYTES) throw new TypeError('本地草稿过大或不是有效文本；未恢复任何内容。');
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new TypeError('本地草稿 JSON 损坏；未恢复任何内容。可以继续编辑和导出当前内容。'); }
    return verifyDraft(data, role);
  }
  function storageError(action, error) {
    const reason = error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') ? '浏览器存储空间不足' : '浏览器存储不可用或读取受限';
    return reason + '，' + action + '失败。当前编辑内容仍可导出。';
  }
  function backupKey(role) { return storageKey(role) + '.backup'; }
  function lockName(role) { return storageKey(role) + '.write'; }
  function readSnapshot(storage, role, backup) {
    let raw;
    try { raw = storage.getItem(backup ? backupKey(role) : storageKey(role)); }
    catch (error) { return { ok: false, code: 'read-failed', raw: undefined, draft: null, error: storageError('读取', error) }; }
    if (raw === null) return { ok: true, raw: null, draft: null };
    try { return { ok: true, raw, draft: parseDraft(raw, role) }; }
    catch (error) { return { ok: false, code: 'corrupt', raw, draft: null, error: error.message }; }
  }
  function readDraft(storage, role) {
    const result = readSnapshot(storage, role);
    return result.ok ? { ok: true, draft: result.draft } : { ok: false, error: result.error };
  }
  function hasContent(fields) { return Object.values(fields).some(value => value.trim().length > 0); }
  // A save requires an exclusive same-role browser lock. There is no unsafe fallback.
  // expectedRaw is the exact string observed by the caller, independent of editor dirty state.
  async function saveDraft(storage, role, fields, capturedAt, options) {
    options = options || {};
    let draft, raw;
    try { draft = createDraft(role, fields, capturedAt); raw = serializeDraft(draft); }
    catch (error) { return { ok: false, code: 'invalid', writeAttempted: false, error: error.message }; }
    if (!options.locks || typeof options.locks.request !== 'function') return { ok: false, code: 'lock-unavailable', writeAttempted: false, error: '此浏览器无法提供安全保存所需的 Web Locks。当前编辑已保留，请导出 JSON 或 Markdown。' };
    const expectedRaw = Object.prototype.hasOwnProperty.call(options, 'expectedRaw') ? options.expectedRaw : null;
    if (expectedRaw !== null && typeof expectedRaw !== 'string') return { ok: false, code: 'invalid-expectation', writeAttempted: false, error: '保存前的原文状态未知，请重新读取已保存稿。当前编辑已保留。' };
    try {
      return await options.locks.request(lockName(role), { mode: 'exclusive' }, () => {
        let previous;
        try { previous = storage.getItem(storageKey(role)); }
        catch (error) { return { ok: false, code: 'read-failed', writeAttempted: false, error: storageError('保存前读取', error) }; }
        if (previous !== expectedRaw) return { ok: false, code: 'conflict', currentRaw: previous, writeAttempted: false, error: '已保存稿已被其他页面修改。请重新阅读最新摘要并确认覆盖，或恢复最新稿；当前编辑已保留。' };
        if (previous !== null && !hasContent(draft.fields)) {
          let validPrevious;
          try { validPrevious = parseDraft(previous, role); } catch (_) {}
          if (validPrevious && hasContent(validPrevious.fields)) return { ok: false, code: 'empty-overwrite', writeAttempted: false, error: '全空编辑不能覆盖有效的已保存稿。新稿只清空编辑区；原稿仍可恢复或导出。' };
        }
        if (previous !== null) {
          try {
            storage.setItem(backupKey(role), previous);
            if (storage.getItem(backupKey(role)) !== previous) return { ok: false, code: 'backup-verification-failed', writeAttempted: false, error: '原文备份校验未通过，未覆盖已保存稿。请下载原文或导出当前编辑。' };
          } catch (error) { return { ok: false, code: 'backup-failed', writeAttempted: false, error: storageError('原文备份', error) + ' 未覆盖已保存稿。' }; }
        }
        try { storage.setItem(storageKey(role), raw); }
        catch (error) { return { ok: false, code: 'write-failed', writeAttempted: true, storageMayHaveChanged: true, error: storageError('保存', error) + ' 未能确认浏览器中的最终内容；可重新读取已保存稿并导出当前编辑。' }; }
        let verifiedRaw;
        try { verifiedRaw = storage.getItem(storageKey(role)); }
        catch (error) { return { ok: false, code: 'verification-read-failed', writeAttempted: true, storageMayHaveChanged: true, error: '写入后读取失败，未确认保存。浏览器中的原稿可能已变化；未执行回滚。请导出当前编辑，并重新读取已保存稿或备份。' }; }
        if (verifiedRaw !== raw) return { ok: false, code: 'verification-failed', currentRaw: verifiedRaw, writeAttempted: true, storageMayHaveChanged: true, error: '保存后校验未通过，未确认保存。浏览器中的原稿可能已变化；未执行回滚。请导出当前编辑，并重新读取已保存稿或备份。' };
        return { ok: true, draft, raw, backupRaw: previous, writeAttempted: true };
      });
    } catch (_) { return { ok: false, code: 'lock-failed', writeAttempted: false, error: '安全保存锁获取失败，未执行保存。当前编辑已保留，请导出文件后重试。' }; }
  }
  function parseAttachments(value) {
    if (typeof value !== 'string') throw new TypeError('附件清单必须为文本。');
    const list = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (list.length > MAX_ATTACHMENTS) throw new TypeError('附件清单最多 ' + MAX_ATTACHMENTS + ' 项，请合并或缩减后导出。');
    if (list.some(line => line.length > MAX_ATTACHMENT_LENGTH)) throw new TypeError('附件清单每项最多 ' + MAX_ATTACHMENT_LENGTH + ' 字符，请将长说明移至方法或材料说明。');
    return list;
  }
  function validOrcid(value) {
    const text = value.trim().replace(/^https:\/\/orcid\.org\//i, '').toUpperCase();
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(text)) return false;
    const digits = text.replace(/-/g, '');
    let total = 0;
    for (let i = 0; i < 15; i += 1) total = (total + Number(digits[i])) * 2;
    const remainder = (12 - (total % 11)) % 11;
    return digits[15] === (remainder === 10 ? 'X' : String(remainder));
  }
  function checkFields(role, input) {
    const missing = [], issues = [];
    let fields;
    try { fields = normalizeFields(role, input, false); } catch (error) { return { complete: false, missing, issues: [error.message] }; }
    for (const [key, config] of Object.entries(roleSpec(role))) if (config.required && !fields[key].trim()) missing.push({ key, label: config.label });
    if (role === 'submitter') {
      if (fields.orcid.trim() && !validOrcid(fields.orcid)) issues.push('ORCID 格式或校验位无效；留空也可保存和导出。格式校验不验证身份。');
      try { parseAttachments(fields.attachments); } catch (error) { issues.push(error.message); }
    }
    return { complete: missing.length === 0 && issues.length === 0, missing, issues };
  }
  const PARAGRAPHS = Object.freeze([
    Object.freeze({ number: 'P01', key: 'abstract', label: '摘要', anchor: 'rv-sample-abstract' }),
    Object.freeze({ number: 'P02', key: 'methods', label: '方法与材料', anchor: 'rv-sample-methods' }),
    Object.freeze({ number: 'P03', key: 'results', label: '结果', anchor: 'rv-sample-results' }),
    Object.freeze({ number: 'P04', key: 'limitations', label: '局限', anchor: 'rv-sample-limitations' })
  ]);
  function paragraph(number) {
    const item = PARAGRAPHS.find(value => value.number === number);
    if (!item) throw new TypeError('无法识别本页材料段落。');
    return item;
  }
  function referenceBlock(number) {
    const item = paragraph(number);
    return '[材料 ' + SAMPLE.id + ' · ' + item.number + ' · ' + item.label + ']\n> ' + SAMPLE[item.key] + '\n评议：';
  }
  function citedParagraphs(text) {
    if (typeof text !== 'string') return [];
    return PARAGRAPHS.filter(item => text.includes('[材料 ' + SAMPLE.id + ' · ' + item.number + ' · ' + item.label + ']'));
  }
  function parseImport(raw, role) {
    if (typeof raw !== 'string' || raw.length > MAX_BYTES || utf8Bytes(raw) > MAX_BYTES) throw new TypeError('导入文件超过 256 KiB 上限或不是文本。当前编辑未改变。');
    let input;
    try { input = JSON.parse(raw); } catch (_) { throw new TypeError('导入 JSON 损坏。当前编辑未改变。'); }
    if (!plainObject(input)) throw new TypeError('导入草稿必须为 JSON 对象。');
    if (!Object.prototype.hasOwnProperty.call(input, 'exportType')) return verifyDraft(input, role);
    const exportKeys = ['exportType', 'fieldLabels', 'completenessCheck', 'boundaries'].concat(role === 'reviewer' ? ['fictionalMaterial', 'materialSnapshot', 'recommendationLabel'] : ['attachmentChecklist']);
    const draftKeys = ['format', 'schemaVersion', 'role', 'localDraft', 'noSubmission', 'submissionStatus', 'capturedAt', 'fields'].concat(role === 'reviewer' ? ['material'] : []);
    if (Object.keys(input).some(key => !draftKeys.concat(exportKeys).includes(key)) || exportKeys.some(key => !Object.prototype.hasOwnProperty.call(input, key))) throw new TypeError('导出封装字段不完整或包含未知字段。');
    const draft = verifyDraft(Object.fromEntries(draftKeys.map(key => [key, input[key]])), role);
    const canonical = buildExport(role, draft.fields, draft.capturedAt).data;
    // Derived envelope metadata must agree with this version and the exact material.
    // Key order is irrelevant; field text is retained byte-for-byte.
    function same(a, b) {
      if (a === b) return true;
      if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => same(value, b[i]));
      if (plainObject(a) && plainObject(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]));
      return false;
    }
    for (const key of exportKeys) if (!same(input[key], canonical[key])) throw new TypeError('导出封装中的类型、检查信息或材料快照不匹配。');
    return draft;
  }
  function draftSummary(draft) {
    const firstKey = draft.role === 'reviewer' ? 'summary' : 'title';
    const content = draft.fields[firstKey].trim();
    return { text: content ? content.slice(0, 100) + (content.length > 100 ? '…' : '') : '首项尚未填写', filled: Object.values(draft.fields).filter(value => value.trim()).length, total: Object.keys(draft.fields).length, capturedAt: draft.capturedAt };
  }
  function markdownText(value) {
    // Preserve all text as readable inert Markdown; never pass user text through HTML.
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]#])/g, '\\$1');
  }
  function buildMarkdown(role, fields, capturedAt) {
    const draft = createDraft(role, fields, capturedAt);
    serializeDraft(draft);
    const entries = Object.entries(roleSpec(role));
    const lines = ['# ' + (role === 'reviewer' ? '本地评议草稿' : '本地投稿材料清单'), '', '**状态：未提交（not-submitted） · 本地草稿**', '', '记录时间：' + draft.capturedAt, '', '本文件不代表身份认证、评议发送、文件上传或投稿成功。'];
    if (role === 'reviewer') lines.push('', '**材料全部虚构；不是已授权的真实审稿任务。**', '', '材料编号：' + SAMPLE.id);
    lines.push('', '## 目录', '');
    for (const [key, config] of entries) lines.push('- [' + config.label + '](#field-' + key.toLowerCase() + ')');
    if (role === 'reviewer') for (const item of PARAGRAPHS) lines.push('- [虚构材料 ' + item.number + ' · ' + item.label + '](#material-' + item.number.toLowerCase() + ')');
    for (const [key, config] of entries) {
      lines.push('', '<a id="field-' + key.toLowerCase() + '"></a>', '## ' + config.label, '', markdownText(key === 'recommendation' ? RECOMMENDATION_LABELS[draft.fields[key]] : draft.fields[key]) || '（尚未填写）');
      if (role === 'reviewer' && key === 'concerns') for (const item of citedParagraphs(draft.fields.concerns)) lines.push('', '[返回材料 ' + item.number + ' · ' + item.label + '](#material-' + item.number.toLowerCase() + ')');
    }
    if (role === 'reviewer') for (const item of PARAGRAPHS) lines.push('', '<a id="material-' + item.number.toLowerCase() + '"></a>', '## 虚构材料 ' + item.number + ' · ' + item.label, '', markdownText(SAMPLE[item.key]), '', '[返回证据依据](#field-concerns)');
    const check = checkFields(role, draft.fields);
    lines.push('', '## 本页检查', '', '必填缺项：' + (check.missing.map(item => item.label).join('、') || '无') + '。', '', '格式问题：' + (check.issues.join('；') || '无') + '。', '', '仅检查本页文本，不代表目标期刊要求已满足或研究可信。', '');
    const text = lines.join('\n');
    if (utf8Bytes(text) > MAX_BYTES) throw new TypeError('Markdown 导出超过 256 KiB 上限，请缩短文本后重试。');
    return { text, filename: 'xiezhi-' + role + '-local-draft-' + draft.capturedAt.slice(0, 10) + '.md', mime: 'text/markdown;charset=utf-8' };
  }
  function buildExport(role, fields, capturedAt) {
    const draft = createDraft(role, fields, capturedAt);
    serializeDraft(draft);
    const check = checkFields(role, draft.fields);
    let attachmentChecklist = [];
    // Export remains available even when the typed checklist needs correction.
    // The raw field is preserved; invalid lines are not represented as valid items.
    if (role === 'submitter') {
      try { attachmentChecklist = parseAttachments(draft.fields.attachments); } catch (_) { attachmentChecklist = null; }
    }
    const output = {
      ...draft,
      exportType: role === 'reviewer' ? '本地评议草稿' : '本地投稿材料清单',
      fieldLabels: Object.fromEntries(Object.entries(roleSpec(role)).map(([key, config]) => [key, config.label])),
      completenessCheck: { passed: check.complete, requiredFieldsPresent: check.missing.length === 0, missingFields: check.missing.map(item => item.label), issues: check.issues, scope: '仅检查本页字段，不代表期刊要求已满足、研究可信或投稿成功。' },
      boundaries: { storage: '仅当前浏览器 localStorage，手动保存；导出反映当前编辑内容。', authorization: '工作视角不是身份认证或操作授权。', submission: '未上传文件、未发送评议、未提交投稿、未连接投稿后端。' }
    };
    if (role === 'reviewer') {
      output.fictionalMaterial = true;
      output.materialSnapshot = SAMPLE;
      output.recommendationLabel = RECOMMENDATION_LABELS[draft.fields.recommendation];
    } else output.attachmentChecklist = attachmentChecklist;
    const text = JSON.stringify(output, null, 2);
    if (utf8Bytes(text) > MAX_BYTES) throw new TypeError('导出超过 256 KiB 上限，请缩短文本后重试。');
    return { text, filename: 'xiezhi-' + role + '-local-draft-' + draft.capturedAt.slice(0, 10) + '.json', mime: 'application/json;charset=utf-8', data: output };
  }

  return Object.freeze({ VERSION, MAX_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENT_LENGTH, FIELDS, SAMPLE, RECOMMENDATIONS, RECOMMENDATION_LABELS, storageKey, backupKey, lockName, blankFields, normalizeFields, createDraft, serializeDraft, parseDraft, readDraft, readSnapshot, saveDraft, hasContent, parseImport, draftSummary, PARAGRAPHS, referenceBlock, citedParagraphs, buildMarkdown, parseAttachments, validOrcid, checkFields, buildExport });
});
