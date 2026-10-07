'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../role-drafts-core.js');
const { locks } = require('./helpers/draft-dom.cjs');
const save = (storage, role, fields, timestamp, options = {}) => core.saveDraft(storage, role, fields, timestamp, { locks: locks(), ...options });
const time = '2026-10-07T04:00:00.000Z';
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, value) };
}
function complete(role) {
  const fields = core.blankFields(role);
  for (const [key, config] of Object.entries(core.FIELDS[role])) if (config.required) fields[key] = key === 'recommendation' ? 'major-revision' : config.label + '：本地文本';
  return fields;
}

test('reviewer and submitter drafts round-trip all Unicode fields without trimming or changing content', () => {
  for (const role of ['reviewer', 'submitter']) {
    const fields = complete(role);
    fields[Object.keys(fields)[0]] = '  中文、α 与 emoji 🧪\n第二行  ';
    const draft = core.createDraft(role, fields, time);
    assert.deepEqual(core.parseDraft(core.serializeDraft(draft), role), draft);
    assert.deepEqual(draft.fields, fields);
  }
});
test('role storage keys are distinct and an empty browser has no saved draft', () => {
  assert.notEqual(core.storageKey('reviewer'), core.storageKey('submitter'));
  assert.deepEqual(core.readDraft(storage(), 'reviewer'), { ok: true, draft: null });
  assert.throws(() => core.storageKey('admin'), /未知/);
});
test('manual save only reports success after storing and reading the same serialized draft', async () => {
  const local = storage();
  const saved = await save(local, 'submitter', complete('submitter'), time);
  assert.equal(saved.ok, true);
  assert.deepEqual(core.readDraft(local, 'submitter').draft, saved.draft);
  const noOp = { setItem() {}, getItem() { return null; } };
  assert.match((await save(noOp, 'submitter', {}, time)).error, /校验未通过/);
});
test('quota, security and post-save read failures do not become successful saves', async () => {
  const quota = { getItem() { return null; }, setItem() { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } };
  const blocked = { getItem() { return null; }, setItem() { throw new Error('blocked'); } };
  const readBlocked = { setItem() {}, getItem() { throw new Error('blocked'); } };
  assert.match((await save(quota, 'reviewer', {}, time)).error, /空间不足/);
  assert.match((await save(blocked, 'reviewer', {}, time)).error, /保存失败/);
  assert.equal((await save(readBlocked, 'reviewer', {}, time)).ok, false);
  assert.match(core.readDraft(readBlocked, 'reviewer').error, /读取失败/);
});
test('invalid JSON and obsolete, wrong-role or incomplete schema are rejected without field recovery', () => {
  assert.match(core.readDraft(storage({ [core.storageKey('reviewer')]: '{broken' }), 'reviewer').error, /JSON 损坏/);
  const draft = core.createDraft('reviewer', {}, time);
  for (const changes of [{ schemaVersion: 0 }, { role: 'submitter' }, { localDraft: false }, { noSubmission: false }, { submissionStatus: 'submitted' }, { fields: {} }, { unexpected: 'value' }]) {
    assert.throws(() => core.parseDraft(JSON.stringify({ ...draft, ...changes }), 'reviewer'));
  }
});
test('stored dates must be actual ISO dates rather than impossible calendar dates', () => {
  assert.throws(() => core.createDraft('submitter', {}, '2026-02-31T04:00:00.000Z'), /时间无效/);
  assert.throws(() => core.createDraft('reviewer', {}, 'yesterday'), /时间无效/);
});
test('the reviewer material cannot be substituted with a real or authorized review task', () => {
  const draft = core.createDraft('reviewer', {}, time);
  for (const material of [{ ...draft.material, id: 'REAL-001' }, { ...draft.material, fictional: false }, { ...draft.material, authorizedReviewTask: true }, { ...draft.material, assignment: 'editor' }, null]) {
    assert.throws(() => core.parseDraft(JSON.stringify({ ...draft, material }), 'reviewer'), /虚构示例/);
  }
});
test('unknown, non-text or prototype fields and unexpected recommendations are rejected', () => {
  assert.throws(() => core.createDraft('submitter', { title: 1 }, time), /必须为文本/);
  assert.throws(() => core.createDraft('submitter', { adminToken: 'fake' }, time), /无法识别/);
  assert.throws(() => core.createDraft('submitter', JSON.parse('{"__proto__":"bad"}'), time), /无法识别/);
  assert.throws(() => core.createDraft('reviewer', { recommendation: 'signed-acceptance' }, time), /草稿建议/);
});
test('per-field character limits and UTF-8 draft byte limits are enforced', () => {
  assert.throws(() => core.createDraft('submitter', { title: '中'.repeat(241) }, time), /240/);
  assert.doesNotThrow(() => core.createDraft('submitter', { title: '中'.repeat(240) }, time));
  assert.throws(() => core.parseDraft('中'.repeat(core.MAX_BYTES / 3 + 1), 'reviewer'), /过大/);
  const oversized = core.blankFields('reviewer');
  for (const [key, config] of Object.entries(core.FIELDS.reviewer)) oversized[key] = key === 'recommendation' ? 'accept' : '\u0001'.repeat(config.max);
  // Escaped control characters can exceed the byte limit while each field remains within its character cap.
  assert.throws(() => core.serializeDraft(core.createDraft('reviewer', oversized, time)), /256 KiB/);
});
test('blank and whitespace-only required fields report the precise missing items', () => {
  for (const role of ['reviewer', 'submitter']) {
    const expected = Object.keys(core.FIELDS[role]).filter(key => core.FIELDS[role][key].required);
    const fields = core.blankFields(role);
    for (const key of Object.keys(fields)) fields[key] = ' \n ';
    if (role === 'reviewer') fields.recommendation = '';
    assert.deepEqual(core.checkFields(role, fields).missing.map(item => item.key), expected);
    assert.equal(core.checkFields(role, complete(role)).complete, true);
  }
});
test('incomplete drafts may be saved and exported with an explicit missing-item checklist', async () => {
  const fields = { title: '未完成稿件' };
  assert.equal((await save(storage(), 'submitter', fields, time)).ok, true);
  const output = core.buildExport('submitter', fields, time).data;
  assert.equal(output.completenessCheck.passed, false);
  assert.ok(output.completenessCheck.missingFields.includes('摘要'));
  assert.equal(output.fields.title, fields.title);
});
test('ORCID is optional and formatting or checksum checks do not authenticate identity', () => {
  assert.equal(core.validOrcid('0000-0002-1825-0097'), true);
  assert.equal(core.validOrcid('https://orcid.org/0000-0002-1825-0097'), true);
  assert.equal(core.validOrcid('0000-0002-1825-0098'), false);
  const fields = complete('submitter');
  assert.equal(core.checkFields('submitter', fields).complete, true);
  fields.orcid = 'bad ORCID';
  assert.match(core.checkFields('submitter', fields).issues[0], /不验证身份/);
  const output = core.buildExport('submitter', fields, time).data;
  assert.equal(output.completenessCheck.requiredFieldsPresent, true);
  assert.equal(output.completenessCheck.passed, false);
});
test('attachment checklist handles CRLF, blanks and exactly forty rows', () => {
  assert.deepEqual(core.parseAttachments('  正文.pdf；v2\r\n\n 图件.zip  \n'), ['正文.pdf；v2', '图件.zip']);
  assert.equal(core.parseAttachments(Array.from({ length: 40 }, (_, i) => '附件' + i).join('\n')).length, 40);
  assert.throws(() => core.parseAttachments(Array.from({ length: 41 }, (_, i) => '附件' + i).join('\n')), /40 项/);
  assert.equal(core.parseAttachments('中'.repeat(240))[0].length, 240);
  assert.throws(() => core.parseAttachments('中'.repeat(241)), /240 字符/);
});
test('an invalid checklist is preserved for editing/export but is not silently accepted as valid items', () => {
  const fields = complete('submitter');
  fields.attachments = '中'.repeat(241);
  const output = core.buildExport('submitter', fields, time).data;
  assert.equal(output.fields.attachments, fields.attachments);
  assert.equal(output.attachmentChecklist, null);
  assert.equal(output.completenessCheck.passed, false);
  assert.match(output.completenessCheck.issues[0], /240/);
});
test('both exports carry explicit local/no-submission boundaries and readable Chinese labels', () => {
  for (const role of ['reviewer', 'submitter']) {
    const output = core.buildExport(role, complete(role), time);
    assert.match(output.filename, /local-draft-2026-10-07\.json$/);
    assert.equal(output.mime, 'application/json;charset=utf-8');
    const data = JSON.parse(output.text);
    assert.equal(data.localDraft, true);
    assert.equal(data.noSubmission, true);
    assert.equal(data.submissionStatus, 'not-submitted');
    assert.match(data.boundaries.authorization, /不是身份认证/);
    assert.match(data.boundaries.submission, /未提交投稿/);
    assert.ok(Object.values(data.fieldLabels).some(label => /[\u4e00-\u9fa5]/.test(label)));
  }
});
test('review export includes all fictional sample sections and never claims a review assignment', () => {
  const output = core.buildExport('reviewer', complete('reviewer'), time).data;
  assert.equal(output.fictionalMaterial, true);
  assert.equal(output.material.fictional, true);
  assert.equal(output.material.authorizedReviewTask, false);
  for (const key of ['abstract', 'methods', 'results', 'limitations']) assert.ok(output.materialSnapshot[key].length > 50);
  assert.equal(output.recommendationLabel, '大修后再评估');
  assert.ok(Object.isFrozen(core.SAMPLE));
});
test('JSON exports preserve hostile strings as inert field text', () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const output = core.buildExport('submitter', { title: hostile }, time);
  assert.equal(JSON.parse(output.text).fields.title, hostile);
  const ui = fs.readFileSync(path.join(__dirname, '../role-drafts.js'), 'utf8');
  assert.doesNotMatch(ui, /innerHTML|eval\(|new Function|fetch\(/);
});
test('page contracts expose every supported field with matching length caps and shell hooks', () => {
  for (const role of ['reviewer', 'submitter']) {
    const prefix = role === 'reviewer' ? 'rv' : 'sb';
    const html = fs.readFileSync(path.join(__dirname, '../' + role + '.html'), 'utf8');
    assert.match(html, new RegExp('data-section="' + role + '"'));
    for (const id of ['wb-sidebar-slot', 'wb-topbar-slot', 'network-notice', 'main', prefix + '-save', prefix + '-restore', prefix + '-check', prefix + '-export']) assert.ok(html.includes('id="' + id + '"'));
    for (const [key, config] of Object.entries(core.FIELDS[role])) {
      const control = html.match(new RegExp('<(?:input|textarea|select)[^>]*id="' + prefix + '-' + key + '"[^>]*>'));
      assert.ok(control, key);
      if (key !== 'recommendation') assert.ok(control[0].includes('maxlength="' + config.max + '"'));
    }
    assert.doesNotMatch(html, /commission-demo|<iframe/);
    const fileControls = html.match(/<input[^>]*type="file"[^>]*>/g) || [];
    assert.equal(fileControls.length, 1, 'only a local JSON draft import, no manuscript attachment upload');
    assert.ok(fileControls[0].includes('id="' + prefix + '-import-file"'));
    assert.ok(fileControls[0].includes('accept=".json,application/json"'));
    assert.ok(fileControls[0].includes('不上传'));
  }
});
test('visible reviewer material and exported material use the same complete sample', () => {
  const html = fs.readFileSync(path.join(__dirname, '../reviewer.html'), 'utf8');
  for (const key of ['abstract', 'methods', 'results', 'limitations']) assert.ok(html.includes(core.SAMPLE[key]), key);
});
