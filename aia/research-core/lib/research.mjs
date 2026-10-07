import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 100;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sortKeys = (value) => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value;
const stable = (value) => JSON.stringify(sortKeys(value));
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const markdownPath = (value) => value.split('/').map((part) => encodeURIComponent(part).replace(/[()]/g, (character) => character === '(' ? '%28' : '%29')).join('/');
const rootHashFor = (files) => sha(JSON.stringify([...files].sort(byPath).map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 }))));
const mimeTypes = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.zip': 'application/zip', '.npy': 'application/octet-stream', '.npz': 'application/octet-stream', '.parquet': 'application/octet-stream' };
const textExtensions = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.py', '.js', '.mjs', '.cjs', '.r', '.jl', '.sh', '.ipynb', '.log', '.tex', '.bib', '.xml', '.html', '.css', '.c', '.h', '.cpp', '.rs', '.go', '.lock', '.ini', '.cfg', '.ts']);

function safePath(value) {
  if (typeof value !== 'string' || value.length > 400 || !value || value !== value.normalize('NFC')
    || /[\\\x00-\x1f\x7f:*?"<>|]/.test(value) || value.startsWith('/')) throw new Error('文件路径不合法或越界');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('文件路径不合法或越界');
  return value;
}

function targetPath(root, relative) {
  safePath(relative);
  const target = path.resolve(root, ...relative.split('/'));
  const remainder = path.relative(root, target);
  if (!remainder || remainder.startsWith('..') || path.isAbsolute(remainder)) throw new Error('路径超出材料归档');
  return target;
}

async function checkedRoot(directory, parent) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('归档目录必须是实际目录，禁止符号链接');
  const resolved = await realpath(directory);
  if (parent) {
    const relative = path.relative(await realpath(parent), resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('归档目录越界');
  }
  return resolved;
}

async function checkedRead(root, relative) {
  let current = root;
  const segments = safePath(relative).split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`材料禁止符号链接或特殊文件：${relative}`);
  }
  const resolved = await realpath(current);
  const remainder = path.relative(await realpath(root), resolved);
  if (!remainder || remainder.startsWith('..') || path.isAbsolute(remainder)) throw new Error(`材料路径越界：${relative}`);
  return readFile(current);
}

function decodeText(bytes, filePath) {
  try {
    const result = textDecoder.decode(bytes);
    if (result.includes('\u0000')) throw new Error('NUL');
    return result;
  } catch { throw new Error(`文本必须是有效 UTF-8：${filePath}`); }
}

function decodeUpload(file) {
  if (!file || typeof file !== 'object' || typeof file.path !== 'string') throw new Error('每个导入文件必须提供路径');
  const hasText = Object.hasOwn(file, 'text');
  const hasBase64 = Object.hasOwn(file, 'base64');
  if (hasText === hasBase64) throw new Error('文件必须只提供 text 或 base64 之一');
  let bytes;
  if (hasText) {
    if (typeof file.text !== 'string' || Buffer.byteLength(file.text) > MAX_FILE_BYTES || file.text !== Buffer.from(file.text).toString('utf8')) throw new Error('文件文本无效或超过 12MB');
    bytes = Buffer.from(file.text, 'utf8');
  } else {
    if (typeof file.base64 !== 'string' || file.base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4
      || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new Error('文件 base64 编码无效或超过 12MB');
    bytes = Buffer.from(file.base64, 'base64');
    if (bytes.toString('base64') !== file.base64) throw new Error('文件 base64 编码无效');
  }
  if (bytes.length > MAX_FILE_BYTES) throw new Error('单个文件不得超过 12MB');
  return { path: safePath(file.path), bytes };
}

function fileFromBytes(filePath, bytes, product) {
  const extension = path.posix.extname(filePath).toLowerCase();
  const binary = Boolean(mimeTypes[extension]);
  if (!binary && !textExtensions.has(extension) && !['Dockerfile', 'Makefile', 'LICENSE'].includes(path.posix.basename(filePath))) throw new Error(`不支持的文件类型：${filePath}`);
  const file = { path: filePath, product, bytes: bytes.length, sha256: sha(bytes), binary, mimeType: mimeTypes[extension] ?? 'text/plain; charset=utf-8' };
  if (binary) file.base64 = bytes.toString('base64');
  else file.text = decodeText(bytes, filePath);
  return file;
}

function field(value, max, label) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) throw new Error(`${label}格式无效或过长`);
  return value.trim();
}

/** Archive the supplied bytes; uploaded code is data and never becomes executable. */
export async function prepareImport(payload, { dataDir, pdfToText } = {}) {
  if (!payload || !Array.isArray(payload.files) || !payload.files.length || payload.files.length > MAX_FILES) throw new Error('请导入 1 至 100 个文件');
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('材料数据目录必须为服务端绝对路径');
  let uploads = payload.files.map(decodeUpload);
  if (uploads.reduce((total, file) => total + file.bytes.length, 0) > MAX_TOTAL_BYTES) throw new Error('导入文件合计不得超过 20MB');
  // Browser folder pickers prefix every entry with the selected directory name.
  if (uploads.every((file) => file.path.includes('/'))) {
    const first = uploads[0].path.split('/')[0];
    if (!['logic', 'src', 'trace', 'evidence', '_derived'].includes(first) && uploads.every((file) => file.path.startsWith(`${first}/`))) uploads = uploads.map((file) => ({ ...file, path: safePath(file.path.slice(first.length + 1)) }));
  }
  const seen = new Set();
  for (const file of uploads) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error(`存在重复文件路径：${file.path}`);
    seen.add(key);
  }
  for (const file of uploads) {
    const parts = file.path.toLowerCase().split('/');
    for (let index = 1; index < parts.length; index++) if (seen.has(parts.slice(0, index).join('/'))) throw new Error('文件路径与目录冲突');
  }
  const isARA = uploads.some((file) => /^(?:logic|src|trace|evidence)\//.test(file.path)) || uploads.some((file) => file.path === 'PAPER.md');
  if (!isARA && !uploads.some((file) => /\.(md|txt|pdf)$/i.test(file.path))) throw new Error('请提供论文 MD、TXT、PDF 或 ARA 目录');
  const titleInput = field(payload.title, 240, '标题');
  const abstractInput = field(payload.abstract, 3000, '摘要');
  const explicitClaim = field(payload.claim, 10000, '主张');
  const primary = uploads.find((file) => file.path === 'PAPER.md') ?? uploads.find((file) => /\.(md|txt|pdf)$/i.test(file.path));
  if (!primary) throw new Error('ARA 目录需要至少一份论文正文或 Markdown 说明');
  const files = uploads.map(({ path: filePath, bytes }) => fileFromBytes(filePath, bytes,
    filePath === primary.path || filePath === 'PAPER.md' || filePath.startsWith('logic/') || (!isARA && /\.(md|txt|pdf)$/i.test(filePath)) ? 'fulltext' : 'data'));
  const generated = [];
  const addText = (filePath, text, product = 'fulltext') => {
    if (seen.has(filePath.toLowerCase())) throw new Error(`生成文件与导入路径冲突：${filePath}`);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) throw new Error('提取后的正文超过 12MB');
    seen.add(filePath.toLowerCase());
    files.push(fileFromBytes(filePath, bytes, product));
    generated.push(filePath);
  };
  let paperText = files.find((file) => file.path === primary.path)?.text ?? '';
  if (primary.path.toLowerCase().endsWith('.pdf')) {
    if (typeof pdfToText !== 'function') throw new Error('当前服务未配置 PDF 文本提取；请先导出为 UTF-8 TXT 或 Markdown');
    let extracted;
    try { extracted = await pdfToText(Buffer.from(primary.bytes)); }
    catch (error) { throw new Error(`PDF 文本提取失败，未保存伪造正文：${error.message}`); }
    if (typeof extracted !== 'string' || extracted.trim().length < 20) throw new Error('PDF 未提取到足够文字；扫描件请先 OCR，或导入 TXT/Markdown');
    decodeText(Buffer.from(extracted), primary.path);
    paperText = extracted;
    addText(`_derived/${path.posix.basename(primary.path)}.txt`, extracted);
  }
  const title = titleInput || paperText.match(/^#\s+(.+)$/m)?.[1]?.trim()?.slice(0, 240) || path.posix.basename(primary.path, path.posix.extname(primary.path));
  const abstract = abstractInput || '用户导入的研究材料。正文、附件与主张以归档文件为准；尚未获得科学有效性认证。';
  if (!seen.has('paper.md')) addText('PAPER.md', `# ${title}\n\n${abstract}\n\n## 导入来源\n\n原件：[${primary.path}](${markdownPath(primary.path)})\n\n此文件是工作台生成的导航清单；原文未被改写。${primary.path.toLowerCase().endsWith('.pdf') ? `\n\n提取正文：[_derived/${path.posix.basename(primary.path)}.txt](${markdownPath(`_derived/${path.posix.basename(primary.path)}.txt`)})\n\nPDF 提取可能丢失表格布局、公式和图中文字，请结合原件核对。` : ''}\n`);
  if (explicitClaim) {
    if (seen.has('logic/claims.md')) throw new Error('已提供 logic/claims.md；请直接在该文件声明主张，避免覆盖原件');
    addText('logic/claims.md', `# 用户声明的主张\n\n## C1 · 待核查主张\n\n- **Statement：** ${explicitClaim}\n\n本文件仅记录用户声明；主张尚未验证。\n`);
  }
  files.sort(byPath);
  if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_TOTAL_BYTES) throw new Error('含提取正文的归档超过 20MB');
  const id = `research-${randomUUID()}`;
  const library = path.join(dataDir, 'library');
  await mkdir(dataDir, { recursive: true });
  await checkedRoot(dataDir);
  await mkdir(library, { recursive: true });
  await checkedRoot(library, dataDir);
  const archive = path.join(library, id);
  await mkdir(archive);
  const sourceDir = path.join(archive, 'files');
  await mkdir(sourceDir);
  const artifact = {
    id, title, version: `import-${new Date().toISOString().slice(0, 10)}`, abstract,
    scenario: '用户导入；仅进行材料与证据检查，不运行上传代码，也不宣称科学复现。',
    claim: { id: 'DOCUMENT', text: '核对所提交研究的主张与证据材料', expectedAccuracy: null, tolerance: 0 },
    rootHash: rootHashFor(files), prices: { fulltext: 10, data: 15 }, sourceDir, files,
    runMode: 'evidence-review', sourceType: isARA ? 'ara' : 'paper', importedAt: new Date().toISOString(),
    originalPaths: uploads.map((file) => file.path).sort(), generatedPaths: generated.sort(),
  };
  const claims = deriveResearchClaims(artifact);
  if (claims.length) artifact.claim = { id: claims[0].id, text: claims[0].statement, expectedAccuracy: null, tolerance: 0 };
  for (const file of files) {
    const destination = targetPath(sourceDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.binary ? Buffer.from(file.base64, 'base64') : Buffer.from(file.text, 'utf8'), { flag: 'wx' });
  }
  const { sourceDir: _sourceDir, files: _files, ...meta } = artifact;
  const manifest = { schemaVersion: 1, artifact: meta, files: files.map(({ text: _text, base64: _base64, ...file }) => file) };
  await writeFile(path.join(archive, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
  return artifact;
}

/** Restore immutable imports, verifying all archived bytes before exposing any artifact. */
export async function loadImportedArtifacts(dataDir) {
  const library = path.join(dataDir, 'library');
  try { await lstat(library); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  await checkedRoot(dataDir);
  await checkedRoot(library, dataDir);
  const artifacts = [];
  for (const entry of (await readdir(library)).sort()) {
    if (!/^research-[a-f0-9-]{36}$/.test(entry)) throw new Error('研究归档目录名称无效');
    const archive = path.join(library, entry);
    await checkedRoot(archive, library);
    const manifest = JSON.parse((await checkedRead(archive, 'manifest.json')).toString('utf8'));
    if (manifest.schemaVersion !== 1 || manifest.artifact?.id !== entry || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES + 3) throw new Error('研究归档清单格式不匹配');
    const sourceDir = path.join(archive, 'files');
    await checkedRoot(sourceDir, archive);
    const files = [];
    const seen = new Set();
    for (const listed of manifest.files) {
      const filePath = safePath(listed.path);
      if (seen.has(filePath.toLowerCase()) || !['fulltext', 'data'].includes(listed.product)) throw new Error('归档文件路径重复或产品类别无效');
      seen.add(filePath.toLowerCase());
      const bytes = await checkedRead(sourceDir, filePath);
      if (bytes.length > MAX_FILE_BYTES || bytes.length !== listed.bytes || sha(bytes) !== listed.sha256) throw new Error(`归档文件哈希或长度不匹配：${filePath}`);
      files.push(fileFromBytes(filePath, bytes, listed.product));
    }
    files.sort(byPath);
    if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_TOTAL_BYTES || rootHashFor(files) !== manifest.artifact.rootHash) throw new Error('研究归档版本哈希不匹配');
    artifacts.push({ ...manifest.artifact, sourceDir, files, runMode: 'evidence-review', sourceType: manifest.artifact.sourceType === 'ara' ? 'ara' : 'paper' });
  }
  return artifacts;
}

function linkReferences(text) {
  const refs = [];
  for (const match of text.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) refs.push({ reference: match[1] ?? match[2], rooted: false });
  for (const match of text.matchAll(/`((?:\.{1,2}\/|(?:logic|src|trace|evidence)\/)[^`\n]+)`/g)) refs.push({ reference: match[1], rooted: /^(logic|src|trace|evidence)\//.test(match[1]) });
  return refs.filter((ref, index) => refs.findIndex((candidate) => candidate.reference === ref.reference && candidate.rooted === ref.rooted) === index);
}

function resolveReference({ reference, rooted }, source, available) {
  if (/^(https?:|doi:|mailto:)/i.test(reference)) return { reference, external: true, resolved: false };
  if (reference.startsWith('#')) return { reference, path: source, resolved: available.has(source), anchor: reference.slice(1) };
  let decoded;
  try { decoded = decodeURIComponent(reference.split('#')[0].split('?')[0]); }
  catch { return { reference, resolved: false, reason: '链接编码无效' }; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || /[\\\x00-\x1f]/.test(decoded) || decoded.startsWith('/')) return { reference, resolved: false, reason: '路径越界或协议不支持' };
  const resolved = path.posix.normalize(rooted ? decoded : path.posix.join(path.posix.dirname(source), decoded));
  if (resolved === '..' || resolved.startsWith('../')) return { reference, resolved: false, reason: '路径越界' };
  const candidate = resolved;
  try { safePath(candidate); } catch { return { reference, resolved: false, reason: '文件路径不合法' }; }
  return { reference, path: candidate, resolved: available.has(candidate), reason: available.has(candidate) ? null : '归档中不存在此文件' };
}

/** Read only explicit C<n> or Claim<n> sections. Do not invent research claims. */
export function deriveResearchClaims(artifact) {
  const texts = artifact.files.filter((file) => typeof file.text === 'string');
  const claimFile = texts.find((file) => file.path === 'logic/claims.md');
  const sources = claimFile ? [claimFile] : texts.filter((file) => file.product === 'fulltext' && /\.(md|txt)$/i.test(file.path));
  const available = new Set(artifact.files.map((file) => file.path));
  const claims = [];
  for (const source of sources) {
    const headings = [...source.text.matchAll(/^#{1,4}\s+(C\d+|Claim\s*\d+|主张\s*\d+)\b([^\n]*)$/gim)];
    for (let index = 0; index < headings.length; index++) {
      const heading = headings[index];
      const body = source.text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? source.text.length);
      const id = /^C\d+$/i.test(heading[1]) ? heading[1].toUpperCase() : `C${heading[1].match(/\d+/)[0]}`;
      if (claims.some((claim) => claim.id === id)) continue;
      const explicit = body.match(/^\s*[-*]?\s*(?:\*\*)?(?:Statement|主张|声明|陈述)[：:]\s*(?:\*\*)?\s*(.+)$/im);
      const statement = (explicit?.[1] ?? body.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !part.startsWith('<')) ?? '').replace(/^\*\*\s*/, '').trim();
      const references = linkReferences(body);
      const evidence = references.map((ref) => ref.reference);
      const refs = references.map((ref) => resolveReference(ref, source.path, available));
      claims.push({ id, title: `${id}${heading[2]}`.trim(), statement, source: source.path,
        evidence, resolvedEvidence: [...new Set(refs.filter((ref) => ref.resolved).map((ref) => ref.path))],
        missingEvidence: refs.filter((ref) => !ref.resolved && !ref.external).map((ref) => ref.reference) });
    }
  }
  return claims;
}

function auditContent(assessment) {
  return { score: assessment.score, checks: assessment.checks, findings: assessment.findings, artifactHash: assessment.artifactHash };
}

/** Deterministic structural checks, not an LLM, plagiarism detector, or scientific certification. */
export function inspectResearch(artifact, { now } = {}) {
  const createdAt = typeof now === 'function' ? now() : now ?? new Date().toISOString();
  const textFiles = artifact.files.filter((file) => typeof file.text === 'string');
  const available = new Set(artifact.files.map((file) => file.path));
  const claims = deriveResearchClaims(artifact);
  const checks = [];
  const findings = [];
  const addFinding = (id, severity, title, detail, paths, claimId) => findings.push({ id, severity, title, detail, paths: [...new Set(paths)], ...(claimId ? { claimId } : {}), suggestedTask: `核对“${title}”，逐项引用原文件与检查依据，并说明可确认事项和剩余限制。` });
  const addCheck = (id, label, status, weight, detail, paths) => checks.push({ id, label, status, weight, earned: status === 'pass' ? weight : status === 'warn' ? Math.floor(weight / 2) : 0, detail, paths: [...new Set(paths)] });

  const primary = textFiles.filter((file) => file.product === 'fulltext' && !file.path.startsWith('logic/') && !artifact.generatedPaths?.includes(file.path));
  const extracted = textFiles.filter((file) => file.path.startsWith('_derived/'));
  const enoughText = [...primary, ...extracted].some((file) => file.text.trim().length >= 80);
  addCheck('manuscript', '可读取的研究正文', enoughText ? 'pass' : 'warn', 10, enoughText ? '归档中存在可读取正文；这里只确认文字可检查，不判断内容质量。' : '未找到至少 80 字符的可检查研究正文；生成的导航清单不计作原文。', [...primary, ...extracted].map((file) => file.path));
  if (!enoughText) addFinding('missing-manuscript', 'medium', '研究正文不足以检查', '请补充实际论文正文；导航清单、标题和摘要不能代替完整研究说明。', primary.map((file) => file.path));

  addCheck('claims', '明确声明的主张', claims.length ? 'pass' : 'warn', 15, claims.length ? `读取到 ${claims.length} 条显式主张；未用模型猜测未声明的论点。` : '没有读到 C1 / Claim 1 格式的显式主张。可在 logic/claims.md 声明，或在导入时填写待检查主张。', claims.length ? [...new Set(claims.map((claim) => claim.source))] : ['logic/claims.md']);
  if (!claims.length) addFinding('missing-claims', 'medium', '缺少可逐项核对的主张', '未找到显式主张段落。请逐条给出结论、适用条件、反驳条件与证据路径。', ['logic/claims.md']);

  const allRefs = textFiles.filter((file) => /\.(md|txt)$/i.test(file.path)).flatMap((file) => linkReferences(file.text).map((ref) => ({ source: file.path, ...resolveReference(ref, file.path, available) })));
  const brokenRefs = allRefs.filter((ref) => !ref.resolved && !ref.external);
  const claimGaps = claims.filter((claim) => !claim.resolvedEvidence.some((entry) => entry.startsWith('evidence/')));
  const linksStatus = brokenRefs.length ? 'fail' : !claims.length || claimGaps.length ? 'warn' : 'pass';
  addCheck('evidence-links', '主张与文件证据的连接', linksStatus, 20, brokenRefs.length ? `${brokenRefs.length} 处本地引用缺失或路径不安全；文件名出现不代表证据存在。` : claimGaps.length || !claims.length ? '至少一条主张没有连接到 evidence/ 原始材料，或尚未声明主张。' : '所有已识别本地引用都能定位到归档文件，主张均连接到 evidence/；链接存在不代表证据充分。', [...new Set(allRefs.map((ref) => ref.source))]);
  for (const [index, ref] of brokenRefs.entries()) addFinding(`broken-reference-${index + 1}`, 'high', '证据引用不可访问', `${ref.source} 引用 ${ref.reference}：${ref.reason ?? '目标不存在'}。未把相似文件名、外链或越界路径当作已交付证据。`, [ref.source, ...(ref.path ? [ref.path] : [])]);
  for (const claim of claimGaps) addFinding(`claim-evidence-${claim.id}`, 'medium', `${claim.id} 缺少归档证据连接`, '主张没有指向可读取的 evidence/ 文件；源码和文字论述本身不能代替原始实验结果。', [claim.source], claim.id);

  const code = artifact.files.filter((file) => file.path.startsWith('src/') && /\.(py|js|mjs|r|jl|ipynb|c|cpp|rs|go)$/i.test(file.path));
  addCheck('code', '方法与实现材料', code.length ? 'pass' : 'warn', 10, code.length ? `发现 ${code.length} 份实现文件。本次只核对材料存在，未执行上传代码；理论或非计算研究可由专家判断适用性。` : '未发现 src/ 实现文件。若研究依赖计算实验，应补充实现；非计算研究需人工判断是否适用。', code.map((file) => file.path));
  if (!code.length) addFinding('missing-code', 'low', '缺少计算实现材料', '归档没有 src/ 下的代码。请确认研究是否依赖计算；若适用，补充版本化实现和运行入口。', ['src']);

  const environment = textFiles.filter((file) => /(?:environment|requirements|pyproject|package\.json|(?:^|\/)Dockerfile|conda|uv\.lock)/i.test(file.path));
  addCheck('environment', '环境与依赖说明', environment.length ? 'pass' : 'warn', 10, environment.length ? '发现环境或依赖说明；存在说明不代表依赖已安装、版本可重建或运行成功。' : '缺少环境或依赖说明，独立执行者难以重建运行条件。', environment.map((file) => file.path));
  if (!environment.length) addFinding('missing-environment', 'medium', '运行环境没有归档', '请提供运行时、依赖版本、命令和硬件要求；不得以“存在代码”替代环境验证。', ['src/environment.md']);

  const evidence = artifact.files.filter((file) => file.path.startsWith('evidence/') && file.bytes > 0);
  addCheck('evidence', '原始数据与结果', evidence.length ? 'pass' : 'warn', 15, evidence.length ? `发现 ${evidence.length} 份 evidence/ 文件；后续仍需核对其来源、完整性和是否支持主张。` : '没有 evidence/ 原始数据或结果文件，仅靠论文结论无法独立核对实验。', evidence.map((file) => file.path));
  if (!evidence.length) addFinding('missing-evidence', 'high', '原始结果未交付', '未发现 evidence/ 中的非空文件。请补充原始输出、数据或可独立检查的推导证据。', ['evidence']);

  const limitations = textFiles.filter((file) => /(?:limitations?|局限|适用范围|限制|约束|falsification|可证伪)/i.test(file.text));
  addCheck('limitations', '适用范围与局限', limitations.length ? 'pass' : 'warn', 10, limitations.length ? '找到局限、适用范围或可证伪条件的文字；这里只定位说明，不能保证内容完整。' : '尚未发现局限或适用条件说明，容易将局部结果扩展到未验证范围。', limitations.map((file) => file.path));
  if (!limitations.length) addFinding('missing-limitations', 'medium', '适用范围与限制未说明', '请明确数据覆盖范围、未验证情形和可能改变结论的条件。', primary.map((file) => file.path));

  const references = textFiles.filter((file) => /(?:^|\n)#{1,4}\s*(?:References|Bibliography|参考文献)|(?:https?:\/\/doi\.org\/|\bdoi\s*:)|@(?:article|inproceedings)\s*\{/i.test(file.text));
  addCheck('references', '文献引用可定位', references.length ? 'warn' : 'warn', 5, references.length ? '定位到参考文献或 DOI 文本；此离线检查未访问文献，不声称验证出版信息或引用是否支持观点。' : '未识别到参考文献节或 DOI。需要人工核对来源及引用对应关系；内部附件链接不等于学术引用。', references.map((file) => file.path));
  addFinding(references.length ? 'unverified-references' : 'missing-references', 'low', references.length ? '外部文献尚未核验' : '未定位到学术参考文献', references.length ? '离线检查只读取参考文献文本；尚未验证文献是否存在、版本是否正确及是否支持所引用论点。' : '未识别到标准参考文献或 DOI；如论文依赖先前研究，应补充并核验引用。', references.length ? references.map((file) => file.path) : primary.map((file) => file.path));

  let comparisons = 0;
  let contradictions = 0;
  const comparisonPaths = [];
  for (const claim of claims) {
    const expectedMatch = claim.statement.match(/(?:accuracy|准确率)\s*(?:=|为|是|[:：])?\s*(\d+(?:\.\d+)?)\s*(%)?/i);
    const expected = expectedMatch ? Number(expectedMatch[1]) / (expectedMatch[2] ? 100 : 1) : null;
    if (expected == null || expected < 0 || expected > 1) continue;
    for (const evidencePath of claim.resolvedEvidence.filter((entry) => entry.startsWith('evidence/') && entry.endsWith('.json'))) {
      const evidenceFile = textFiles.find((file) => file.path === evidencePath);
      if (!evidenceFile) continue;
      let raw;
      try { raw = JSON.parse(evidenceFile.text); } catch { continue; }
      if (!Number.isFinite(raw.accuracy) || raw.accuracy < 0 || raw.accuracy > 1) continue;
      comparisons++;
      comparisonPaths.push(claim.source, evidencePath);
      if (Math.abs(expected - raw.accuracy) > 1e-6) {
        contradictions++;
        addFinding(`metric-mismatch-${claim.id}-${contradictions}`, 'high', `${claim.id} 的准确率主张与归档结果不一致`, `${claim.source} 声明 accuracy=${expected}（${Number((expected * 100).toFixed(4))}%）；${evidencePath} 的 $.accuracy=${raw.accuracy}（${Number((raw.accuracy * 100).toFixed(4))}%）${Number.isInteger(raw.correct) && Number.isInteger(raw.test_size) ? `，$.correct / $.test_size = ${raw.correct}/${raw.test_size}` : ''}。这是归档文字与数字的明确差异；本次未执行实验，不能据此单独判定论文被证伪。`, [claim.source, evidencePath], claim.id);
      }
      if (Array.isArray(raw.predictions) && raw.predictions.length && raw.predictions.every((item) => typeof item.actual === 'string' && typeof item.predicted === 'string')) {
        const correct = raw.predictions.filter((item) => item.actual === item.predicted).length;
        const recomputed = correct / raw.predictions.length;
        if (Math.abs(recomputed - raw.accuracy) > 1e-6) {
          contradictions++;
          addFinding(`raw-metric-mismatch-${claim.id}-${contradictions}`, 'high', '汇总指标与逐样本输出不一致', `${evidencePath} 逐样本 actual/predicted 重新计数为 ${correct}/${raw.predictions.length}=${recomputed}，$.accuracy 却为 ${raw.accuracy}。请核对汇总过程与原始输出。`, [evidencePath], claim.id);
        }
      }
    }
  }
  addCheck('consistency', '声明与结构化结果一致性', contradictions ? 'fail' : comparisons ? 'pass' : 'warn', 5, contradictions ? `发现 ${contradictions} 处可定位数值矛盾。` : comparisons ? `完成 ${comparisons} 次准确率声明与已链接 JSON 指标比较；未发现本规则能识别的冲突。` : '未找到可按本规则比较的明确准确率声明与已链接 JSON 结果；没有检测到冲突不等于主张真实。', comparisonPaths);
  if (!comparisons) addFinding('uncheckable-metrics', 'medium', '尚不能自动比较核心结果', '本地规则只比较显式 accuracy/准确率声明与该主张链接的 JSON 指标。其他研究指标、数学证明、图表或因果主张需要专家进一步核对。', claims.map((claim) => claim.source));

  const score = { value: checks.reduce((sum, check) => sum + check.earned, 0), max: 100, label: '材料可检查度' };
  return {
    id: `assessment-${randomUUID()}`, artifactId: artifact.id, artifactHash: artifact.rootHash, createdAt,
    engine: 'local-evidence-checks', score,
    summary: `材料可检查度 ${score.value}/100；${findings.filter((finding) => finding.severity === 'high').length} 项需优先核对。分数衡量材料覆盖，不代表水文概率、诚信评价或科学真实性。`,
    checks, findings, claims,
    steps: [
      { id: 'inventory', title: '读取版本化材料', status: 'completed', detail: `读取 ${artifact.files.length} 个归档文件的清单与可用文本，绑定版本哈希 ${artifact.rootHash}。` },
      { id: 'claim-map', title: '追踪主张与证据', status: 'completed', detail: `解析 ${claims.length} 条显式主张，检查归档路径及越界引用。` },
      { id: 'material-checks', title: '检查实现与材料缺口', status: 'completed', detail: '核对正文、代码、环境、原始结果、限制与引用说明的可检查性。' },
      { id: 'comparison', title: '比较结构化结果', status: 'completed', detail: `执行 ${comparisons} 次声明与 JSON 指标比较；不执行上传代码。` },
    ],
    limitations: [
      '这是本地确定性规则检查，未接外部大模型、文献检索、查重或期刊数据库。',
      '材料齐全和高分均不证明研究真实、结论正确或不存在学术不端；本报告不是 ARA 官方 Seal。',
      '未运行上传代码；数值比较只覆盖可识别的明确准确率声明及关联 JSON，复杂论证需专家核对。',
      'PDF 文本提取可能丢失表格、公式、图像和版面信息，应结合原件人工检查。',
      '外部链接、文献内容与数据来源未联网验证；同机再次检查不代表外部机构认证。',
    ],
  };
}

/** Independently reread archived bytes and emit a reproducible evidence audit. */
export async function executeAudit({ task, artifact, actor, kind, submissionId = null, dataDir }) {
  if (!task || task.artifactId !== artifact?.id || task.artifactHash !== artifact.rootHash) throw new Error('核对任务与材料版本不匹配');
  if (!['execution', 'verification'].includes(kind)) throw new Error('核对类型无效');
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('运行数据目录必须为服务端绝对路径');
  if (typeof artifact.sourceDir !== 'string' || !path.isAbsolute(artifact.sourceDir)) throw new Error('材料缺少服务端归档目录');
  await checkedRoot(artifact.sourceDir);
  const inputHashes = {};
  const files = [];
  for (const file of artifact.files) {
    const bytes = await checkedRead(artifact.sourceDir, file.path);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error(`实际核对输入与归档哈希不匹配：${file.path}`);
    inputHashes[file.path] = sha(bytes);
    files.push(fileFromBytes(file.path, bytes, file.product));
  }
  if (rootHashFor(files) !== artifact.rootHash) throw new Error('实际核对输入的材料版本哈希不匹配');
  const createdAt = new Date().toISOString();
  const assessment = inspectResearch({ ...artifact, files }, { now: createdAt });
  const audit = auditContent(assessment);
  const id = randomUUID();
  await mkdir(dataDir, { recursive: true });
  await checkedRoot(dataDir);
  const runs = path.join(dataDir, 'runs');
  await mkdir(runs, { recursive: true });
  await checkedRoot(runs, dataDir);
  const runDir = path.join(runs, id);
  await mkdir(runDir);
  const run = { id, taskId: task.id, actor, artifactHash: artifact.rootHash, termsHash: task.termsHash,
    kind, submissionId, createdAt, environment: { platform: process.platform, node: process.version, engine: 'local-evidence-checks', executionMode: '同机重新读取归档并独立执行材料检查；不运行上传代码，不代表外部认证。' },
    command: 'local-evidence-checks: read archive → verify SHA-256 → inspect claims and evidence', status: 'succeeded', repeats: 1,
    metrics: null, repeatMetrics: [], audit, outputHash: sha(stable({ audit })), inputHashes, files: [], error: null };
  const outputs = [
    [`evidence/audits/${id}/assessment.json`, `${JSON.stringify(assessment, null, 2)}\n`],
    [`evidence/audits/${id}/input-hashes.json`, `${JSON.stringify(inputHashes, null, 2)}\n`],
    [`trace/audits/${id}/execution.json`, `${JSON.stringify({ runId: id, createdAt, taskId: task.id, actor, kind, submissionId, artifactHash: artifact.rootHash, termsHash: task.termsHash, command: run.command, environment: run.environment, outputHash: run.outputHash, fileCount: files.length, status: 'succeeded' }, null, 2)}\n`],
  ];
  for (const [filePath, text] of outputs) {
    const destination = targetPath(runDir, filePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text, { encoding: 'utf8', flag: 'wx' });
    run.files.push({ path: filePath, text, sha256: sha(Buffer.from(text, 'utf8')) });
  }
  return run;
}
