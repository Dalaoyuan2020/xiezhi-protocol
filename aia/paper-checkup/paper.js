'use strict';
const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let session = null, busy = false, selectedFile = null, activeUpload = null;
function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function controls(disabled) { $('chooseFile').disabled = disabled; document.querySelectorAll('[data-sample]').forEach(button => { button.disabled = disabled; }); }
function steps(number, completed = false) { for (let i = 1; i <= 4; i++) $('step' + i).className = i < number || completed ? 'done' : i === number ? 'active' : ''; }
async function getSession() {
  if (session && Date.parse(session.expiresAt) > Date.now()) return session;
  const response = await fetch('/paper-api/session', { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '无法建立体检会话，请刷新页面。');
  session = data; return session;
}
function upload(payload, csrf) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); activeUpload = xhr;
    xhr.open('POST', '/paper-api/assess'); xhr.timeout = 60000;
    xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('X-Paper-CSRF', csrf);
    xhr.upload.onprogress = event => { if (event.lengthComputable) $('progressDetail').textContent = `材料发送 ${Math.round(event.loaded / event.total * 100)}%`; };
    xhr.upload.onload = () => { steps(2); $('progressTitle').textContent = '正在核对结构与证据'; $('progressDetail').textContent = '等待检查结果'; };
    xhr.onload = () => {
      activeUpload = null;
      let data; try { data = JSON.parse(xhr.responseText); } catch { return reject(new Error('服务返回异常，请稍后重试。')); }
      if (xhr.status === 401) session = null;
      if (xhr.status < 200 || xhr.status >= 300) reject(new Error(data.error || '本次检查未完成，请稍后重试。')); else resolve(data);
    };
    xhr.onerror = () => { activeUpload = null; reject(new Error('连接中断，未取得体检结果。请检查网络后重试。')); };
    xhr.ontimeout = () => { activeUpload = null; reject(new Error('检查等待超时。请稍后重试，或换成较小的文本版 PDF。')); };
    xhr.onabort = () => { activeUpload = null; reject(new Error('上传已取消。')); };
    xhr.send(JSON.stringify(payload));
  });
}
function fileBase64(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取这个文件，请重新选择。')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
}
async function check({ file, sample }) {
  if (busy) return;
  error('');
  if (file && (!/\.(pdf|md|txt|zip)$/i.test(file.name) || file.size > 12 * 1024 * 1024 || !file.size)) { error('请选择非空的 PDF、Markdown、TXT 或 ARA ZIP 文件，大小不超过 12 MB。'); return; }
  busy = true; controls(true); $('report').hidden = true; $('progressSection').hidden = false;
  $('progressTitle').textContent = file ? '正在读取你的材料' : '正在读取虚构案例'; $('progressDetail').textContent = file ? file.name : '示例也经过同一套检查规则'; steps(1);
  try {
    const currentSession = await getSession();
    const payload = sample ? { sample } : { file: { name: file.name, base64: await fileBase64(file) } };
    const report = await upload(payload, currentSession.csrfToken);
    steps(4, true); $('progressTitle').textContent = '检查完成'; $('progressDetail').textContent = '结果来自实际材料检查';
    renderReport(report);
    $('report').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  } catch (reason) { error(reason.message || '体检未完成，请重试。'); }
  finally { busy = false; controls(false); $('progressSection').hidden = true; }
}
function renderReport(report) {
  $('reportKind').textContent = report.source.simulated ? '虚构教学案例 · 不对应真实论文' : '你的上传材料 · 私有报告';
  $('reportHeadline').textContent = report.headline;
  $('reportTitle').textContent = report.title;
  $('structureSummary').textContent = `${report.structure.filter(item => item.status === 'pass').length} / ${report.structure.length} 类材料已提供`;
  $('downloadReport').href = `/paper-api/reports/${encodeURIComponent(report.id)}/download`;
  $('sampleSourceRow').hidden = !report.source.simulated;
  if (report.source.simulated) $('sampleSource').href = report.source.downloadUrl;
  const grid = $('structureGrid'); grid.replaceChildren();
  report.structure.forEach((item, index) => {
    const card = element('div', null, `structure-item ${item.status}`); card.style.animationDelay = `${index * 55}ms`; card.title = item.detail;
    const heading = element('div', null, 'structure-title'); heading.append(element('span', item.label), element('span', item.status === 'pass' ? '已提供 ✓' : '待补充', 'structure-status'));
    card.append(heading, element('code', item.target)); grid.append(card);
  });
  const generated = report.generatedFiles || [];
  $('generatedNotice').hidden = !generated.length;
  $('generatedNotice').textContent = generated.length ? `服务额外生成了 ${generated.map(item => item.path).join('、')}，用于读取与导航。这些文件不算作原稿已具备 ARA 结构。` : '';
  const findings = $('findingsList'); findings.replaceChildren();
  $('findingsSummary').textContent = `${report.findings.filter(item => item.severity === 'high').length} 项优先核对`;
  for (const item of [...report.findings].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]))) {
    const card = element('article', null, `finding ${item.severity}`);
    card.append(element('h4', item.title), element('p', item.detail));
    if (item.paths?.length) { const paths = element('div', null, 'finding-paths'); item.paths.forEach(file => paths.append(element('code', file))); card.append(paths); }
    findings.append(card);
  }
  if (!report.findings.length) findings.append(element('p', '本规则未发现材料缺口。仍需独立执行实验并核对科学结论。', 'subtle'));
  const checks = $('checkList'); checks.replaceChildren();
  for (const item of report.checks) {
    const details = element('details'), summary = element('summary'), status = element('span', null, `check-status ${item.status}`); status.setAttribute('aria-hidden', 'true');
    const state = element('span', ({ pass: '通过：', warn: '需复核：', fail: '需优先核对：' })[item.status], 'sr-only');
    summary.append(status, state, element('span', item.label), element('span', `${item.earned} / ${item.weight}`, 'check-score'));
    const body = element('div', item.detail, 'check-body');
    if (item.paths.length) body.append(element('div', `检查文件：${item.paths.join('、')}`));
    details.append(summary, body); checks.append(details);
  }
  $('hashScope').textContent = report.source.simulated ? '下方指纹对应可下载的虚构案例 ZIP。你可以下载后核对 SHA-256，也可以重新上传同一份材料复检。' : `SHA-256 对应上传的原始文件：${report.source.name}（${report.source.bytes.toLocaleString()} 字节）`;
  $('sourceHash').textContent = report.source.sha256;
  const files = $('filesList'); files.replaceChildren();
  for (const item of report.originalFiles) { const row = element('div', `${item.path} · ${item.bytes.toLocaleString()} 字节`, 'file-item'); row.append(element('span', item.sha256)); files.append(row); }
  $('limitations').replaceChildren(...report.limitations.map(item => element('li', item)));
  $('privacyNote').textContent = report.privacy;
  $('report').hidden = false;
  const target = report.score.value, started = performance.now();
  function frame(time) { const progress = reducedMotion ? 1 : Math.min((time - started) / 850, 1); const value = Math.round(target * (1 - Math.pow(1 - progress, 3))); $('scoreValue').textContent = value; $('scoreRing').style.setProperty('--score', value); if (progress < 1) requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
}
$('chooseFile').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', event => { selectedFile = event.target.files[0]; if (selectedFile) check({ file: selectedFile }); event.target.value = ''; });
for (const button of document.querySelectorAll('[data-sample]')) button.addEventListener('click', () => check({ sample: button.dataset.sample }));
const dropzone = $('dropzone');
dropzone.addEventListener('dragover', event => { event.preventDefault(); if (!busy) dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('dragover'); if (busy) return; if (event.dataTransfer.files.length !== 1) return error('请一次提交一个 PDF、文本文件或 ARA ZIP。'); selectedFile = event.dataTransfer.files[0]; if (selectedFile) check({ file: selectedFile }); });
$('another').addEventListener('click', () => { error(''); $('uploadSection').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' }); $('chooseFile').focus({ preventScroll: true }); });
// Avoid navigating away when a file is dropped just outside the upload box.
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
