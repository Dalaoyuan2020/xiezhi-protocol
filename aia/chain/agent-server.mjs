// Historical Agent tools, separate from the account application on port 8890.
import { createServer } from 'node:http';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORK, CHAIN_ID, deployment } from './config.mjs';
import { publicAssets as STATIC, publicMime as TYPES, publicRedirect } from '../public-ui.mjs';

export const DEFAULT_PORT = 8892;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPO = path.dirname(path.resolve(ROOT));

function problem(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function textParam(value, name, max, required = false) {
  if (value == null) { if (required) problem(400, 'INVALID_INPUT', `缺少${name}。`); return null; }
  if (!value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) problem(400, 'INVALID_INPUT', `${name}为空、过长或含无效字符。`);
  return value.trim();
}
function author(value) {
  const result = textParam(value, 'OpenAlex 作者编号', 40);
  if (result && !/^A\d{6,20}$/.test(result)) problem(400, 'INVALID_INPUT', 'OpenAlex 作者编号应为 A 开头的数字编号。');
  return result;
}
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false; const chunks = [];
    const rejectOnce = error => { if (!settled) { settled = true; chunks.length = 0; reject(error); } };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return rejectOnce(Object.assign(new Error('请求内容超过大小上限。'), { status: 413, code: 'BODY_TOO_LARGE' }));
      chunks.push(chunk);
    });
    req.once('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.once('error', () => rejectOnce(Object.assign(new Error('无法读取请求内容。'), { status: 400, code: 'INVALID_BODY' })));
    req.once('aborted', () => rejectOnce(Object.assign(new Error('请求已取消。'), { status: 400, code: 'REQUEST_ABORTED' })));
  });
}
async function stream(res, job) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
  const emit = event => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  try { await job(emit); emit({ done: true }); }
  catch (e) { console.error('[agent]', e?.stack || e); emit({ error: 'Agent 处理失败，请稍后重试；未确认的操作不得视为已上链。', code: 'AGENT_EXECUTION_FAILED' }); }
  res.end();
}

/** Creates an unbound HTTP server. Injected jobs keep tests offline and key-free. */
export function createAgentServer(options = {}) {
  const anchoringEnabled = options.anchoringEnabled ?? (process.env.AIA_AGENT_ANCHOR_ENABLED === '1');
  const configuredOrigin = options.origin ?? process.env.AIA_AGENT_ORIGIN ?? null;
  if (configuredOrigin && !/^https?:\/\/[^/]+$/.test(configuredOrigin)) throw new Error('AIA_AGENT_ORIGIN 必须是无路径的 http(s) 站点来源。');
  const run = options.run || (async (...args) => (await import('./agent.mjs')).run(...args));
  const claim = options.claim || (async (...args) => (await import('./agent.mjs')).claim(...args));
  const sendCode = options.sendCode || (async (...args) => (await import('./agent.mjs')).sendCode(...args));
  const stamp = options.stamp || (async (...args) => (await import('./agent.mjs')).stamp(...args));
  // Never read a key for a static request, health check or read-only Agent job.
  const getPrivateKey = options.getPrivateKey || (() => process.env.BOT_PRIVATE_KEY || null);
  const getDeployment = options.getDeployment || deployment;
  function expectedOrigin(req) {
    const host = req.headers.host || '';
    if (configuredOrigin) {
      if (host !== new URL(configuredOrigin).host) problem(403, 'INVALID_HOST', '请求站点不匹配。');
      return configuredOrigin;
    }
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) problem(403, 'INVALID_HOST', '默认仅接受本机站点访问。');
    return `http://${host}`;
  }
  async function executionOptions(req, url, origin) {
    const values = url.searchParams.getAll('anchor');
    if (values.length > 1 || (values.length && !['0','1'].includes(values[0]))) problem(400, 'INVALID_ANCHOR', 'anchor 只能出现一次，取值为 0 或 1。');
    const anchor = values[0] === '1';
    if (anchor && req.method !== 'POST') problem(405, 'POST_REQUIRED', '上链操作只接受同源 POST，GET 不会读取钱包或广播交易。');
    if (req.method === 'POST' && req.headers.origin !== origin) problem(403, 'ORIGIN_REQUIRED', 'POST 必须带与当前服务匹配的 Origin。');
    if (!anchor) return { anchor: false, privateKey: null };
    if (!anchoringEnabled) problem(403, 'ANCHOR_DISABLED', '此服务的上链写入默认关闭；须由服务端显式启用。');
    if (!getDeployment()?.address) problem(503, 'ANCHOR_UNCONFIGURED', '当前网络未配置部署合约。');
    const privateKey = await getPrivateKey();
    if (!privateKey) problem(503, 'ANCHOR_UNCONFIGURED', '服务端未配置上链签名能力。');
    return { anchor: true, privateKey };
  }
  const server = createServer(async (req, res) => {
    try {
      const origin = expectedOrigin(req);
      let decoded;
      try { decoded = decodeURIComponent(req.url.split(/[?#]/)[0]); }
      catch { problem(400, 'INVALID_PATH', '路径编码不正确。'); }
      if (decoded.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded)) problem(404, 'NOT_FOUND', '资源不存在。');
      const url = new URL(req.url, origin);
      if (url.pathname === '/api/health') {
        if (req.method !== 'GET') problem(405, 'METHOD_NOT_ALLOWED', '健康检查只支持 GET。');
        return json(res, 200, { network: NETWORK, chainId: Number(CHAIN_ID), contract: getDeployment()?.address || null, wallet: null, balance: null, anchoringEnabled, service: 'legacy-agent' });
      }
      if (url.pathname === '/api/run') {
        if (!['GET','POST'].includes(req.method)) problem(405, 'METHOD_NOT_ALLOWED', '查询使用 GET；显式上链仅使用 POST。');
        const query = textParam(url.searchParams.get('q'), '查询内容', 200, true);
        const pick = author(url.searchParams.get('pick'));
        const opts = await executionOptions(req, url, origin);
        if (req.method === 'POST') await readBody(req, 65536);
        return stream(res, emit => run(query, emit, { ...opts, pick, query }));
      }
      if (url.pathname === '/api/stamp') {
        if (req.method !== 'POST') problem(405, 'POST_REQUIRED', '稿件预检只接受 POST。');
        const authorId = author(url.searchParams.get('author'));
        const filename = textParam(url.searchParams.get('name') || 'manuscript', '文件名', 255);
        const opts = await executionOptions(req, url, origin);
        const bytes = await readBody(req);
        if (!bytes.length) problem(400, 'EMPTY_BODY', '稿件不能为空。');
        return stream(res, emit => stamp({ bytes, filename, authorId }, emit, opts));
      }
      if (url.pathname === '/api/verify/send') {
        if (req.method !== 'POST') problem(405, 'POST_REQUIRED', '发送验证码只接受 POST。');
        if (req.headers.origin !== origin) problem(403, 'ORIGIN_REQUIRED', 'POST 必须带与当前服务匹配的 Origin。');
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
        const authorId = author(body.author); if (!authorId) problem(400, 'INVALID_INPUT', '缺少 OpenAlex 作者编号。');
        const email = textParam(body.email, '邮箱', 254, true);
        return json(res, 200, await sendCode({ authorId, email }));
      }
      if (url.pathname === '/api/claim') {
        if (req.method !== 'POST') problem(405, 'POST_REQUIRED', '认领只接受 POST。');
        const authorId = author(url.searchParams.get('author'));
        if (!authorId) problem(400, 'INVALID_INPUT', '缺少 OpenAlex 作者编号。');
        const opts = await executionOptions(req, url, origin);
        const body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
        const orcid = body.orcid ? textParam(String(body.orcid), 'ORCID', 19) : null;
        if (orcid && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(orcid)) problem(400, 'INVALID_INPUT', 'ORCID 格式应为 0000-0000-0000-0000。');
        const email = body.email ? textParam(String(body.email), '邮箱', 254) : null;
        const code = body.code ? textParam(String(body.code), '验证码', 6) : null;
        const list = (v) => (Array.isArray(v) ? v.slice(0, 200).map((x) => String(x).slice(0, 400)) : []);
        const decisions = { claimed: list(body.claimed), rejected: list(body.rejected) };
        return stream(res, emit => claim({ authorId, orcid, email, code, decisions }, emit, opts));
      }
      if (url.pathname === '/api/cert/check') {
        // 复核：任何人拿凭证原文 → 重算指纹 → 和链上认领记录比对（只读，不需要私钥）
        if (req.method !== 'POST') problem(405, 'POST_REQUIRED', '复核只接受 POST。');
        if (req.headers.origin !== origin) problem(403, 'ORIGIN_REQUIRED', 'POST 必须带与当前服务匹配的 Origin。');
        const body = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
        const authorId = author(body.certificate?.profile);
        if (!authorId) problem(400, 'INVALID_INPUT', '凭证缺少档案编号。');
        const dep = getDeployment(); if (!dep?.address) problem(503, 'ANCHOR_UNCONFIGURED', '当前网络未配置部署合约。');
        const { ethers } = await import('ethers');
        const { artifact, RPC } = await import('./config.mjs');
        const { subjectOf, decodeAction } = await import('./lib.mjs');
        const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(body.certificate)));
        const reg = new ethers.Contract(dep.address, artifact().abi, new ethers.JsonRpcProvider(RPC));
        const records = (await reg.actionsOf(subjectOf(authorId))).map(decodeAction);
        const hit = records.find((r) => r.kind === 'CLAIM' && r.content === hash) || null;
        return json(res, 200, { network: NETWORK, chainId: Number(CHAIN_ID), contract: dep.address, hash, match: !!hit, record: hit,
          total: records.length, kinds: records.map((r) => r.kind) });
      }
      if (url.pathname.startsWith('/api/')) problem(404, 'NOT_FOUND', '接口不存在。');
      if (!['GET','HEAD'].includes(req.method)) problem(405, 'METHOD_NOT_ALLOWED', '静态资源只支持 GET 或 HEAD。');
      const redirect = publicRedirect(url);
      if (redirect) {
        res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const relative = STATIC.get(url.pathname);
      if (!relative) problem(404, 'NOT_FOUND', '资源不在公开清单中。');
      const absolute = path.join(REPO, ...relative.split('/'));
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || path.relative(await realpath(REPO), await realpath(absolute)).replaceAll(path.sep, '/') !== relative) problem(404, 'NOT_FOUND', '资源不在公开清单中。');
      let bytes = await readFile(absolute);
      if (path.extname(relative) === '.html') bytes = Buffer.from(bytes.toString('utf8').replace(/<a\s+href="\.\.\/product\/checkup\.py"[^>]*>[^<]*<\/a>/g, '<span>评分脚本保留在仓库源代码中</span>'));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(relative)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://rpc.botchain.ai https://rpc.bohr.life https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      json(res, status, { error: error.status ? error.message : status === 404 ? '资源不存在。' : '服务暂时无法处理请求。', code: error.status ? error.code : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 60000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AIA_AGENT_PORT || DEFAULT_PORT);
  const host = process.env.AIA_AGENT_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AIA_AGENT_PORT 必须为有效端口。');
  const server = createAgentServer();
  server.once('error', () => { console.error('Agent 服务监听失败，请检查端口和绑定地址。'); process.exitCode = 1; });
  const stop = () => server.close(error => { if (error) process.exitCode = 1; });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.listen(port, host, () => console.log(`历史 Agent 工具：http://${host}:${port}  网络 ${NETWORK}  上链写入${process.env.AIA_AGENT_ANCHOR_ENABLED === '1' ? '已显式启用' : '关闭'}`));
}
