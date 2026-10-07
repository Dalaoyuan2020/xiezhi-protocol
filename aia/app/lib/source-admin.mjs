import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { LLM_DEFAULTS, validateModelBaseUrl } from './dual-review.mjs';

const PREFIX = '/admin/sources/api';
const COOKIE = 'aia_source_admin';
const SESSION_MS = 2 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY = 8192;
const CONTACT_FIELDS = new Set(['NCBI_EMAIL', 'UNPAYWALL_EMAIL', 'CROSSREF_MAILTO']);
const SMTP_LABELS = { SMTP_HOST: 'SMTP 服务器（例 smtp.example.org）', SMTP_PORT: 'SMTP 端口（465 或 587）', SMTP_FROM: '发件邮箱', SMTP_USER: 'SMTP 登录账号', SMTP_PASS: 'SMTP 密码或授权码', SMTP_SECURE: '直接 TLS：465 填 true，587 填 false' };
const PUBLIC_FIELDS = new Set([...CONTACT_FIELDS, 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_SECURE']);
const MODEL_FIELDS = new Set(['LLM_A_BASE_URL', 'LLM_A_MODEL', 'LLM_B_BASE_URL', 'LLM_B_MODEL']);
const source = (id, label, supported, envNames, description, docsUrl) => ({ id, label, supported, envNames, description, docsUrl });
export const SOURCE_ADMIN_PROVIDERS = Object.freeze([
  { ...source('smtp', '邮箱验证 · SMTP', true, Object.keys(SMTP_LABELS), '邮件基础服务（不是文献源）。用于认领材料的邮箱验证码；只有用户点击发送才寄信。邮箱验证只证明邮箱控制权。', 'https://nodemailer.com/smtp'), kind: 'mail' },
  ...['A', 'B'].map(slot => ({ ...source(`llm_${slot.toLowerCase()}`, `评审模型 ${slot}`, true,
    [`LLM_${slot}_BASE_URL`, `LLM_${slot}_API_KEY`, `LLM_${slot}_MODEL`],
    '双模型投稿前参考。可配置任意兼容 OpenAI Chat Completions 与 JSON 模式的公网 HTTPS 接口；保存不会发起付费请求。', LLM_DEFAULTS[slot].docsUrl), kind: 'model', slot })),
  source('sciverse', 'Sciverse', true, ['SCIVERSE_API_TOKEN'], '论文元数据、语义证据与授权原文。', 'https://sciverse.space/docs'),
  source('openalex', 'OpenAlex', true, ['OPENALEX_API_KEY'], '作者身份与开放学术元数据。', 'https://docs.openalex.org/'),
  source('semantic_scholar', 'Semantic Scholar', true, ['S2_API_KEY'], '论文、摘要与引用元数据。', 'https://api.semanticscholar.org/api-docs/'),
  source('crossref', 'Crossref', true, ['CROSSREF_MAILTO'], 'DOI 与出版元数据；邮箱用于接口联系。', 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/'),
  source('europe_pmc', 'Europe PMC', true, [], '生命科学开放文献元数据，无需密钥。', 'https://europepmc.org/RestfulWebService'),
  source('pubmed', 'PubMed', true, ['NCBI_API_KEY', 'NCBI_EMAIL'], '生物医学文献元数据。', 'https://www.ncbi.nlm.nih.gov/books/NBK25501/'),
  source('arxiv', 'arXiv', true, [], '预印本文献元数据，无需密钥。', 'https://info.arxiv.org/help/api/index.html'),
  source('datacite', 'DataCite', true, [], '数据集与科研成果 DOI 元数据，无需密钥。', 'https://support.datacite.org/docs/api'),
  source('core', 'CORE', false, ['CORE_API_KEY'], '预留开放文献数据源；保存配置不会启用未实现的接口。', 'https://core.ac.uk/services/api'),
  source('nasa_ads', 'NASA ADS', true, ['ADS_DEV_KEY'], '天文与物理学文献元数据，需配置 API 凭据。', 'https://ui.adsabs.harvard.edu/help/api/'),
  source('openaire', 'OpenAIRE', false, ['OPENAIRE_TOKEN'], '预留开放科研成果数据源。', 'https://graph.openaire.eu/develop/api.html'),
  source('unpaywall', 'Unpaywall', false, ['UNPAYWALL_EMAIL'], '预留 DOI 开放获取位置查询。', 'https://unpaywall.org/products/api'),
  source('springer', 'Springer Nature', false, ['SPRINGER_API_KEY'], '预留出版元数据接口，读取权限取决于账号。', 'https://dev.springernature.com/'),
  source('epo', 'EPO OPS', false, ['EPO_OPS_KEY', 'EPO_OPS_SECRET'], '预留专利接口。', 'https://developers.epo.org/'),
  source('lens', 'The Lens', false, ['LENS_API_TOKEN'], '预留学术与专利数据源。', 'https://docs.api.lens.org/'),
]);
const FIELDS = new Set(SOURCE_ADMIN_PROVIDERS.flatMap(provider => provider.envNames));
const IDS = new Set(SOURCE_ADMIN_PROVIDERS.map(provider => provider.id));
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));
const own = (value, key) => Object.hasOwn(value, key);
function fail(status, message) { const error = new Error(message); error.status = status; error.sourceAdminSafe = true; throw error; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function safeValue(value) { return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
async function readOptional(file) { try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function atomicWrite(file, contents) {
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  try { await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); await chmod(file, 0o600); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, '请以 JSON 格式提交。');
  if (Number(req.headers['content-length']) > MAX_BODY) fail(413, '提交内容过大。');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail(413, '提交内容过大。'); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, '提交内容不是有效的 JSON。'); }
  if (!object(value)) fail(400, '提交内容必须是对象。');
  return value;
}

/** Independent source administration: never accepts a normal app login as authority. */
export async function createSourceAdmin({ dataDir, env = process.env, secureCookies = false, requestOrigin, onChange, now = Date.now, providerDefinitions = SOURCE_ADMIN_PROVIDERS } = {}) {
  if (!dataDir || typeof requestOrigin !== 'function') throw new Error('Source admin requires a private data directory and requestOrigin validator.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(dataDir, 'source-config.enc');
  const keyFile = path.join(dataDir, 'source-config.key');
  const accessFile = path.join(dataDir, 'admin-access.txt');
  let key = await readOptional(keyFile);
  const encodedState = await readOptional(configFile);
  if (!key && encodedState) throw new Error('Source admin encryption key is missing; existing configuration was preserved.');
  if (!key) { key = randomBytes(32); await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 }); }
  if (key.length !== 32) throw new Error('Source admin encryption key is invalid.');
  await chmod(keyFile, 0o600);
  let state = { overrides: {}, disabled: [] };
  if (encodedState) {
    try {
      const envelope = JSON.parse(encodedState.toString('utf8'));
      if (envelope.v !== 1) throw new Error('version');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from('aia-source-config-v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      if (!object(state.overrides) || !Array.isArray(state.disabled) || state.disabled.some(id => !IDS.has(id)) || Object.entries(state.overrides).some(([name, value]) => !FIELDS.has(name) || !safeValue(value))) throw new Error('schema');
    } catch { throw new Error('Source admin configuration could not be decrypted; existing files were preserved.'); }
  }
  let adminToken = env.AIA_ADMIN_TOKEN;
  if (adminToken === undefined || adminToken === '') {
    const saved = await readOptional(accessFile);
    adminToken = saved?.toString('utf8').trim();
    if (!adminToken) { adminToken = randomBytes(32).toString('base64url'); await atomicWrite(accessFile, `${adminToken}\n`); }
    else await chmod(accessFile, 0o600);
  }
  if (!safeValue(adminToken) || adminToken.length < 24 || adminToken.length > 512) throw new Error('Administrator token must contain 24 to 512 characters without control characters.');
  const sessions = new Map(), attempts = new Map();
  let allAttempts = { at: now(), count: 0 }, closed = false, mutationQueue = Promise.resolve();
  const definitions = SOURCE_ADMIN_PROVIDERS.map(provider => ({ ...provider, supported: ['model', 'mail'].includes(provider.kind) || providerDefinitions.find(item => item.id === provider.id)?.supported === true }));
  function credentials() {
    const result = {};
    for (const provider of definitions) for (const name of provider.envNames) {
      const value = own(state.overrides, name) ? state.overrides[name] : env[name];
      result[name] = !state.disabled.includes(provider.id) && safeValue(value) ? (name === 'SMTP_PASS' ? value : value.trim()) : '';
    }
    return result;
  }
  function list() {
    return { sources: definitions.map(provider => ({ id: provider.id, label: provider.label, description: provider.description, docsUrl: provider.docsUrl, kind: provider.kind || 'literature',
      supported: provider.supported, status: provider.supported ? 'implemented' : 'planned', enabled: !state.disabled.includes(provider.id),
      fields: provider.envNames.map(name => {
        const disabled = state.disabled.includes(provider.id), saved = own(state.overrides, name), environment = safeValue(env[name]) && Boolean(env[name].trim());
        const editable = MODEL_FIELDS.has(name);
        const value = saved ? state.overrides[name] : environment ? env[name].trim() : '';
        return { name, label: SMTP_LABELS[name] || (name.endsWith('_BASE_URL') ? '接口地址 Base URL' : name.endsWith('_MODEL') ? '模型名称' : name), secret: !PUBLIC_FIELDS.has(name) && !editable, configured: !disabled && Boolean(value),
          origin: disabled ? 'disabled' : saved ? 'saved' : environment ? 'environment' : 'unset',
          ...(editable ? { value, suggestedValue: name.endsWith('_BASE_URL') ? LLM_DEFAULTS[provider.slot].baseUrl : LLM_DEFAULTS[provider.slot].model } : {}) };
      }) })) };
  }
  function session(req) {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
    const token = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return sessions.get(digest(token).toString('hex')) || null;
  }
  function cookie(res, token, age) { res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/admin/sources/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies ? '; Secure' : ''}`); }
  function origin(req) {
    if (typeof req.headers.origin !== 'string' || req.headers.origin !== requestOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') fail(403, '管理请求的来源不匹配。');
  }
  function limitLogin(req) {
    const time = now(), ip = req.socket.remoteAddress || 'unknown';
    for (const [id, attempt] of attempts) if (time - attempt.at >= WINDOW_MS) attempts.delete(id);
    if (time - allAttempts.at >= WINDOW_MS) allAttempts = { at: time, count: 0 };
    if (++allAttempts.count > 200 || (attempts.size >= 1000 && !attempts.has(ip))) fail(429, '登录尝试过多，请稍后重试。');
    const attempt = attempts.get(ip) || { at: time, count: 0 };
    attempts.set(ip, attempt);
    if (++attempt.count > 5) fail(429, '登录尝试过多，请 15 分钟后重试。');
  }
  async function persist(next) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('aia-source-config-v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    await atomicWrite(configFile, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    state = next;
    if (onChange) await onChange(credentials(), { disabledSources: [...state.disabled] });
  }
  function mutate(operation) { const next = mutationQueue.then(operation); mutationQueue = next.catch(() => {}); return next; }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      if (closed) fail(503, '管理服务已关闭。');
      requestOrigin(req);
      const route = url.pathname.slice(PREFIX.length), writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (writing) origin(req);
      if (route === '/session' && req.method === 'GET') {
        const current = session(req);
        send(res, 200, current ? { authenticated: true, csrfToken: current.csrfToken } : { authenticated: false }); return true;
      }
      if (route === '/login' && req.method === 'POST') {
        limitLogin(req);
        const body = await readJson(req);
        if (Object.keys(body).some(name => name !== 'token') || !safeValue(body.token) || body.token.length > 512 || !equal(body.token, adminToken)) fail(401, '管理口令不正确。');
        const previous = session(req); if (previous) sessions.delete(previous.id);
        while (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('hex'), id = digest(token).toString('hex'), csrfToken = randomBytes(32).toString('hex');
        sessions.set(id, { id, csrfToken, expires: now() + SESSION_MS }); cookie(res, token, SESSION_MS / 1000);
        send(res, 200, { authenticated: true, csrfToken }); return true;
      }
      const current = session(req); if (!current) fail(401, '请先登录数据源管理。');
      if (writing && !equal(req.headers['x-csrf-token'], current.csrfToken)) fail(403, '管理会话校验失败，请刷新页面。');
      if (route === '/logout' && req.method === 'POST') {
        sessions.delete(current.id); cookie(res, '', 0); send(res, 200, { authenticated: false }); return true;
      }
      if (route === '/sources' && req.method === 'GET') { send(res, 200, list()); return true; }
      const match = route.match(/^\/sources\/([a-z_]+)$/), provider = match && definitions.find(item => item.id === match[1]);
      if (!provider) fail(404, '管理接口不存在。');
      if (!['PUT', 'DELETE'].includes(req.method)) fail(405, '不支持该请求方法。');
      const body = await readJson(req);
      if (req.method === 'PUT') {
        if (Object.keys(body).some(name => !['values', 'enabled'].includes(name)) || !object(body.values) || (own(body, 'enabled') && typeof body.enabled !== 'boolean')) fail(400, '请提交允许的配置字段。');
        const values = {};
        for (const [name, raw] of Object.entries(body.values)) {
          if (!provider.envNames.includes(name) || !safeValue(raw)) fail(400, '配置字段或内容无效。');
          const value = name === 'SMTP_PASS' ? raw : raw.trim(); if (!value) continue;
          if (CONTACT_FIELDS.has(name) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(400, '联系邮箱格式无效。');
          if (name === 'SMTP_FROM' && !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value)) fail(400, '发件邮箱格式无效，请只填写邮箱地址。');
          if (name === 'SMTP_HOST' && !/^[a-zA-Z0-9.-]{1,253}$/.test(value)) fail(400, 'SMTP 服务器应填写域名，不含协议或路径。');
          if (name === 'SMTP_PORT' && (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)) fail(400, 'SMTP 端口必须是 1 到 65535 的整数。');
          if (name === 'SMTP_SECURE' && !['true', 'false'].includes(value)) fail(400, 'SMTP_SECURE 请填写 true 或 false。');
          if (name.endsWith('_BASE_URL')) {
            try { values[name] = validateModelBaseUrl(value); } catch { fail(400, '模型接口必须为公网 HTTPS 443 地址，不能含账户、查询参数或本机地址。'); }
          } else if (MODEL_FIELDS.has(name)) {
            if (!/^[\w./:-]{1,160}$/.test(value)) fail(400, '模型名称须为 1–160 个字母、数字或 . _ / : - 字符。');
            values[name] = value;
          } else {
            if (!CONTACT_FIELDS.has(name) && !['SMTP_PASS', 'SMTP_USER'].includes(name) && /\s/.test(value)) fail(400, '密钥不能包含空白字符。');
            values[name] = value;
          }
        }
        if (Object.keys(values).length || own(body, 'enabled')) await mutate(() => {
          const disabled = state.disabled.filter(id => id !== provider.id);
          if (body.enabled === false) disabled.push(provider.id);
          return persist({ overrides: { ...state.overrides, ...values }, disabled });
        });
      } else {
        if (Object.keys(body).some(name => name !== 'mode') || !['clear', 'disable'].includes(body.mode)) fail(400, '请选择恢复默认或停用。');
        await mutate(() => {
          const overrides = { ...state.overrides };
          if (body.mode === 'clear') for (const name of provider.envNames) delete overrides[name];
          const disabled = state.disabled.filter(id => id !== provider.id);
          if (body.mode === 'disable') disabled.push(provider.id);
          return persist({ overrides, disabled });
        });
      }
      send(res, 200, list());
    } catch (error) {
      const known = error.sourceAdminSafe && [400, 401, 403, 404, 405, 413, 415, 429, 503].includes(error.status);
      // Do not serialize upstream, filesystem or callback errors: these may contain credentials.
      send(res, known ? error.status : 500, { error: known ? error.message : '数据源配置暂时无法处理，请在服务器上检查服务状态。' });
    }
    return true;
  }
  return { handle, credentials, disabledSources: () => [...state.disabled], close: async () => { closed = true; await mutationQueue; sessions.clear(); attempts.clear(); } };
}
