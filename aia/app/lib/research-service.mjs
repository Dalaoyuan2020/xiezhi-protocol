import { mkdir, readFile, writeFile, rename, rmdir, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareImport, inspectResearch } from '../../research-core/lib/research.mjs';
import { pdfToText } from '../../research-core/lib/pdf.mjs';
import { fail, field, id, digest, hashBytes } from './store.mjs';

const MAX_FILE = 12 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const binaryTypes = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.zip': 'application/zip', '.npy': 'application/octet-stream', '.npz': 'application/octet-stream', '.parquet': 'application/octet-stream' };
const textTypes = new Set(['.md','.txt','.csv','.tsv','.json','.jsonl','.yaml','.yml','.toml','.py','.js','.mjs','.cjs','.r','.jl','.sh','.ipynb','.log','.tex','.bib','.xml','.html','.css','.c','.h','.cpp','.rs','.go','.lock','.ini','.cfg','.ts']);
export function safePath(value) {
  if (typeof value !== 'string' || value.length > 400 || !value || value !== value.normalize('NFC') || /[\\\x00-\x1f\x7f:*?"<>|]/.test(value) || value.startsWith('/')) fail(400, '文件路径不合法。');
  if (value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail(400, '文件路径不合法。');
  return value;
}
const metadata = file => { const { text, base64, product, ...rest } = file; return rest; };
function artifactMetadata(artifact) { const { sourceDir, ...metadata } = artifact; return { ...metadata, files: artifact.files.map(({ text, base64, ...rest }) => rest) }; }
export async function checkedBytes(root, file) {
  const safe = safePath(file.path);
  const resolvedRoot = await realpath(root);
  let current = root;
  for (const [index, part] of safe.split('/').entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === safe.split('/').length - 1 ? !stat.isFile() : !stat.isDirectory())) fail(409, '归档路径不再是预期的普通文件。');
  }
  const relative = path.relative(resolvedRoot, await realpath(current));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(409, '归档路径越界。');
  const bytes = await readFile(current);
  if (bytes.length !== file.bytes || hashBytes(bytes) !== file.sha256) fail(409, '归档文件已变化，不能作为原版本提供。');
  return bytes;
}

export async function discardArchive(directory, parent) {
  const target = path.resolve(directory), boundary = path.resolve(parent);
  const relative = path.relative(boundary, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep) || !/^(?:import|archive|research)-[a-f0-9-]{36}$/.test(relative)) throw new Error('Refusing cleanup outside allocated archive directory');
  const stat = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing cleanup of non-directory archive');
  const resolvedRelative = path.relative(await realpath(boundary), await realpath(target));
  if (resolvedRelative !== relative) throw new Error('Refusing cleanup of redirected archive');
  await rm(target, { recursive: true, force: false });
}

export function checkStorageQuota(store, userId, additionalBytes = 0) {
  const researchBytes = store.all('SELECT data FROM research WHERE owner_id=?', userId).reduce((sum, row) => sum + JSON.parse(row.data).files.reduce((s, file) => s + file.bytes, 0), 0);
  const deliveryBytes = store.all('SELECT d.data FROM deliveries d JOIN tasks t ON t.id=d.task_id WHERE t.executor_id=?', userId).reduce((sum, row) => sum + JSON.parse(row.data).files.reduce((s, file) => s + file.bytes, 0), 0);
  if (researchBytes + deliveryBytes + additionalBytes > 512 * 1024 * 1024) fail(413, '当前账号归档总量上限为 512 MB。');
}

export function createResearchService(store, auth, { dataDir, pdfParser = pdfToText } = {}) {
  function accessible(userId, researchId) {
    return Boolean(store.one(`SELECT r.id FROM research r WHERE r.id=? AND (r.owner_id=?
      OR EXISTS(SELECT 1 FROM reviews v WHERE v.research_id=r.id AND v.reviewer_id=?)
      OR EXISTS(SELECT 1 FROM tasks t WHERE t.research_id=r.id AND (t.executor_id=? OR t.verifier_id=?)))`, researchId, userId, userId, userId, userId));
  }
  function row(userId, researchId, ownerOnly = false) {
    const record = store.one('SELECT * FROM research WHERE id=?', researchId);
    if (!record) fail(404, '研究不存在。');
    if (ownerOnly ? record.owner_id !== userId : !accessible(userId, researchId)) fail(403, '你没有这份研究的访问权限。');
    return record;
  }
  function latestAssessment(researchId) {
    const result = store.one('SELECT data FROM assessments WHERE research_id=? ORDER BY rowid DESC LIMIT 1', researchId);
    return result ? JSON.parse(result.data) : null;
  }
  function present(record) {
    const research = typeof record.data === 'string' ? JSON.parse(record.data) : record;
    const a = latestAssessment(research.id);
    return { ...research, assessmentSummary: a ? { id: a.id, score: a.score, createdAt: a.createdAt, findingCounts: Object.fromEntries(['high','medium','low'].map(level => [level, a.findings.filter(f => f.severity === level).length])) } : null };
  }
  function list(userId) {
    return store.all(`SELECT r.* FROM research r WHERE r.owner_id=? OR EXISTS(SELECT 1 FROM reviews v WHERE v.research_id=r.id AND v.reviewer_id=?)
      OR EXISTS(SELECT 1 FROM tasks t WHERE t.research_id=r.id AND (t.executor_id=? OR t.verifier_id=?)) ORDER BY r.rowid DESC`, userId, userId, userId, userId).map(present);
  }
  async function importResearch(user, payload, actor = null) {
    const checkQuota = additional => {
      if (store.one('SELECT count(*) AS count FROM research WHERE owner_id=?', user.id).count >= 100) fail(409, '当前账号最多保存 100 个研究版本。');
      checkStorageQuota(store, user.id, additional);
    };
    checkQuota(0);
    const previousId = payload.previousVersionId == null || payload.previousVersionId === '' ? null : field(payload.previousVersionId, '前一版本', 1, 100);
    const previous = previousId ? JSON.parse(row(user.id, previousId, true).data) : null;
    const staging = path.join(dataDir, 'staging', id('import'));
    await mkdir(staging, { recursive: true });
    let artifact;
    try { artifact = await prepareImport(payload, { dataDir: staging, pdfToText: pdfParser }); }
    catch (error) { await discardArchive(staging, path.join(dataDir, 'staging')); fail(400, error.message); }
    try { checkQuota(artifact.files.reduce((sum, file) => sum + file.bytes, 0)); }
    catch (error) { await discardArchive(staging, path.join(dataDir, 'staging')); throw error; }
    const library = path.join(dataDir, 'library');
    await mkdir(library, { recursive: true });
    await rename(path.dirname(artifact.sourceDir), path.join(library, artifact.id));
    await rmdir(path.join(staging, 'library')); await rmdir(staging);
    artifact.sourceDir = path.join(library, artifact.id, 'files');
    const research = { id: artifact.id, ownerId: user.id, ownerName: user.displayName, title: artifact.title, abstract: artifact.abstract,
      version: previous ? previous.version + 1 : 1, previousVersionId: previousId, rootHash: artifact.rootHash, sourceType: artifact.sourceType,
      files: artifact.files.map(metadata), createdAt: new Date().toISOString(), ...(actor ? { createdBy: actor } : {}) };
    try { store.transaction(() => {
      checkQuota(artifact.files.reduce((sum, file) => sum + file.bytes, 0));
      if (previousId) row(user.id, previousId, true);
      store.run('INSERT INTO research(id,owner_id,previous_id,data,artifact) VALUES(?,?,?,?,?)', research.id, user.id, previousId, JSON.stringify(research), JSON.stringify(artifactMetadata(artifact)));
      store.event(research.id, user.id, 'research-imported', { rootHash: research.rootHash, previousVersionId: previousId });
    }); } catch (error) { await discardArchive(path.dirname(artifact.sourceDir), library); throw error; }
    return { research: present(research) };
  }
  async function loadArtifact(record) {
    const artifact = JSON.parse(record.artifact);
    artifact.sourceDir = path.join(dataDir, 'library', record.id, 'files');
    const files = [];
    for (const file of artifact.files) {
      const bytes = await checkedBytes(artifact.sourceDir, file);
      files.push({ ...file, ...(file.binary ? { base64: bytes.toString('base64') } : { text: bytes.toString('utf8') }) });
    }
    return { ...artifact, files };
  }
  async function assess(userId, researchId) {
    const record = row(userId, researchId);
    const assessment = inspectResearch(await loadArtifact(record));
    store.transaction(() => {
      row(userId, researchId);
      store.run('INSERT INTO assessments(id,research_id,data) VALUES(?,?,?)', assessment.id, researchId, JSON.stringify(assessment));
      store.event(researchId, userId, 'materials-assessed', { assessmentId: assessment.id, artifactHash: assessment.artifactHash });
    });
    return { assessment };
  }
  async function file(userId, researchId, filePath) {
    const artifact = JSON.parse(row(userId, researchId).artifact);
    const file = artifact.files.find(f => f.path === filePath);
    if (!file) fail(404, '研究中没有这个文件。');
    const bytes = await checkedBytes(path.join(dataDir, 'library', researchId, 'files'), file);
    return { file: metadata(file), bytes };
  }
  function report(userId, researchId) { row(userId, researchId); return latestAssessment(researchId) || fail(404, '尚未运行材料预检。'); }
  const artifactForReview = (userId, researchId) => loadArtifact(row(userId, researchId, true));
  return { row, accessible, present, list, importResearch, assess, file, report, latestAssessment, artifactForReview };
}

/** Uploads are inert data. This never executes scripts or expands archives. */
export async function archiveDelivery(dataDir, uploads) {
  if (!Array.isArray(uploads) || uploads.length < 1 || uploads.length > 100) fail(400, '交付须包含 1 至 100 个文件。');
  const names = new Set();
  let total = 0;
  const decoded = uploads.map(upload => {
    if (!upload || typeof upload !== 'object') fail(400, '文件格式不正确。');
    const filePath = safePath(upload.path);
    if (names.has(filePath.toLowerCase())) fail(400, '文件路径重复。'); names.add(filePath.toLowerCase());
    let bytes;
    if (Object.hasOwn(upload, 'text') === Object.hasOwn(upload, 'base64')) fail(400, '文件只可指定 text 或 base64 之一。');
    if (Object.hasOwn(upload, 'text')) {
      if (typeof upload.text !== 'string' || upload.text !== Buffer.from(upload.text).toString('utf8')) fail(400, '文件文字不是有效 UTF-8。');
      bytes = Buffer.from(upload.text);
    } else {
      if (typeof upload.base64 !== 'string' || upload.base64.length > Math.ceil(MAX_FILE / 3) * 4 || upload.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(upload.base64)) fail(400, '文件 base64 编码无效。');
      bytes = Buffer.from(upload.base64, 'base64');
      if (bytes.toString('base64') !== upload.base64) fail(400, '文件 base64 编码无效。');
    }
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_TOTAL) fail(413, '单文件上限 12MB，交付总量上限 20MB。');
    const ext = path.posix.extname(filePath).toLowerCase();
    const binary = Object.hasOwn(binaryTypes, ext);
    if (!binary && !textTypes.has(ext) && !['Dockerfile','Makefile','LICENSE'].includes(path.posix.basename(filePath))) fail(400, `不支持的交付文件类型：${filePath}`);
    if (!binary) { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) throw new Error(); } catch { fail(400, '交付文本必须是有效 UTF-8。'); } }
    return { bytes, file: { path: filePath, bytes: bytes.length, sha256: hashBytes(bytes), binary, mimeType: binaryTypes[ext] || 'text/plain; charset=utf-8' } };
  });
  for (const { file } of decoded) { const parts = file.path.toLowerCase().split('/'); for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) fail(400, '文件与目录路径冲突。'); }
  decoded.sort((a,b) => a.file.path < b.file.path ? -1 : 1);
  const directory = path.join(dataDir, 'deliveries', id('archive'));
  await mkdir(directory, { recursive: true });
  try { for (const { bytes, file } of decoded) { const target = path.join(directory, ...file.path.split('/')); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); } }
  catch (error) { await discardArchive(directory, path.join(dataDir, 'deliveries')); throw error; }
  const files = decoded.map(({ file }) => file);
  return { directory, files };
}
