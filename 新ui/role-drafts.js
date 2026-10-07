(function () {
  'use strict';
  const core = window.ScholarRoleDrafts;
  const role = document.body.dataset.section;
  if (!core || !['reviewer', 'submitter'].includes(role)) return;
  const prefix = role === 'reviewer' ? 'rv' : 'sb';
  const byId = suffix => document.getElementById(prefix + '-' + suffix);
  const form = byId('form');
  if (!form) return;
  const status = byId('status');
  const storageStatus = byId('storage-status');
  const checkPanel = byId('check-result');
  const fieldKeys = Object.keys(core.FIELDS[role]);
  let baseline = JSON.stringify(core.blankFields(role));
  let dirty = false;
  let pendingEditor = false;
  let pendingEditorVersion = 0;
  let showMissingErrors = false;
  let expectedRaw;
  let loadedSaved = false;
  let pendingRestore = null;
  let pendingSave = null;
  let pendingImport = null;
  let pendingNew = false;
  let saveInFlight = false;
  let importGeneration = 0;

  function listen(id, event, callback) {
    const element = byId(id);
    if (element) element.addEventListener(event, (...args) => {
      if (event === 'click' && id !== 'more') {
        const menu = byId('more'); const actions = byId('more-actions');
        if (menu && actions) { menu.setAttribute('aria-expanded', 'false'); actions.dataset.open = 'false'; }
      }
      return callback(...args);
    });
  }
  function currentFields() { return Object.fromEntries(fieldKeys.map(key => [key, byId(key).value])); }
  function fingerprint() { return JSON.stringify(currentFields()); }
  function refreshDirty() {
    dirty = pendingEditor || fingerprint() !== baseline;
    form.dataset.unsaved = dirty ? 'true' : 'false';
    return dirty;
  }
  function setStatus(text, kind, code) { status.textContent = text; status.dataset.kind = kind || 'info'; status.dataset.code = code || ''; }
  function timeLabel(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
  function getStorage() {
    try { return { storage: window.localStorage }; }
    catch (_) { return { error: '浏览器存储不可用，无法保存或恢复。当前编辑内容仍可导出。' }; }
  }
  function readSaved(backup) {
    const access = getStorage();
    return access.error ? { ok: false, raw: undefined, error: access.error } : core.readSnapshot(access.storage, role, backup);
  }
  function summary(result) {
    if (result.raw === null) return '当前浏览器暂无已保存稿。';
    if (!result.ok) return '原文无法解析，可下载原文保留；覆盖前仍须保存原文备份。';
    const item = core.draftSummary(result.draft);
    return '保存于 ' + timeLabel(item.capturedAt) + ' · 已填写 ' + item.filled + '/' + item.total + ' 项 · ' + item.text;
  }
  function hide(id) { const element = byId(id); if (element) element.hidden = true; }
  function clearConfirmations() {
    pendingRestore = null; pendingSave = null; pendingImport = null; pendingNew = false;
    importGeneration += 1;
    for (const id of ['restore-confirm', 'save-confirm', 'import-preview', 'new-confirm']) hide(id);
  }
  function updateChecklist() {
    const fields = currentFields();
    const check = core.checkFields(role, fields);
    const required = Object.entries(core.FIELDS[role]).filter(([, config]) => config.required);
    const count = byId('required-count');
    if (count) count.textContent = (required.length - check.missing.length) + ' / ' + required.length;
    const list = byId('live-check-list');
    if (list) {
      list.replaceChildren();
      for (const [key, config] of required) {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = '#' + prefix + '-' + key;
        link.textContent = (fields[key].trim() ? '已填写：' : '待补充：') + config.label;
        li.dataset.complete = fields[key].trim() ? 'true' : 'false';
        li.append(link); list.append(li);
      }
      for (const item of issueLocations(fields, check)) {
        const li = document.createElement('li'); const link = document.createElement('a');
        link.href = '#' + prefix + '-' + item.key; link.textContent = item.text;
        li.dataset.complete = 'false'; li.append(link); list.append(li);
      }
    }
    for (const key of fieldKeys) {
      const config = core.FIELDS[role][key];
      let error = '';
      if (fields[key].length > config.max) error = config.label + '超过 ' + config.max + ' 字符上限。';
      else if (showMissingErrors && config.required && !fields[key].trim()) error = '请补充' + config.label + '；不完整草稿仍可保存或导出。';
      else if (key === 'recommendation' && !core.RECOMMENDATIONS.includes(fields[key])) error = '请选择本页支持的草稿建议。';
      else if (key === 'orcid' && fields.orcid.trim() && !core.validOrcid(fields.orcid)) error = 'ORCID 格式或校验位无效；可留空，不验证身份。';
      else if (key === 'attachments') { try { core.parseAttachments(fields.attachments); } catch (issue) { error = issue.message; } }
      const errorNode = byId(key + '-error');
      if (errorNode) { errorNode.textContent = error; errorNode.hidden = !error; }
      if (byId(key).setAttribute) byId(key).setAttribute('aria-invalid', error ? 'true' : 'false');
    }
    updateReferences();
    return check;
  }
  function issueLocations(fields, check) {
    if (role !== 'submitter') return check.issues.map(text => ({ key: fieldKeys[0], text }));
    const entries = [];
    if (fields.orcid.trim() && !core.validOrcid(fields.orcid)) entries.push({ key: 'orcid', text: '修正 ORCID：仅检查格式及校验位。' });
    try { core.parseAttachments(fields.attachments); }
    catch (error) { entries.push({ key: 'attachments', text: error.message }); }
    return entries;
  }
  function showCheck() {
    showMissingErrors = true;
    const check = updateChecklist();
    const list = byId('check-list'); list.replaceChildren();
    for (const item of check.missing) {
      const li = document.createElement('li'); const link = document.createElement('a');
      link.href = '#' + prefix + '-' + item.key; link.textContent = '待补充：' + item.label;
      li.append(link); list.append(li);
    }
    for (const item of issueLocations(currentFields(), check)) {
      const li = document.createElement('li'); const link = document.createElement('a');
      link.href = '#' + prefix + '-' + item.key; link.textContent = item.text; li.append(link); list.append(li);
    }
    byId('check-heading').textContent = check.complete ? '本页必填项已填写' : '材料仍需补充或修正';
    byId('check-summary').textContent = check.complete ? '这里只检查本页文本字段；仍需核对目标期刊要求和原始证据。' : '缺少 ' + check.missing.length + ' 项必填内容，另有 ' + check.issues.length + ' 项格式或清单问题。可继续保存不完整草稿或导出。';
    checkPanel.hidden = false;
    if (checkPanel.scrollIntoView) checkPanel.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    return check;
  }
  function applyDraft(result, backup) {
    for (const key of fieldKeys) byId(key).value = result.draft.fields[key];
    if (!backup) { baseline = fingerprint(); expectedRaw = result.raw; loadedSaved = true; pendingEditor = false; }
    else { loadedSaved = false; pendingEditor = true; pendingEditorVersion += 1; }
    showMissingErrors = false;
    clearConfirmations(); hide('entry'); checkPanel.hidden = true;
    refreshDirty(); updateChecklist();
    setStatus((backup ? '已把原文备份载入编辑区，尚未保存。' : '已恢复本地草稿（保存时间：' + timeLabel(result.draft.capturedAt) + '）。') + '未提交或发送任何内容。', backup ? 'warning' : 'success');
    storageStatus.textContent = summary(readSaved());
  }
  function requestRestore(backup) {
    clearConfirmations();
    const result = readSaved(backup);
    if (!result.ok) { storageStatus.textContent = result.error; setStatus(result.error, 'error'); return; }
    if (!result.draft) { setStatus(backup ? '当前浏览器没有可恢复的原文备份。' : '当前浏览器没有可恢复的草稿。可先手动保存当前内容。', 'info'); return; }
    if (refreshDirty()) {
      pendingRestore = { raw: result.raw, backup: Boolean(backup), editor: fingerprint() };
      byId('restore-summary').textContent = summary(result);
      byId('restore-confirm').hidden = false;
      setStatus('当前内容未保存。恢复会用已保存的草稿替换当前编辑内容；可先导出当前内容。', 'warning');
      byId('restore-apply').focus(); return;
    }
    // Even a clean editor loads from a fresh read, never from the entry banner cache.
    const fresh = readSaved(backup);
    if (!fresh.ok || fresh.raw !== result.raw) { setStatus('恢复来源已变化或无法读取，请重新点击恢复。当前编辑已保留。', 'error'); return; }
    applyDraft(fresh, backup);
  }
  function clearEditor() {
    for (const key of fieldKeys) byId(key).value = '';
    baseline = fingerprint(); loadedSaved = false; pendingEditor = false; showMissingErrors = false;
    clearConfirmations(); hide('entry'); checkPanel.hidden = true;
    refreshDirty(); updateChecklist();
    setStatus('已开始新稿，编辑区已清空。浏览器中的已保存稿和原文备份仍可恢复或导出；首次覆盖须确认。', 'info');
  }
  async function performSave(fields, observedRaw) {
    const access = getStorage();
    if (access.error) { setStatus(access.error, 'error'); return; }
    const pendingVersionAtClick = pendingEditorVersion;
    saveInFlight = true; byId('save').disabled = true;
    let locks;
    try { locks = window.navigator && window.navigator.locks; } catch (_) {}
    const result = await core.saveDraft(access.storage, role, fields, undefined, { locks, expectedRaw: observedRaw });
    saveInFlight = false; byId('save').disabled = false;
    if (!result.ok) {
      storageStatus.textContent = result.error;
      setStatus(result.error + (refreshDirty() ? ' 当前内容尚未保存。' : ''), 'error', result.code);
      if (result.storageMayHaveChanged) expectedRaw = undefined;
      return;
    }
    // The user may have typed while a queued lock was pending: save the captured
    // snapshot and retain the dirty warning for edits made after the click.
    expectedRaw = result.raw; baseline = JSON.stringify(fields); loadedSaved = true;
    if (pendingEditorVersion === pendingVersionAtClick) pendingEditor = false;
    refreshDirty(); clearConfirmations(); hide('entry');
    storageStatus.textContent = '已核对浏览器中的保存内容。保存时间：' + timeLabel(result.draft.capturedAt) + (result.backupRaw !== null ? '；上一份原文已保留在备份中。' : '。');
    setStatus('已保存到当前浏览器（' + timeLabel(result.draft.capturedAt) + '）。这是本地草稿，未提交或发送。' + (dirty ? ' 保存期间的新编辑尚未保存。' : ''), dirty ? 'warning' : 'success', 'saved');
  }
  async function requestSave() {
    if (saveInFlight) return;
    clearConfirmations();
    const fields = currentFields();
    try { core.serializeDraft(core.createDraft(role, fields)); }
    catch (error) { setStatus(error.message, 'error'); return; }
    const observed = readSaved();
    if (observed.raw === undefined) { setStatus(observed.error, 'error'); return; }
    if (observed.ok && observed.draft && core.hasContent(observed.draft.fields) && !core.hasContent(fields)) { setStatus('全空编辑不能覆盖有效的已保存稿。新稿只清空编辑区；原稿仍可恢复或导出。', 'error', 'empty-overwrite'); return; }
    if (observed.raw !== null && (!loadedSaved || observed.raw !== expectedRaw)) {
      pendingSave = { raw: observed.raw, editor: fingerprint(), fields };
      byId('save-summary').textContent = summary(observed);
      byId('save-confirm').hidden = false;
      setStatus(observed.raw !== expectedRaw ? '检测到已保存稿变化。请阅读最新摘要；确认后才覆盖，并先保留原文备份。' : '尚未载入旧稿。首次保存会覆盖已保存稿；请阅读摘要并明确确认。', 'warning');
      byId('save-apply').focus(); return;
    }
    await performSave(fields, observed.raw);
  }
  function download(output, successText) {
    let url;
    try {
      const blob = new Blob([output.text], { type: output.mime }); url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = output.filename;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setStatus(successText + (refreshDirty() ? ' 当前内容仍未保存到浏览器。' : '') + ' 导出不是投稿或评议发送。', 'info');
    } catch (error) { if (url) URL.revokeObjectURL(url); setStatus('导出未完成：' + error.message + ' 当前编辑内容已保留。', 'error'); }
  }
  function exportFields(markdown, saved) {
    try {
      let fields = currentFields(), capturedAt;
      if (saved) {
        const result = readSaved();
        if (!result.ok) throw new Error(result.error + ' 可使用「下载保存原文」保留损坏内容。');
        if (!result.draft) throw new Error('当前浏览器没有已保存稿。');
        fields = result.draft.fields; capturedAt = result.draft.capturedAt;
      }
      const output = markdown ? core.buildMarkdown(role, fields, capturedAt) : core.buildExport(role, fields, capturedAt);
      if (saved) output.filename = output.filename.replace('local-draft-', 'saved-draft-');
      download(output, '已生成' + (saved ? '浏览器中已保存稿' : '当前编辑内容') + '的 ' + (markdown ? 'Markdown' : 'JSON') + ' 导出，浏览器已收到下载请求。');
    } catch (error) { setStatus('导出未完成：' + error.message + ' 当前编辑内容已保留。', 'error'); }
  }
  function exportRaw(backup) {
    const result = readSaved(backup);
    if (typeof result.raw !== 'string') { setStatus('没有可下载的' + (backup ? '原文备份。' : '已保存原文。') + (result.error || ''), 'error'); return; }
    download({ text: result.raw, filename: 'xiezhi-' + role + (backup ? '-backup' : '-saved-original') + '.json', mime: 'application/json;charset=utf-8' }, '已请求下载' + (backup ? '备份原文' : '已保存原文') + '；保留原始字符串，不代表它可以成功恢复。');
  }
  async function previewImport() {
    clearConfirmations();
    const input = byId('import-file');
    const file = input.files && input.files[0];
    if (!file) return;
    const generation = importGeneration;
    const editor = fingerprint();
    try {
      if (file.size > core.MAX_BYTES) throw new Error('导入文件超过 256 KiB 上限。');
      const raw = await file.text();
      const draft = core.parseImport(raw, role);
      if (generation !== importGeneration || editor !== fingerprint()) return;
      pendingImport = { file, raw, editor };
      byId('import-summary').textContent = '工作视角：' + (role === 'reviewer' ? '审稿人（虚构材料练习）' : '投稿人') + ' · ' + summary({ ok: true, raw, draft });
      byId('import-fields').replaceChildren();
      for (const key of fieldKeys) {
        const item = document.createElement('p');
        item.textContent = core.FIELDS[role][key].label + '：' + (draft.fields[key].slice(0, 180) || '（尚未填写）') + (draft.fields[key].length > 180 ? '…' : '');
        byId('import-fields').append(item);
      }
      byId('import-preview').hidden = false; byId('import-apply').focus();
      setStatus('导入已校验并生成预览。确认只替换编辑区，仍需手动保存；可先导出当前编辑。', 'warning');
    } catch (error) { if (generation === importGeneration) setStatus('导入失败：' + error.message + ' 当前编辑和已保存稿未改变。', 'error'); }
    finally { input.value = ''; }
  }
  async function applyImport() {
    const pending = pendingImport;
    if (!pending) return;
    try {
      if (pending.file.size > core.MAX_BYTES) throw new Error('导入文件超过 256 KiB 上限。');
      const freshRaw = await pending.file.text();
      const draft = core.parseImport(freshRaw, role);
      if (pendingImport !== pending || pending.editor !== fingerprint()) return;
      if (freshRaw !== pending.raw) throw new Error('文件与预览内容已变化，请重新选择并预览。');
      for (const key of fieldKeys) byId(key).value = draft.fields[key];
      loadedSaved = false; pendingEditor = true; pendingEditorVersion += 1; showMissingErrors = false;
      clearConfirmations(); hide('entry'); checkPanel.hidden = true;
      refreshDirty(); updateChecklist();
      setStatus('已把 JSON 内容导入编辑区，未写入浏览器存储。请核对后手动保存或导出。', 'warning');
    } catch (error) { if (pendingImport === pending) { clearConfirmations(); setStatus('导入失败：' + error.message + ' 当前编辑和已保存稿未改变。', 'error'); } }
  }
  function updateReferences() {
    if (role !== 'reviewer' || !byId('references')) return;
    const target = byId('references'); target.replaceChildren();
    for (const item of core.citedParagraphs(byId('concerns').value)) {
      const link = document.createElement('a'); link.href = '#' + item.anchor;
      link.textContent = '回到 ' + item.number + ' · ' + item.label;
      target.append(link);
    }
  }
  function insertReference(number) {
    const control = byId('concerns');
    try {
      const block = core.referenceBlock(number);
      const start = typeof control.selectionStart === 'number' ? control.selectionStart : control.value.length;
      const end = typeof control.selectionEnd === 'number' ? control.selectionEnd : start;
      const insert = (start > 0 ? '\n\n' : '') + block + '\n';
      const value = control.value.slice(0, start) + insert + control.value.slice(end);
      if (value.length > core.FIELDS.reviewer.concerns.max) throw new Error('插入引用将超过证据依据字段上限，请先缩短文本。');
      control.value = value;
      if (control.setSelectionRange) control.setSelectionRange(start + insert.length, start + insert.length);
      changed(); control.focus();
      if (control.scrollIntoView) control.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      setStatus('已插入 ' + number + ' 的固定材料引用块。可在证据依据下方回跳原段落；当前编辑尚未保存。', 'warning');
    } catch (error) { setStatus(error.message, 'error'); }
  }
  function changed() {
    clearConfirmations(); checkPanel.hidden = true; updateChecklist();
    setStatus(refreshDirty() ? '未保存：当前编辑内容已有变化。请手动保存或导出。' : '当前内容没有未保存的变化。', dirty ? 'warning' : 'info');
  }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', changed); form.addEventListener('change', changed);
  listen('save', 'click', requestSave);
  listen('save-apply', 'click', async () => {
    const pending = pendingSave;
    if (!pending || saveInFlight) return;
    const fresh = readSaved();
    if (fresh.raw !== pending.raw || pending.editor !== fingerprint()) { clearConfirmations(); setStatus('覆盖确认已失效：原文或编辑内容已变化。请重新点击保存并阅读最新摘要。', 'error'); return; }
    clearConfirmations(); await performSave(pending.fields, pending.raw);
  });
  listen('save-cancel', 'click', () => { clearConfirmations(); setStatus('已取消覆盖。当前编辑仍可导出。', 'info'); });
  listen('restore', 'click', () => requestRestore(false));
  listen('entry-continue', 'click', () => requestRestore(false));
  listen('restore-backup', 'click', () => requestRestore(true));
  listen('restore-apply', 'click', () => {
    const pending = pendingRestore;
    if (!pending) return;
    const fresh = readSaved(pending.backup);
    if (!fresh.ok || fresh.raw !== pending.raw || pending.editor !== fingerprint()) { clearConfirmations(); setStatus('恢复确认已失效：来源或编辑内容已变化，请重新恢复。当前编辑已保留。', 'error'); return; }
    applyDraft(fresh, pending.backup);
  });
  listen('restore-cancel', 'click', () => { clearConfirmations(); setStatus('继续编辑当前内容。' + (refreshDirty() ? ' 当前内容尚未保存。' : ''), dirty ? 'warning' : 'info'); });
  function requestNew() {
    const hasText = core.hasContent(currentFields()); clearConfirmations();
    if (hasText && refreshDirty()) { pendingNew = true; byId('new-confirm').hidden = false; byId('new-apply').focus(); return; }
    clearEditor();
  }
  listen('new', 'click', requestNew); listen('entry-new', 'click', requestNew);
  listen('new-apply', 'click', () => { if (pendingNew) clearEditor(); });
  listen('new-cancel', 'click', () => { clearConfirmations(); setStatus('继续当前编辑。', 'info'); });
  listen('check', 'click', showCheck);
  listen('export', 'click', () => exportFields(false, false));
  listen('export-md', 'click', () => exportFields(true, false));
  listen('export-saved', 'click', () => exportFields(false, true));
  listen('export-saved-md', 'click', () => exportFields(true, true));
  listen('export-original', 'click', () => exportRaw(false));
  listen('export-backup', 'click', () => exportRaw(true));
  listen('import', 'click', () => byId('import-file').click());
  listen('import-file', 'change', previewImport);
  listen('import-apply', 'click', applyImport);
  listen('import-cancel', 'click', () => { clearConfirmations(); setStatus('已取消导入。当前编辑未改变。', 'info'); });
  for (const item of core.PARAGRAPHS) listen('cite-' + item.number.toLowerCase(), 'click', () => insertReference(item.number));
  const more = byId('more'); const actions = byId('more-actions');
  listen('more', 'click', () => { const expanded = more.getAttribute('aria-expanded') === 'true'; more.setAttribute('aria-expanded', String(!expanded)); actions.dataset.open = String(!expanded); });
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && more && actions) { more.setAttribute('aria-expanded', 'false'); actions.dataset.open = 'false'; } });
  window.addEventListener('storage', event => {
    if (event.key !== core.storageKey(role) && event.key !== core.backupKey(role) && event.key !== null) return;
    clearConfirmations();
    storageStatus.textContent = '其他页面更改了本角色的已保存稿或备份。当前编辑已保留。';
    setStatus('检测到其他页面的存储变化，之前的覆盖、恢复和导入确认均已撤销。请重新读取摘要后操作；当前编辑可导出。', 'warning', 'storage-changed');
  });
  window.addEventListener('beforeunload', event => { if (refreshDirty()) { event.preventDefault(); event.returnValue = ''; } });
  // The sticky toolbar follows the measured shared header and its own wrapped height.
  const toolbar = byId('draft-toolbar');
  function measureToolbar() { if (toolbar && toolbar.getBoundingClientRect && document.body.style) document.body.style.setProperty('--draft-toolbar-height', Math.ceil(toolbar.getBoundingClientRect().height) + 'px'); }
  if (window.ResizeObserver && toolbar) { const observer = new window.ResizeObserver(measureToolbar); observer.observe(toolbar); }
  window.addEventListener('resize', measureToolbar); measureToolbar();
  const initial = readSaved(); expectedRaw = initial.raw;
  if (!initial.ok) { storageStatus.textContent = initial.error; setStatus(initial.error, 'error'); }
  else if (initial.draft) {
    storageStatus.textContent = '当前浏览器有已保存草稿（' + timeLabel(initial.draft.capturedAt) + '），点击「恢复草稿」或「继续旧稿」读取。';
    byId('entry-summary').textContent = summary(initial); byId('entry').hidden = false;
  } else storageStatus.textContent = '当前浏览器暂无已保存草稿。填写内容后请手动保存。';
  updateChecklist();
})();
