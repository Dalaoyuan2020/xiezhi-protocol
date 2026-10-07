import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareImport, inspectResearch } from '@aia/research-core/research';
import { pdfToText } from '@aia/research-core/pdf';
import zipTools from '@aia/research-core/zip';

const PREFIX = '/paper-api';
const COOKIE = 'aia_paper_session';
const FILE_LIMIT = 12 * 1024 * 1024, TOTAL_LIMIT = 20 * 1024 * 1024;
const BODY_LIMIT = Math.ceil(FILE_LIMIT / 3) * 4 + 2048;
const TTL = 60 * 60 * 1000;
const PROTOCOL = 'https://github.com/ARA-Labs/Agent-Native-Research-Artifact#under-the-hood--the-artifact-anatomy';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const decoder = new TextDecoder('utf-8', { fatal: true });
function fail(status, message) { throw Object.assign(new Error(message), { status, paperSafe: true }); }
function send(res, status, data, download = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', ...(download ? { 'Content-Disposition': 'attachment; filename="paper-checkup-report.json"' } : {}) });
  res.end(JSON.stringify(data, null, download ? 2 : 0));
}
function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 400 || name !== name.normalize('NFC') || /[\\\x00-\x1f\x7f:*?"<>|]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail(400, '压缩包含有不安全或不支持的文件路径。');
  return name;
}

/** ZIP parsing is bounded and in memory. No archive path is extracted to disk. */
export function readPaperZip(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > FILE_LIMIT) fail(400, 'ZIP 文件无效或超过 12 MB。');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail(400, '不支持分卷或不完整的 ZIP。');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count !== bytes.readUInt16LE(end + 8) || count < 1 || count > 200 || start + size !== end || size === 0xffffffff || start === 0xffffffff) fail(400, 'ZIP 目录无效；不支持 ZIP64，最多 100 个文件。');
  const files = [], names = new Set(), ranges = []; let at = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail(400, 'ZIP 文件目录损坏。');
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20), expanded = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32);
    const mode = (bytes.readUInt32LE(at + 38) >>> 16) & 0xf000, offset = bytes.readUInt32LE(at + 42);
    if ((flags & ~0x80e) || (flags & 1) || ![0, 8].includes(method) || bytes.readUInt16LE(at + 34) || mode === 0xa000 || (mode && ![0x8000, 0x4000].includes(mode))) fail(400, 'ZIP 仅支持普通文件，不能包含加密文件、链接或特殊设备。');
    if (at + 46 + nameLength + extraLength + commentLength > end || expanded > FILE_LIMIT || compressed > FILE_LIMIT || total + expanded > TOTAL_LIMIT || (expanded > 1024 * 1024 && expanded > Math.max(compressed, 1) * 200)) fail(400, 'ZIP 解压后过大或压缩率异常：单文件最多 12 MB、总计 20 MB。');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength); let name;
    try { name = decoder.decode(nameBytes); } catch { fail(400, 'ZIP 文件名必须使用 UTF-8。'); }
    const directory = name.endsWith('/'); safePath(directory ? name.slice(0, -1) : name);
    if (names.has(name.toLowerCase())) fail(400, 'ZIP 存在重复文件名。'); names.add(name.toLowerCase());
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail(400, 'ZIP 文件头与目录不一致。');
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), dataAt = offset + 30 + localName + localExtra;
    if (dataAt + compressed > start || !bytes.subarray(offset + 30, offset + 30 + localName).equals(nameBytes)) fail(400, 'ZIP 文件数据范围无效。');
    if (ranges.some(([from, to]) => offset < to && dataAt + compressed > from)) fail(400, 'ZIP 内文件数据重叠。');
    ranges.push([offset, dataAt + compressed]);
    if (!(flags & 8) && (bytes.readUInt32LE(offset + 14) !== crc || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== expanded)) fail(400, 'ZIP 文件长度或校验信息不一致。');
    let decoded;
    try { decoded = method === 0 ? bytes.subarray(dataAt, dataAt + compressed) : inflateRawSync(bytes.subarray(dataAt, dataAt + compressed), { maxOutputLength: Math.max(1, Math.min(expanded, FILE_LIMIT)) }); }
    catch { fail(400, 'ZIP 内容无法解压或超出声明大小。'); }
    if (decoded.length !== expanded || zipTools.crc32(decoded) !== crc) fail(400, 'ZIP 文件校验失败，内容可能已损坏。');
    if (directory && expanded) fail(400, 'ZIP 目录不能带有文件内容。');
    if (!directory) { files.push({ path: name, base64: decoded.toString('base64') }); if (files.length > 100) fail(400, '最多上传 100 个文件。'); }
    total += expanded; at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== end || !files.length) fail(400, 'ZIP 中没有可检查的材料，或目录不完整。');
  return files;
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, '请使用 JSON 提交文件。');
  if (Number(req.headers['content-length']) > BODY_LIMIT) fail(413, '上传文件最大 12 MB。');
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > BODY_LIMIT) fail(413, '上传文件最大 12 MB。'); chunks.push(chunk); }
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, '上传请求不是有效的 JSON。'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, '上传请求无效。');
  return payload;
}

function structureOf(artifact) {
  const original = artifact.files.filter(file => artifact.originalPaths.includes(file.path) && file.bytes > 0);
  const item = (id, label, target, match, detail) => ({ id, label, target, status: original.some(match) ? 'pass' : 'missing', detail, paths: original.filter(match).map(file => file.path) });
  return [
    item('manifest', '根清单', 'PAPER.md', file => file.path === 'PAPER.md', '由原始上传材料提供的根清单；服务生成的导航文件不计入。'),
    item('claims', '研究主张', 'logic/claims.md', file => file.path === 'logic/claims.md', '逐条声明结论、适用条件及证据位置。'),
    item('experiments', '实验计划', 'logic/experiments.md', file => file.path === 'logic/experiments.md', '说明要怎样检验主张。'),
    item('source', '方法与环境', 'src/', file => file.path.startsWith('src/'), '记录实现、依赖与运行条件；文件存在不表示可以成功复现。'),
    item('trace', '探索过程', 'trace/', file => file.path.startsWith('trace/'), '保留探索、失败分支及选择理由。'),
    item('evidence', '原始结果', 'evidence/', file => file.path.startsWith('evidence/'), '主张应连接到可检查的原始结果。'),
  ];
}

// The shared inspector resolves links pairwise. Bound this input before calling it
// so an anonymous upload cannot monopolize the server with millions of references.
function textBudget() {
  let openings = 0, ticks = 0, claims = 0;
  return text => {
    if (text.length > 1000000) fail(400, '单份可检查正文超过 100 万字符，请拆分研究材料后上传。');
    openings += (text.match(/\[/g) || []).length;
    ticks += (text.match(/`/g) || []).length;
    claims += (text.match(/^#{1,4}\s+(?:C\d+|Claim\s*\d+|主张\s*\d+)\b/gim) || []).length;
    if (openings > 1000 || ticks > 4000 || claims > 200) fail(400, '材料的引用或主张过多，请拆分为较小的研究包再检查（最多 200 条主张）。');
    return text;
  };
}

/** Anonymous private reports: session isolated, one-hour memory retention, no public file links. */
export async function createPaperCheckup({ dataDir, requestOrigin, secureCookies = false, pdfParser = pdfToText, now = Date.now, limits = {} } = {}) {
  if (!path.isAbsolute(dataDir || '') || typeof requestOrigin !== 'function') throw new Error('Paper checkup requires a private dataDir and origin validator.');
  const bounds = { concurrent: 2, perMinute: 6, sessions: 100, reportsPerSession: 3, reportBytes: 256 * 1024, ttl: TTL, ...limits };
  const tempRoot = path.join(dataDir, 'paper-checkup-tmp');
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(tempRoot)).isSymbolicLink()) throw new Error('Paper temporary directory cannot be a link.');
  const samples = Object.fromEntries(await Promise.all(['complete', 'incomplete'].map(async key => [key, JSON.parse(await readFile(new URL(`../../paper-checkup/fixtures/${key}.json`, import.meta.url), 'utf8'))])));
  const sampleArchives = Object.fromEntries(Object.entries(samples).map(([key, sample]) => [key, Buffer.from(zipTools.zip(sample.files.map(file => ({ name: file.path, text: file.text }))))]));
  const sessions = new Map(), attempts = new Map(), pending = new Set(); let active = 0, closed = false;
  function sweep() {
    for (const [id, session] of sessions) {
      if (session.expires <= now() && !session.active) sessions.delete(id);
      else for (const [reportId, report] of session.reports) if (report.expiry <= now()) session.reports.delete(reportId);
    }
    for (const [address, entry] of attempts) if (now() - entry.at > 60000) attempts.delete(address);
  }
  async function cleanAbandoned() {
    for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^scan-[A-Za-z0-9]{6,}$/.test(entry.name)) continue;
      const directory = path.join(tempRoot, entry.name);
      if (now() - (await lstat(directory)).mtimeMs > TTL) await rm(directory, { recursive: true, force: true });
    }
  }
  await cleanAbandoned();
  const timer = setInterval(() => { sweep(); cleanAbandoned().catch(() => {}); }, 60000); timer.unref();
  function getSession(req) {
    const token = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = token && sessions.get(token);
    return session && session.expires > now() ? session : null;
  }
  function rate(req, kind, max) {
    const key = `${kind}:${req.socket.remoteAddress || 'unknown'}`; let entry = attempts.get(key);
    if (!entry) { if (attempts.size >= 2000) fail(429, '当前请求较多，请稍后重试。'); attempts.set(key, entry = { at: now(), count: 0 }); }
    if (++entry.count > max) fail(429, '体检次数较多，请稍后再试。');
  }
  async function assess(payload, session) {
    let files, source;
    if (typeof payload.sample === 'string' && Object.hasOwn(samples, payload.sample) && !payload.file) {
      const sample = samples[payload.sample]; files = sample.files;
      source = { kind: 'synthetic-example', name: sample.name, simulated: true, bytes: sampleArchives[payload.sample].length, sha256: hash(sampleArchives[payload.sample]), hashScope: 'exact downloadable synthetic ZIP bytes', downloadUrl: `${PREFIX}/samples/${payload.sample}.zip` };
    } else {
      const file = payload.file;
      if (payload.sample || !file || typeof file.name !== 'string' || !/\.(pdf|md|txt|zip)$/i.test(file.name) || typeof file.base64 !== 'string' || !file.base64.length || file.base64.length > Math.ceil(FILE_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) fail(400, '请选择 PDF、Markdown、TXT 或 ARA ZIP 文件，最大 12 MB。');
      safePath(file.name); if (file.name.includes('/')) fail(400, '上传文件名不能带有目录。');
      const bytes = Buffer.from(file.base64, 'base64');
      if (!bytes.length || bytes.length > FILE_LIMIT || bytes.toString('base64') !== file.base64) fail(400, '文件编码无效或超过 12 MB。');
      files = /\.zip$/i.test(file.name) ? readPaperZip(bytes) : [{ path: file.name, base64: file.base64 }];
      source = { kind: /\.zip$/i.test(file.name) ? 'ara-zip' : /\.pdf$/i.test(file.name) ? 'pdf' : 'manuscript', name: file.name, simulated: false, bytes: bytes.length, sha256: hash(bytes), hashScope: 'exact uploaded file bytes' };
    }
    const checkText = textBudget();
    for (const file of files) if (/\.(md|txt)$/i.test(file.path)) checkText(typeof file.text === 'string' ? file.text : Buffer.from(file.base64, 'base64').toString('utf8'));
    const workDir = await mkdtemp(path.join(tempRoot, 'scan-'));
    try {
      let artifact;
      try { artifact = await prepareImport({ files }, { dataDir: workDir, pdfToText: async bytes => checkText(await pdfParser(bytes)) }); }
      catch (error) {
        if (error.code) throw error;
        fail(400, `材料无法读取：${error.message}`);
      }
      // Generated navigation is useful internally, but never improves the original ARA verdict.
      const generated = new Set(artifact.generatedPaths);
      const reviewed = { ...artifact, files: artifact.files.filter(file => !generated.has(file.path) || file.path.startsWith('_derived/')) };
      const assessment = inspectResearch(reviewed), structure = structureOf(artifact);
      const missing = structure.filter(item => item.status !== 'pass'), severe = assessment.findings.filter(item => item.severity === 'high');
      const reportId = randomBytes(18).toString('hex');
      const report = {
        schemaVersion: 1, id: reportId, title: artifact.title, createdAt: new Date(now()).toISOString(), expiresAt: new Date(Math.min(session.expires, now() + bounds.ttl)).toISOString(),
        source, artifactHash: artifact.rootHash, protocol: { label: 'ARA 结构与证据预检', reference: PROTOCOL, officialSeal: false, checkedAt: '2026-10-08' },
        verdict: missing.length ? 'missing-materials' : severe.length ? 'needs-review' : 'structure-present',
        headline: missing.length ? `还缺 ${missing.length} 类 ARA 材料` : severe.length ? '目录齐备，但证据仍需核查' : '核心目录齐备，可进入进一步核查',
        structure, score: assessment.score, checks: assessment.checks, findings: assessment.findings, claims: assessment.claims,
        originalFiles: artifact.files.filter(file => artifact.originalPaths.includes(file.path)).map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
        generatedFiles: artifact.generatedPaths.map(filePath => ({ path: filePath, explanation: filePath.startsWith('_derived/') ? '从 PDF 提取的正文，可能丢失版式、公式与图像。' : '服务生成的导航清单，不属于原稿，不计入 ARA 结构覆盖。' })),
        steps: assessment.steps, limitations: assessment.limitations,
        privacy: '原始材料在本次检查结束后删除；报告只对当前浏览器会话可见，最多保留 1 小时，每个会话保留最近 3 份，重启服务后失效。报告包含标题、主张与文件信息，请自行保管下载副本。',
      };
      if (Buffer.byteLength(JSON.stringify(report)) > bounds.reportBytes) fail(400, '材料产生的检查报告过大，请拆分成较小的研究包再试。');
      while (session.reports.size >= bounds.reportsPerSession) session.reports.delete(session.reports.keys().next().value);
      session.reports.set(reportId, { value: report, expiry: now() + bounds.ttl });
      return report;
    } finally {
      // workDir is created by mkdtemp directly under our private fixed root, never supplied by a client.
      if (path.dirname(workDir) === tempRoot) await rm(workDir, { recursive: true, force: true });
    }
  }
  async function route(req, res, url) {
    if (closed) fail(503, '论文体检正在重启，请稍后重试。');
    const origin = requestOrigin(req); sweep();
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) fail(403, '请从本站论文体检页面进入。');
    if (req.method === 'GET' && url.pathname === `${PREFIX}/session`) {
      let session = getSession(req);
      if (!session) {
        rate(req, 'session', 30);
        if (sessions.size >= bounds.sessions) fail(429, '体检会话较多，请稍后重试。');
        const token = randomBytes(32).toString('base64url');
        session = { csrf: randomBytes(32).toString('base64url'), expires: now() + bounds.ttl, reports: new Map(), active: false }; sessions.set(token, session);
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=${PREFIX}/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(bounds.ttl / 1000)}${secureCookies ? '; Secure' : ''}`);
      }
      return send(res, 200, { csrfToken: session.csrf, expiresAt: new Date(session.expires).toISOString(), maxBytes: FILE_LIMIT, samples: ['complete', 'incomplete'] });
    }
    const session = getSession(req); if (!session) fail(401, '论文体检会话已过期，请刷新页面后重新上传。');
    const sampleMatch = url.pathname.match(/^\/paper-api\/samples\/(complete|incomplete)\.zip$/);
    if (req.method === 'GET' && sampleMatch) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="synthetic-ara-${sampleMatch[1]}.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      return res.end(sampleArchives[sampleMatch[1]]);
    }
    if (req.method === 'POST' && url.pathname === `${PREFIX}/assess`) {
      if (req.headers.origin !== origin || !equal(req.headers['x-paper-csrf'], session.csrf)) fail(403, '请从当前论文体检页面提交。');
      rate(req, 'assess', bounds.perMinute);
      if (active >= bounds.concurrent || session.active) fail(429, '已有材料正在检查，请稍后再提交。');
      active++; session.active = true;
      try { return send(res, 200, await assess(await readBody(req), session)); }
      finally { active--; session.active = false; }
    }
    const match = url.pathname.match(/^\/paper-api\/reports\/([a-f0-9]{36})(\/download)?$/);
    if (req.method === 'GET' && match) {
      const report = session.reports.get(match[1]); if (!report || report.expiry <= now()) fail(404, '报告已过期或不属于当前浏览器会话。');
      return send(res, 200, report.value, Boolean(match[2]));
    }
    fail(404, '论文体检接口不存在。');
  }
  function handle(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return Promise.resolve(false);
    const task = (async () => {
      try { await route(req, res, url); }
      catch (error) { if (!res.headersSent && !res.destroyed) send(res, error.paperSafe ? error.status : 500, { error: error.paperSafe ? error.message : '本次体检未完成，请稍后重试。' }); }
      return true;
    })();
    pending.add(task); task.finally(() => pending.delete(task)); return task;
  }
  return { handle, close: async () => { closed = true; clearInterval(timer); await Promise.allSettled([...pending]); sessions.clear(); attempts.clear(); } };
}
