'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../role-drafts-core.js');
const coreScript = fs.readFileSync(path.join(__dirname, '../role-drafts-core.js'), 'utf8');
const uiScript = fs.readFileSync(path.join(__dirname, '../role-drafts.js'), 'utf8');
const time = '2026-10-07T04:00:00.000Z';

const { setup } = require('./helpers/draft-dom.cjs');

test('typing marks unsaved and a successful manual save clears the leave warning', async () => {
  for (const role of ['reviewer', 'submitter']) {
    const ui = setup(role);
    assert.equal(ui.leave().prevented, false);
    ui.edit(role === 'reviewer' ? 'summary' : 'title', '中文本地草稿');
    assert.match(ui.el('status').textContent, /未保存/);
    assert.equal(ui.el('form').dataset.unsaved, 'true');
    assert.equal(ui.leave().prevented, true);
    await ui.el('save').click();
    assert.equal(ui.el('status').dataset.kind, 'success');
    assert.match(ui.el('status').textContent, /已保存到当前浏览器/);
    assert.equal(ui.leave().prevented, false);
    assert.equal(core.readDraft({ getItem: key => ui.data.get(key) }, role).draft.fields[role === 'reviewer' ? 'summary' : 'title'], '中文本地草稿');
  }
});
test('failed storage operations keep current text unsaved and available for export without animation', async () => {
  const ui = setup('submitter', { storage: { getItem() { return null; }, setItem() { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } } });
  ui.edit('title', '存储失败后保留的草稿');
  await ui.el('save').click();
  assert.equal(ui.el('status').dataset.kind, 'error');
  assert.doesNotMatch(ui.el('status').textContent, /已保存到当前浏览器/);
  assert.equal(ui.leave().prevented, true);
  await ui.el('export').click();
  assert.equal(ui.downloads.length, 1);
  assert.match(ui.downloads[0].filename, /\.json$/);
  const exported = JSON.parse(await ui.blobs[0].text());
  assert.equal(exported.fields.title, '存储失败后保留的草稿');
  assert.equal(exported.localDraft, true);
  assert.equal(exported.noSubmission, true);
  assert.match(ui.el('status').textContent, /仍未保存/);
  assert.equal(ui.leave().prevented, true);
});
test('corrupt old JSON warns on page open and does not prevent current edits or export', async () => {
  const ui = setup('reviewer', { raw: '{corrupted' });
  assert.match(ui.el('status').textContent, /JSON 损坏/);
  assert.equal(ui.el('summary').value, '');
  ui.edit('summary', '新的可导出草稿');
  await ui.el('restore').click();
  assert.match(ui.el('status').textContent, /未恢复任何内容/);
  assert.equal(ui.el('summary').value, '新的可导出草稿');
  await ui.el('export').click();
  assert.equal(JSON.parse(await ui.blobs[0].text()).fields.summary, '新的可导出草稿');
});
test('inaccessible localStorage property warns and export still works', async () => {
  const ui = setup('submitter', { storageGetterThrows: true });
  assert.match(ui.el('storage-status').textContent, /不可用/);
  ui.edit('title', '无存储环境');
  await ui.el('save').click();
  assert.equal(ui.el('status').dataset.kind, 'error');
  await ui.el('export').click();
  assert.equal(ui.downloads.length, 1);
});
test('saved drafts restore only when requested and dirty replacements require explicit confirmation', async () => {
  const raw = core.serializeDraft(core.createDraft('submitter', { title: '此前手动保存的题目' }, time));
  const ui = setup('submitter', { raw });
  assert.equal(ui.el('title').value, '');
  assert.match(ui.el('storage-status').textContent, /点击「恢复草稿」/);
  ui.edit('title', '目前编辑的题目');
  await ui.el('restore').click();
  assert.equal(ui.el('restore-confirm').hidden, false);
  assert.equal(ui.el('title').value, '目前编辑的题目');
  await ui.el('restore-cancel').click();
  assert.equal(ui.el('title').value, '目前编辑的题目');
  await ui.el('restore').click();
  await ui.el('restore-apply').click();
  assert.equal(ui.el('title').value, '此前手动保存的题目');
  assert.equal(ui.el('restore-confirm').hidden, true);
  assert.equal(ui.leave().prevented, false);
});
test('changing text after requesting restore cancels the stale replacement confirmation', async () => {
  const raw = core.serializeDraft(core.createDraft('reviewer', { summary: '保存文本' }, time));
  const ui = setup('reviewer', { raw });
  ui.edit('summary', '编辑文本');
  await ui.el('restore').click();
  ui.edit('summary', '继续编辑文本');
  await ui.el('restore-apply').click();
  assert.equal(ui.el('summary').value, '继续编辑文本');
  assert.equal(ui.el('restore-confirm').hidden, true);
});
test('missing-field check points to supported controls and refreshes on edits', async () => {
  const ui = setup('submitter');
  await ui.el('check').click();
  assert.equal(ui.el('check-result').hidden, false);
  assert.equal(ui.el('check-list').children.length, 6);
  const firstLink = ui.el('check-list').children[0].children[0];
  assert.equal(firstLink.href, '#sb-title');
  assert.match(firstLink.textContent, /稿件题目/);
  ui.edit('title', '<script>alert(1)</script>');
  assert.equal(ui.el('check-result').hidden, true);
  assert.equal(ui.el('title').value, '<script>alert(1)</script>');
});
test('export uses current unsaved fields rather than the saved storage snapshot', async () => {
  const ui = setup('reviewer');
  ui.edit('summary', '已保存版本'); await ui.el('save').click();
  ui.edit('summary', '当前未保存版本'); await ui.el('export').click();
  const exported = JSON.parse(await ui.blobs[0].text());
  assert.equal(exported.fields.summary, '当前未保存版本');
  assert.equal(exported.material.authorizedReviewTask, false);
  assert.equal(exported.submissionStatus, 'not-submitted');
  assert.equal(JSON.parse(ui.data.get(core.storageKey('reviewer'))).fields.summary, '已保存版本');
  assert.equal(ui.leave().prevented, true);
});
test('invalid field data blocks save/export without a false success or text replacement', async () => {
  const ui = setup('submitter');
  ui.edit('title', 'x'.repeat(241));
  await ui.el('save').click();
  assert.equal(ui.el('status').dataset.kind, 'error');
  assert.equal(ui.data.size, 0);
  await ui.el('export').click();
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.el('status').textContent, /导出未完成/);
  assert.equal(ui.el('title').value.length, 241);
});
