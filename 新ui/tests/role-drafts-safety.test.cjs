'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../role-drafts-core.js');
const { setup, memoryStorage, locks } = require('./helpers/draft-dom.cjs');
const time = '2026-10-07T04:00:00.000Z';
const rawDraft = (role, fields) => core.serializeDraft(core.createDraft(role, fields, time));
const safeSave = (storage, role, fields, expectedRaw, locker = locks()) => core.saveDraft(storage, role, fields, time, { expectedRaw, locks: locker });

test('same-role simultaneous saves serialize, compare exact originals, and preserve the winner', async () => {
  const local = memoryStorage(); const locker = locks();
  const [first, second] = await Promise.all([safeSave(local, 'submitter', { title: 'tab A' }, null, locker), safeSave(local, 'submitter', { title: 'tab B' }, null, locker)]);
  assert.equal(first.ok, true); assert.equal(second.code, 'conflict');
  assert.equal(core.readDraft(local, 'submitter').draft.fields.title, 'tab A');
  assert.deepEqual(locker.calls.map(item => item.name), [core.lockName('submitter'), core.lockName('submitter')]);
  assert.equal(locker.calls[0].options.mode, 'exclusive');
  const third = await safeSave(local, 'submitter', { title: 'sequential' }, first.raw, locker);
  assert.equal(third.ok, true); assert.equal(local.getItem(core.backupKey('submitter')), first.raw);
});
test('missing or rejected locks never touch storage and role locks are distinct', async () => {
  let touches = 0; const local = { getItem() { touches += 1; return null; }, setItem() { touches += 1; } };
  const unavailable = await core.saveDraft(local, 'submitter', { title: 'retained' }, time);
  assert.equal(unavailable.code, 'lock-unavailable'); assert.equal(touches, 0);
  const rejected = await safeSave(local, 'submitter', { title: 'retained' }, null, { request: async () => { throw new Error('denied'); } });
  assert.equal(rejected.code, 'lock-failed'); assert.equal(touches, 0);
  assert.notEqual(core.lockName('reviewer'), core.lockName('submitter'));
});
test('comparison, backup verification, write and readback all happen inside the acquired lock', async () => {
  let held = false; const before = rawDraft('submitter', { title: 'original' }); const data = new Map([[core.storageKey('submitter'), before]]); const operations = [];
  const local = { getItem(key) { assert.equal(held, true); operations.push('read:' + key); return data.get(key) ?? null; }, setItem(key, value) { assert.equal(held, true); operations.push('write:' + key); data.set(key, value); } };
  const locker = { async request(name, options, callback) { held = true; try { return await callback(); } finally { held = false; } } };
  assert.equal((await safeSave(local, 'submitter', { title: 'next' }, before, locker)).ok, true);
  assert.deepEqual(operations, ['read:' + core.storageKey('submitter'), 'write:' + core.backupKey('submitter'), 'read:' + core.backupKey('submitter'), 'write:' + core.storageKey('submitter'), 'read:' + core.storageKey('submitter')]);
});
test('a failed backup or backup readback leaves the original storage untouched', async () => {
  const before = rawDraft('submitter', { title: 'original' });
  for (const mismatch of [false, true]) {
    const local = memoryStorage(before); const writes = [];
    const storage = { getItem(key) { return mismatch && key === core.backupKey('submitter') ? 'unexpected' : local.getItem(key); }, setItem(key, value) { writes.push(key); if (!mismatch) { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } local.setItem(key, value); } };
    const result = await safeSave(storage, 'submitter', { title: 'next' }, before);
    assert.equal(result.ok, false); assert.equal(result.writeAttempted, false);
    assert.equal(local.getItem(core.storageKey('submitter')), before);
    assert.deepEqual(writes, [core.backupKey('submitter')]);
  }
});
test('post-write mismatches and read failures report uncertain state without blind rollback', async () => {
  const before = rawDraft('submitter', { title: 'before' });
  for (const throwing of [false, true]) {
    const local = memoryStorage(before); let written = false; const writes = [];
    const storage = { getItem(key) { if (written && key === core.storageKey('submitter')) { if (throwing) throw new Error('denied'); return 'external-change'; } return local.getItem(key); }, setItem(key, value) { writes.push(key); local.setItem(key, value); if (key === core.storageKey('submitter')) written = true; } };
    const result = await safeSave(storage, 'submitter', { title: 'after' }, before);
    assert.equal(result.ok, false); assert.equal(result.storageMayHaveChanged, true);
    assert.match(result.error, /原稿可能已变化.*未执行回滚/);
    assert.equal(writes.filter(key => key === core.storageKey('submitter')).length, 1);
    assert.equal(local.getItem(core.backupKey('submitter')), before);
    assert.equal(JSON.parse(local.getItem(core.storageKey('submitter'))).fields.title, 'after');
  }
});
test('damaged originals remain exact backup strings and blank editors cannot erase valid drafts', async () => {
  const corrupt = '{broken\n  raw'; const local = memoryStorage(corrupt);
  assert.equal((await safeSave(local, 'submitter', { title: 'replacement' }, corrupt)).ok, true);
  assert.equal(local.getItem(core.backupKey('submitter')), corrupt);
  const snapshot = core.readSnapshot(local, 'submitter', true);
  assert.equal(snapshot.raw, corrupt); assert.equal(snapshot.code, 'corrupt');
  const current = local.getItem(core.storageKey('submitter'));
  const result = await safeSave(local, 'submitter', { title: ' \n ' }, current);
  assert.equal(result.code, 'empty-overwrite'); assert.equal(local.getItem(core.storageKey('submitter')), current);
});
test('internal v1 and already-exported envelopes import all text without trimming', () => {
  for (const role of ['reviewer', 'submitter']) {
    const fields = core.blankFields(role); fields[role === 'reviewer' ? 'concerns' : 'title'] = '  中文 🧪\n<script>inert</script>  ';
    const internal = rawDraft(role, fields); const envelope = core.buildExport(role, fields, time).text;
    assert.deepEqual(core.parseImport(internal, role).fields, fields);
    assert.deepEqual(core.parseImport(envelope, role).fields, fields);
    const reordered = JSON.parse(envelope); reordered.fieldLabels = Object.fromEntries(Object.entries(reordered.fieldLabels).reverse());
    assert.deepEqual(core.parseImport(JSON.stringify(reordered), role).fields, fields);
  }
});
test('imports reject wrong roles, versions, types, materials, metadata and byte limits', () => {
  const draft = core.createDraft('reviewer', {}, time); const envelope = core.buildExport('reviewer', {}, time).data;
  const cases = [{ ...draft, role: 'submitter' }, { ...draft, schemaVersion: 2 }, { ...draft, fields: { ...draft.fields, summary: 1 } }, { ...draft, material: { ...draft.material, fictional: false } }, { ...envelope, materialSnapshot: { ...core.SAMPLE, results: 'changed' } }, { ...envelope, fictionalMaterial: 'true' }, { ...envelope, recommendationLabel: 1 }, { ...envelope, extra: 'unknown' }, { ...envelope, boundaries: null }];
  for (const data of cases) assert.throws(() => core.parseImport(JSON.stringify(data), 'reviewer'));
  assert.throws(() => core.parseImport('中'.repeat(core.MAX_BYTES / 3 + 1), 'reviewer'), /256 KiB/);
  assert.throws(() => core.parseImport('{broken', 'reviewer'), /JSON 损坏/);
  assert.throws(() => core.parseImport('[]', 'reviewer'), /对象/);
});
test('Markdown exports include contents, stable anchors, return references and inert hostile text', () => {
  const fields = { concerns: core.referenceBlock('P03') + '\n<script>alert(1)</script>' };
  const output = core.buildMarkdown('reviewer', fields, time);
  assert.match(output.text, /## 目录/); assert.match(output.text, /未提交（not-submitted）/); assert.match(output.text, /材料全部虚构/);
  assert.match(output.text, /<a id="field-concerns"><\/a>/); assert.match(output.text, /<a id="material-p03"><\/a>/);
  assert.match(output.text, /返回材料 P03.*#material-p03/); assert.match(output.text, /返回证据依据.*#field-concerns/);
  assert.match(output.text, /&lt;script&gt;/); assert.doesNotMatch(output.text, /<script>/); assert.match(output.filename, /\.md$/);
  const submitter = core.buildMarkdown('submitter', { title: '真实文字准备' }, time).text;
  assert.match(submitter, /未提交/); assert.doesNotMatch(submitter, /材料全部虚构/);
});
test('paragraph references only recognize the exact fixed sample block', () => {
  for (const item of core.PARAGRAPHS) { const block = core.referenceBlock(item.number); assert.ok(block.includes(core.SAMPLE[item.key])); assert.equal(core.citedParagraphs(block)[0].anchor, item.anchor); }
  assert.throws(() => core.referenceBlock('P05'), /无法识别/);
  assert.equal(core.citedParagraphs('[材料 REAL-001 · P03 · 结果]').length, 0);
});
test('entry summaries and new-draft actions keep the saved draft until an explicit nonblank overwrite', async () => {
  const before = rawDraft('submitter', { title: '旧稿摘要' }); const ui = setup('submitter', { raw: before });
  assert.equal(ui.el('entry').hidden, false); assert.match(ui.el('entry-summary').textContent, /旧稿摘要/);
  await ui.el('entry-new').click(); assert.equal(ui.el('title').value, ''); assert.equal(ui.data.get(core.storageKey('submitter')), before);
  await ui.el('save').click(); assert.match(ui.el('status').textContent, /全空编辑不能覆盖/);
  ui.edit('title', '新稿'); await ui.el('save').click();
  assert.equal(ui.el('save-confirm').hidden, false); assert.equal(ui.data.get(core.storageKey('submitter')), before);
  await ui.el('save-apply').click(); assert.equal(JSON.parse(ui.data.get(core.storageKey('submitter'))).fields.title, '新稿');
  assert.equal(ui.data.get(core.backupKey('submitter')), before);
});
test('editing and cross-tab storage events revoke old overwrite confirmations', async () => {
  const before = rawDraft('reviewer', { summary: '旧稿' }); const ui = setup('reviewer', { raw: before });
  ui.edit('summary', 'edit'); await ui.el('save').click(); ui.edit('summary', 'continued'); await ui.el('save-apply').click();
  assert.equal(ui.data.get(core.storageKey('reviewer')), before);
  await ui.el('save').click(); await ui.storageEvent(); await ui.el('save-apply').click();
  assert.equal(ui.el('save-confirm').hidden, true); assert.equal(ui.el('summary').value, 'continued'); assert.equal(ui.data.get(core.storageKey('reviewer')), before);
});
test('restore confirmation rereads storage and refuses a stale source even without a storage event', async () => {
  const before = rawDraft('submitter', { title: 'old' }); const ui = setup('submitter', { raw: before });
  ui.edit('title', 'editor'); await ui.el('restore').click();
  ui.storage.setItem(core.storageKey('submitter'), rawDraft('submitter', { title: 'newer' }));
  await ui.el('restore-apply').click(); assert.equal(ui.el('title').value, 'editor'); assert.match(ui.el('status').textContent, /确认已失效/);
  await ui.el('restore').click(); await ui.el('restore-apply').click(); assert.equal(ui.el('title').value, 'newer');
});
test('backup restoration is editor-only and its confirmation also rejects changed backup bytes', async () => {
  const before = rawDraft('submitter', { title: 'saved' }); const backup = rawDraft('submitter', { title: 'backup' }); const ui = setup('submitter', { raw: before });
  ui.storage.setItem(core.backupKey('submitter'), backup); ui.edit('title', 'unsaved'); await ui.el('restore-backup').click();
  ui.storage.setItem(core.backupKey('submitter'), rawDraft('submitter', { title: 'changed backup' }));
  await ui.el('restore-apply').click(); assert.equal(ui.el('title').value, 'unsaved');
  await ui.el('restore-backup').click(); await ui.el('restore-apply').click();
  assert.equal(ui.el('title').value, 'changed backup'); assert.equal(ui.leave().prevented, true); assert.equal(ui.data.get(core.storageKey('submitter')), before);
});
test('corrupt raw downloads and overwrite backups preserve exact damaged bytes', async () => {
  const corrupt = '{damaged\n  原文'; const ui = setup('submitter', { raw: corrupt });
  await ui.el('export-original').click(); assert.equal(await ui.blobs[0].text(), corrupt);
  ui.edit('title', 'current'); await ui.el('save').click(); await ui.el('save-apply').click();
  assert.equal(ui.data.get(core.backupKey('submitter')), corrupt);
  await ui.el('export-backup').click(); assert.equal(await ui.blobs[1].text(), corrupt);
  await ui.el('restore-backup').click(); assert.equal(ui.el('title').value, 'current'); assert.match(ui.el('status').textContent, /JSON 损坏/);
});
test('import previews inert field text and changes editor only after explicit confirmation', async () => {
  const saved = rawDraft('submitter', { title: 'saved' }); const ui = setup('submitter', { raw: saved }); ui.edit('title', 'unsaved');
  const imported = core.buildExport('submitter', { title: '<img onerror=evil> 中文' }, time).text;
  await ui.importText(imported); assert.equal(ui.el('import-preview').hidden, false); assert.equal(ui.el('title').value, 'unsaved');
  assert.ok(ui.el('import-fields').children[0].textContent.includes('<img onerror=evil>'));
  await ui.el('import-apply').click(); assert.equal(ui.el('title').value, '<img onerror=evil> 中文'); assert.equal(ui.data.get(core.storageKey('submitter')), saved); assert.equal(ui.leave().prevented, true);
  await ui.el('save').click(); assert.equal(ui.el('save-confirm').hidden, false);
});
test('bad, oversized or changed imports do not change editor or saved storage', async () => {
  const saved = rawDraft('submitter', { title: 'saved' }); const ui = setup('submitter', { raw: saved }); ui.edit('title', 'editor');
  for (const text of ['{broken', rawDraft('reviewer', { summary: 'wrong role' })]) { await ui.importText(text); assert.equal(ui.el('title').value, 'editor'); assert.equal(ui.el('import-preview').hidden, true); }
  await ui.importText(rawDraft('submitter', { title: 'too big' }), { size: core.MAX_BYTES + 1 }); assert.match(ui.el('status').textContent, /256 KiB/);
  let text = rawDraft('submitter', { title: 'preview' }); await ui.importText(text, { text: async () => text }); text = rawDraft('submitter', { title: 'changed' });
  await ui.el('import-apply').click(); assert.equal(ui.el('title').value, 'editor'); assert.match(ui.el('status').textContent, /文件与预览内容已变化/); assert.equal(ui.data.get(core.storageKey('submitter')), saved);
});
test('editor or storage changes during asynchronous import revoke its preview and confirmation', async () => {
  const ui = setup('submitter'); let release; const text = rawDraft('submitter', { title: 'imported' });
  const wait = ui.importText(text, { text: () => new Promise(resolve => { release = resolve; }) });
  ui.edit('title', 'typed during read'); release(text); await wait;
  assert.equal(ui.el('import-preview').hidden, true); assert.equal(ui.el('title').value, 'typed during read');
  await ui.importText(text); await ui.storageEvent(); await ui.el('import-apply').click(); assert.equal(ui.el('title').value, 'typed during read');
});
test('current and saved JSON/Markdown exports have distinct snapshots and never clear dirty state', async () => {
  const ui = setup('submitter'); ui.edit('title', 'saved'); await ui.el('save').click(); ui.edit('title', 'current');
  await ui.el('export').click(); await ui.el('export-saved').click(); await ui.el('export-md').click(); await ui.el('export-saved-md').click();
  assert.equal(JSON.parse(await ui.blobs[0].text()).fields.title, 'current'); assert.equal(JSON.parse(await ui.blobs[1].text()).fields.title, 'saved');
  assert.match(await ui.blobs[2].text(), /current/); assert.match(await ui.blobs[3].text(), /saved/);
  assert.match(ui.downloads[1].filename, /saved-draft/); assert.equal(ui.leave().prevented, true);
});
test('two editors saving together preserve one winner and the losing editor for export', async () => {
  const storage = memoryStorage(); const locker = locks(); const a = setup('submitter', { storage, locks: locker }); const b = setup('submitter', { storage, locks: locker });
  a.edit('title', 'first'); b.edit('title', 'second'); await Promise.all([a.el('save').click(), b.el('save').click()]);
  assert.equal(core.readDraft(storage, 'submitter').draft.fields.title, 'first'); assert.equal(b.el('title').value, 'second'); assert.equal(b.leave().prevented, true); assert.match(b.el('status').textContent, /其他页面修改/);
  await b.el('save').click(); assert.equal(b.el('save-confirm').hidden, false); await b.el('save-apply').click();
  assert.equal(core.readDraft(storage, 'submitter').draft.fields.title, 'second'); assert.equal(JSON.parse(storage.getItem(core.backupKey('submitter'))).fields.title, 'first');
});
test('queued safe save captures clicked fields while newer typing remains unsaved', async () => {
  let release; const locker = { request(name, options, callback) { return new Promise(resolve => { release = () => resolve(callback()); }); } };
  const ui = setup('submitter', { locks: locker }); ui.edit('title', 'clicked snapshot'); const pending = ui.el('save').click();
  ui.edit('title', 'new text'); release(); await pending;
  assert.equal(JSON.parse(ui.data.get(core.storageKey('submitter'))).fields.title, 'clicked snapshot'); assert.equal(ui.el('title').value, 'new text'); assert.equal(ui.leave().prevented, true); assert.match(ui.el('status').textContent, /保存期间的新编辑尚未保存/);
});
test('safe save unavailable in UI retains text and supports export', async () => {
  const ui = setup('submitter', { noLocks: true }); ui.edit('title', 'retained'); await ui.el('save').click();
  assert.match(ui.el('status').textContent, /Web Locks/); assert.equal(ui.data.size, 0); assert.equal(ui.leave().prevented, true); await ui.el('export').click(); assert.equal(JSON.parse(await ui.blobs[0].text()).fields.title, 'retained');
});
test('reviewer cite buttons insert fixed blocks and expose paragraph return links', async () => {
  const ui = setup('reviewer'); ui.edit('concerns', 'existing concern'); ui.el('concerns').setSelectionRange(16, 16); await ui.el('cite-p03').click();
  assert.ok(ui.el('concerns').value.includes(core.referenceBlock('P03'))); assert.equal(ui.el('references').children[0].href, '#rv-sample-results'); assert.equal(ui.leave().prevented, true);
  await ui.el('export').click(); assert.ok(JSON.parse(await ui.blobs[0].text()).fields.concerns.includes('P03'));
});
test('submitter required count updates dynamically and format errors link to their fields', async () => {
  const ui = setup('submitter'); assert.equal(ui.el('required-count').textContent, '0 / 6'); ui.edit('title', 'written'); assert.equal(ui.el('required-count').textContent, '1 / 6');
  ui.edit('orcid', 'bad'); ui.edit('attachments', 'x'.repeat(241)); await ui.el('check').click();
  const hrefs = ui.el('check-list').children.map(item => item.children[0].href);
  assert.ok(hrefs.includes('#sb-orcid')); assert.ok(hrefs.includes('#sb-attachments')); assert.equal(ui.el('orcid').getAttribute('aria-invalid'), 'true');
});
test('role page markup has unique IDs, last-loaded scoped CSS, accessible controls and fixed paragraph IDs', () => {
  for (const role of ['reviewer', 'submitter']) {
    const html = fs.readFileSync(path.join(__dirname, '../' + role + '.html'), 'utf8'); const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length); assert.ok(html.indexOf('page-registry.js') < html.indexOf('workbench.js'));
    const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]); assert.equal(styles.at(-1), 'role-workspace.css');
  }
  const css = fs.readFileSync(path.join(__dirname, '../role-workspace.css'), 'utf8'); assert.match(css, /top: var\(--wb-topbar-height/); assert.match(css, /--draft-toolbar-height/); assert.match(css, /min-width: 1100px/); assert.match(css, /font-size: 16px/);
});

test('required field errors appear beside controls only after checking and clear while typing', async () => {
  for (const role of ['reviewer', 'submitter']) {
    const ui = setup(role); const key = role === 'reviewer' ? 'summary' : 'title';
    const prefix = role === 'reviewer' ? 'rv' : 'sb';
    for (const field of Object.keys(core.FIELDS[role])) assert.equal(ui.el(field + '-error').hidden, true);
    await ui.el('check').click();
    assert.equal(ui.el(key + '-error').hidden, false); assert.match(ui.el(key + '-error').textContent, /请补充/);
    assert.equal(ui.el(key).getAttribute('aria-invalid'), 'true');
    assert.ok(ui.el(key).getAttribute('aria-describedby').includes(prefix + '-' + key + '-error'));
    ui.edit(key, 'corrected'); assert.equal(ui.el(key + '-error').hidden, true); assert.equal(ui.el(key).getAttribute('aria-invalid'), 'false');
    ui.edit(key, ' \n '); assert.equal(ui.el(key + '-error').hidden, false);
    const optional = role === 'reviewer' ? 'notes' : 'keywords'; assert.equal(ui.el(optional + '-error').hidden, true);
  }
});
test('ORCID and attachment format errors show inline immediately and retain original help relationships', () => {
  const ui = setup('submitter'); ui.edit('orcid', 'invalid'); ui.edit('attachments', 'x'.repeat(241));
  assert.equal(ui.el('orcid-error').hidden, false); assert.match(ui.el('orcid-error').textContent, /格式或校验位/);
  assert.equal(ui.el('attachments-error').hidden, false); assert.match(ui.el('attachments-error').textContent, /240 字符/);
  assert.equal(ui.el('title-error').hidden, true);
  assert.equal(ui.el('orcid').getAttribute('aria-describedby'), 'sb-orcid-help sb-orcid-error');
  assert.equal(ui.el('attachments').getAttribute('aria-describedby'), 'sb-attachments-help sb-attachments-error');
  ui.edit('orcid', '0000-0002-1825-0097'); ui.edit('attachments', 'manuscript.pdf');
  assert.equal(ui.el('orcid-error').hidden, true); assert.equal(ui.el('attachments-error').hidden, true);
  assert.equal(ui.el('attachments').getAttribute('aria-invalid'), 'false');
});
test('importing text equal to the saved baseline still marks editor-only content unsaved until a manual save', async () => {
  for (const role of ['reviewer', 'submitter']) {
    const key = role === 'reviewer' ? 'summary' : 'title'; const ui = setup(role); ui.edit(key, 'same text'); await ui.el('save').click();
    const raw = ui.data.get(core.storageKey(role)); await ui.importText(raw); await ui.el('import-apply').click();
    assert.equal(ui.el(key).value, 'same text'); assert.equal(ui.data.get(core.storageKey(role)), raw); assert.equal(ui.el('form').dataset.unsaved, 'true'); assert.equal(ui.leave().prevented, true);
    await ui.el('export').click(); assert.equal(ui.leave().prevented, true);
    await ui.el('save').click(); await ui.el('save-apply').click(); assert.equal(ui.el('form').dataset.unsaved, 'false'); assert.equal(ui.leave().prevented, false);
  }
});
test('restoring a backup equal to the baseline still marks editor-only content unsaved', async () => {
  const ui = setup('submitter'); ui.edit('title', 'same text'); await ui.el('save').click(); const raw = ui.data.get(core.storageKey('submitter'));
  ui.storage.setItem(core.backupKey('submitter'), raw); await ui.el('restore-backup').click();
  assert.equal(ui.el('title').value, 'same text'); assert.equal(ui.el('form').dataset.unsaved, 'true'); assert.equal(ui.leave().prevented, true);
  assert.equal(ui.data.get(core.storageKey('submitter')), raw);
});
test('an import made while an older save is queued retains its explicit unsaved state', async () => {
  let release; const locker = { request(name, options, callback) { return new Promise(resolve => { release = () => resolve(callback()); }); } };
  const ui = setup('submitter', { locks: locker }); ui.edit('title', 'same text'); const save = ui.el('save').click();
  await ui.importText(rawDraft('submitter', { title: 'same text' })); await ui.el('import-apply').click(); release(); await save;
  assert.equal(JSON.parse(ui.data.get(core.storageKey('submitter'))).fields.title, 'same text'); assert.equal(ui.leave().prevented, true);
});
test('every field ships one stable inline error node and an accessible description relationship', () => {
  for (const role of ['reviewer', 'submitter']) {
    const prefix = role === 'reviewer' ? 'rv' : 'sb'; const html = fs.readFileSync(path.join(__dirname, '../' + role + '.html'), 'utf8');
    for (const key of Object.keys(core.FIELDS[role])) {
      const id = prefix + '-' + key + '-error'; const control = html.match(new RegExp('<(?:input|textarea|select)[^>]*id="' + prefix + '-' + key + '"[^>]*>'))[0];
      assert.ok(control.includes(id)); assert.equal([...html.matchAll(new RegExp('id="' + id + '"', 'g'))].length, 1);
      assert.ok(html.includes('id="' + id + '" class="draft-field-error" hidden'));
    }
  }
});
