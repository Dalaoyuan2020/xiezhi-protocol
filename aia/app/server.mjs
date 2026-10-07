import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { openStore, fail, field, digest, id } from './lib/store.mjs';
import { createAuth } from './lib/auth.mjs';
import { createResearchService } from './lib/research-service.mjs';
import { createWorkflow } from './lib/workflow.mjs';
import { createScholarLookup, normalizeInstitutionQuery } from './lib/scholars.mjs';
import { createLiterature, PROVIDERS } from './lib/literature.mjs';
import { createSourceAdmin, SOURCE_ADMIN_PROVIDERS } from './lib/source-admin.mjs';
import { createAgentGrants, AGENT_SCOPES } from './lib/agent-grants.mjs';
import { createCommunity } from './lib/community.mjs';
import { createCommunityAct } from './lib/community-act.mjs';
import { createDualReview } from './lib/dual-review.mjs';
import { createPublicAgentRunner } from './lib/public-agent.mjs';
import { createClaimFlow } from './lib/claim-flow.mjs';
import { createPaperCheckup } from './lib/paper-checkup.mjs';
import { publicAssets, publicMime, publicRedirect } from '../public-ui.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(ROOT));
const capabilities = Object.freeze({ authentication: 'session', persistence: 'sqlite', researchImport: true, pdfImport: true, assessmentEngine: 'local-evidence-checks', uploadedCodeExecution: false, externalLLM: 'configurable-dual-review', community: true, agentDelegation: true, payments: false, contributions: 'accepted-work-records', walletLinking: true, chainAttestations: true });
const parse = row => row ? JSON.parse(row.data) : null;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 65536) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, '请使用 JSON 提交。');
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > limit) fail(413, '请求内容过大。'); chunks.push(chunk); }
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
  catch { fail(400, '请求必须为有效 JSON 对象。'); }
}
function download(res, { file, bytes }, raw) {
  if (!raw) return json(res, 200, { path: file.path, sha256: file.sha256, mimeType: file.mimeType, binary: Boolean(file.binary), ...(file.binary ? { bytes: file.bytes } : { text: bytes.toString('utf8') }) });
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="research-file"; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file.path))}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.AIA_APP_DATA_DIR || path.join(ROOT, '.runtime'));
  const configuredOrigin = options.origin || process.env.AIA_ORIGIN || null;
  if (configuredOrigin && !/^https?:\/\/[^/]+$/.test(configuredOrigin)) throw new Error('AIA_ORIGIN 必须是 http(s) 站点来源，不含路径。');
  const store = openStore(dataDir);
  const auth = createAuth(store, { secureCookies: configuredOrigin?.startsWith('https://') || false });
  const research = createResearchService(store, auth, { dataDir, ...(options.pdfParser ? { pdfParser: options.pdfParser } : {}) });
  const workflow = createWorkflow(store, auth, research, { dataDir });
  const sourceAdmin = await createSourceAdmin({ ...options.sourceAdminOptions, dataDir, requestOrigin, providerDefinitions: [...PROVIDERS, ...SOURCE_ADMIN_PROVIDERS.filter(item => ['llm_a', 'llm_b'].includes(item.id))], secureCookies: configuredOrigin?.startsWith('https://') || false });
  const credentials = () => sourceAdmin.credentials();
  const act = createCommunityAct(store, auth, research, workflow, options.communityActOptions);
  const dual = createDualReview({ credentials, ...options.dualReviewOptions });
  const community = createCommunity(store, auth, research, workflow, act, options.dualReview || dual, options.communityOptions);
  const grants = createAgentGrants(store, auth, options.agentGrantOptions);
  const claimFlow = await createClaimFlow({ dataDir, credentials, requestOrigin, secureCookies: Boolean(configuredOrigin?.startsWith('https://')), ...options.claimFlowOptions });
  const paperCheckup = await createPaperCheckup({ dataDir, requestOrigin, secureCookies: Boolean(configuredOrigin?.startsWith('https://')), ...(options.pdfParser ? { pdfParser: options.pdfParser } : {}), ...options.paperCheckupOptions });
  let scholarKey, managedScholars;
  function scholarService() {
    if (sourceAdmin.disabledSources().includes('openalex')) fail(503, '学者查询数据源暂未启用。');
    const key = credentials().OPENALEX_API_KEY || '';
    if (!managedScholars || scholarKey !== key) { managedScholars = createScholarLookup({ apiKey: key }); scholarKey = key; }
    return managedScholars;
  }
  const scholars = options.scholars || { search: (...args) => scholarService().search(...args), author: (...args) => scholarService().author(...args) };
  const literature = options.literature || createLiterature({ credentials, disabledSources: () => sourceAdmin.disabledSources() });
  const literatureAttempts = new Map();
  const literatureLimits = { perMinute: 30, concurrent: 3, ...options.literatureLimits };
  let activeLiterature = 0;
  async function publicLiteratureRoute(req, res, url) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); fail(405, '公开文献查询只支持 GET。'); }
    if (url.pathname === '/scholar-api/literature/health') return json(res, 200, literature.health());
    const action = url.pathname.slice('/scholar-api/literature/'.length);
    if (!['search', 'content', 'resource', 'catalog'].includes(action)) fail(404, '公开文献接口不存在。');
    const now = Date.now(), address = req.socket.remoteAddress || 'unknown';
    for (const [key, entry] of literatureAttempts) if (now - entry.at >= 60000) literatureAttempts.delete(key);
    let entry = literatureAttempts.get(address);
    if (!entry) {
      if (literatureAttempts.size >= 2000) fail(429, '文献查询繁忙，请稍后重试。');
      literatureAttempts.set(address, entry = { at: now, count: 0 });
    }
    if (++entry.count > literatureLimits.perMinute || activeLiterature >= literatureLimits.concurrent) fail(429, '文献查询频率受限，请稍后重试。');
    activeLiterature++;
    try {
      if (action === 'search') return json(res, 200, await literature.search({ q: url.searchParams.get('q') || '', author: url.searchParams.get('author') || '', mode: url.searchParams.get('mode') || 'metadata', page: url.searchParams.get('page') || 1, source: url.searchParams.get('source') || 'all', discipline: url.searchParams.get('discipline') || 'general' }));
      if (action === 'content') return json(res, 200, await literature.content({ doc: url.searchParams.get('doc'), offset: url.searchParams.get('offset') || 0 }));
      if (action === 'catalog') return json(res, 200, await literature.catalog());
      const { bytes, mimeType } = await literature.resource(url.searchParams.get('file'));
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      return res.end(bytes);
    } catch (error) {
      // Never relay an upstream URL, response body, or credential to a public client.
      const status = [400, 403, 404, 429, 502, 503].includes(error?.status) ? error.status : 503;
      const messages = { 400: '查询参数无效，请检查检索内容、模式和页码。', 403: '此材料尚不可读，请先检索并选择有权读取的文献。', 404: '没有找到这份文献材料。', 429: '文献数据源查询频率受限，请稍后重试。', 502: '文献数据源返回异常，请稍后重试。', 503: '文献来源暂时不可用，请稍后重试或选择其他来源。' };
      const sourceStatus = Array.isArray(error?.sourceStatus) ? error.sourceStatus.slice(0, 20).map(item => ({ id: /^[a-z_]+$/.test(item.id || '') ? item.id : 'unknown', label: String(item.label || '').slice(0, 100), status: ['error', 'disabled', 'unsupported', 'unconfigured', 'skipped'].includes(item.status) ? item.status : 'error', count: 0 })) : undefined;
      return json(res, status, { error: messages[status], ...(sourceStatus ? { sourceStatus } : {}) });
    } finally { activeLiterature--; }
  }
  const scholarAttempts = new Map();
  const scholarLimits = { search: 30, run: 4, concurrentSearches: 4, concurrentRuns: 2, ...options.scholarLimits };
  let activeSearches = 0, activeRuns = 0;
  const agentRun = options.agentRun || createPublicAgentRunner({ credentials: () => ({ OPENALEX_API_KEY: credentials().OPENALEX_API_KEY || '' }) });
  function scholarRateLimit(req, kind) {
    const now = Date.now();
    const key = `${kind}:${req.socket.remoteAddress || 'unknown'}`;
    for (const [address, entry] of scholarAttempts) if (now - entry.at >= 60000) scholarAttempts.delete(address);
    let entry = scholarAttempts.get(key);
    if (!entry) {
      if (scholarAttempts.size >= 2000) fail(429, '实时查询繁忙，请稍后再试。');
      scholarAttempts.set(key, entry = { at: now, count: 0 });
    }
    if (++entry.count > scholarLimits[kind]) fail(429, '实时查询次数过多，请一分钟后重试。');
  }
  function scholarQuery(url) {
    const query = (url.searchParams.get('q') || '').normalize('NFKC').trim();
    if (query.length < 2 || query.length > 160 || /[\u0000-\u001f\u007f]/.test(query)) fail(400, '请输入 2–160 个字符的姓名、ORCID 或 OpenAlex 作者编号。');
    return query;
  }
  function publicScholarError(error) {
    const status = [400, 404, 429, 502, 503].includes(error?.status) ? error.status : 503;
    const messages = { 400: '查询格式有误，请核对姓名、ORCID 或 OpenAlex 作者编号。', 404: '未找到这个公开学术档案。', 429: '公开数据源查询频率受限，请稍后重试。', 502: '公开数据源返回异常，请稍后重试。', 503: '暂时无法完成实时查询，请稍后重试。' };
    return { status, message: messages[status] };
  }
  // Public searches never obtain a session, wallet, or write-capable Agent options.
  async function publicScholarRoute(req, res, url) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); fail(405, '公开学术查询只支持 GET。'); }
    if (url.pathname === '/scholar-api/health') return json(res, 200, { ok: true, source: 'openalex', search: !sourceAdmin.disabledSources().includes('openalex'), assessment: !sourceAdmin.disabledSources().includes('openalex'),
      mode: 'read-only', anchoringEnabled: false, apiKeyConfigured: Boolean(credentials().OPENALEX_API_KEY), assessmentCacheTtlHours: 24 });
    if (!['/scholar-api/search', '/scholar-api/run'].includes(url.pathname)) fail(404, '公开学术接口不存在。');
    const query = scholarQuery(url);
    if (url.pathname === '/scholar-api/search') {
      const institution = normalizeInstitutionQuery(url.searchParams.get('institution') || '');
      scholarRateLimit(req, 'search');
      if (activeSearches >= scholarLimits.concurrentSearches) fail(429, '实时查询繁忙，请稍后再试。');
      activeSearches++;
      try { return json(res, 200, await scholars.search(query, { institution })); }
      catch (error) {
        const failure = publicScholarError(error);
        const unavailable = error?.institution?.status === 'unavailable';
        return json(res, failure.status, { error: unavailable ? '暂时无法识别学术单位，请重试，或清除单位条件继续按姓名查找。' : failure.message,
          ...(unavailable ? { institution: { query: institution, status: 'unavailable', matches: [], applied: false } } : {}) });
      }
      finally { activeSearches--; }
    }
    const pick = url.searchParams.get('pick') || undefined;
    if (sourceAdmin.disabledSources().includes('openalex')) fail(503, '学者查询数据源暂未启用。');
    if (pick && !/^A\d{1,20}$/.test(pick)) fail(400, '请选择有效的 OpenAlex 作者编号。');
    scholarRateLimit(req, 'run');
    if (activeRuns >= scholarLimits.concurrentRuns) fail(429, '当前核验任务较多，请稍后再试。');
    activeRuns++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let closed = false, timeout, heartbeat;
    const controller = new AbortController();
    // SMTP flags/ports and model names are configuration, not credentials.
    // Redact string values before JSON encoding so booleans, numbers and escape
    // sequences cannot be replaced with invalid unquoted JSON fragments.
    const secrets = [...new Set([
      ...Object.entries(credentials()).filter(([name]) => /(?:_KEY|_TOKEN|_SECRET|_PASS|_PASSWORD)$/.test(name)).map(([, value]) => value),
      process.env.PRIVATE_KEY, process.env.BOTCHAIN_PRIVATE_KEY, process.env.AIA_ADMIN_TOKEN,
    ].filter(value => typeof value === 'string' && value.length))].sort((a, b) => b.length - a.length);
    const send = event => {
      if (closed || res.destroyed) return;
      const serialized = JSON.stringify(event, (_name, value) => {
        if (typeof value !== 'string') return value;
        for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
        return value;
      });
      res.write(`data: ${serialized}\n\n`);
    };
    const finish = () => { clearTimeout(timeout); clearInterval(heartbeat); if (!closed) { send({ done: true }); closed = true; res.end(); } };
    res.once('close', () => { closed = true; clearTimeout(timeout); clearInterval(heartbeat); controller.abort(); });
    heartbeat = setInterval(() => { if (!closed && !res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
    heartbeat.unref();
    timeout = setTimeout(() => { send({ error: '实时核验超时，请稍后重试；未发起链上写入。' }); finish(); controller.abort(); }, options.agentTimeoutMs || 180000);
    timeout.unref();
    try {
      await agentRun(query, event => {
        if (closed || res.destroyed) throw new Error('Public reader disconnected');
        send(event?.step === 7 && !event.chain ? { ...event, title: '实时核验完成 · 未发起链上写入' } : event);
      }, { anchor: false, privateKey: null, ...(pick ? { pick, query } : {}) }, { signal: controller.signal, timeoutMs: options.agentTimeoutMs || 180000 });
    } catch { send({ error: '实时核验未完成，公开数据源可能暂时不可用。请稍后重试；未发起链上写入。' }); }
    finally {
      // The default runner resolves only after worker termination. Injected
      // non-cancellable runners likewise retain their slot until they settle.
      activeRuns--;
      finish();
    }
  }
  let chainModule = options.chain;
  const chain = async () => chainModule ||= await import('./lib/chain.mjs');
  const authAttempts = new Map();
  function rateLimit(req) {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = authAttempts.get(key);
    if (!entry || now - entry.at > 60000) authAttempts.set(key, { at: now, count: 1 });
    else if (++entry.count > 30) fail(429, '登录或注册尝试过多，请一分钟后重试。');
    if (authAttempts.size > 1000) for (const [k, v] of authAttempts) if (now - v.at > 60000) authAttempts.delete(k);
  }
  function requestOrigin(req) {
    const host = req.headers.host || '';
    if (configuredOrigin) { if (host !== new URL(configuredOrigin).host) fail(403, '请求站点不匹配。'); return configuredOrigin; }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) fail(403, '请通过本机地址访问；公网部署需配置 AIA_ORIGIN。');
    return `http://${host}`;
  }
  function overview(user) {
    const ideas = research.list(user.id), reviews = workflow.reviews(user.id), tasks = workflow.tasks(user.id), contributions = workflow.contributions(user.id);
    return { user, counts: { ideas: ideas.filter(r => r.ownerId === user.id).length, reviewsPending: reviews.filter(r => r.reviewerId === user.id && r.status === 'requested').length,
      tasksOpen: tasks.filter(t => !['accepted','rejected'].includes(t.status)).length, contributions: contributions.filter(c => c.userId === user.id).length }, ideas, reviews, tasks, contributions, capabilities, modelConfiguration: community.reviewCredentials(), points: act.points(user.id), eligibility: community.eligibility(user.id) };
  }
  async function agentRoute(req, res, url) {
    const context = grants.authenticate(req), { user, actor } = context;
    const scope = name => grants.requireScope(context, name);
    const prefix = '/api/agent';
    if (req.method === 'GET' && url.pathname === `${prefix}/capabilities`) return json(res, 200, { agent: context.agent, actor, scopes: context.agent.scopes, expiresAt: context.agent.expiresAt, canReview: false, canVerify: false });
    if (req.method === 'GET' && url.pathname === `${prefix}/act-tasks`) { scope('act:answer'); return json(res, 200, act.snapshot(user.id)); }
    const ownResearch = rid => {
      const record = research.present(research.row(user.id, rid, true));
      if (record.createdBy?.agentId !== context.agent.id) fail(403, '这份研究不是本 Agent 授权提交的材料。');
      return record;
    };
    const researchPath = url.pathname.match(/^\/api\/agent\/research\/([^/]+)(?:\/(review))?$/);
    const microPath = url.pathname.match(/^\/api\/agent\/act-tasks\/([^/]+)\/answer$/);
    const taskPath = url.pathname.match(/^\/api\/agent\/tasks\/([^/]+)(?:\/(claim|deliver))?$/);
    const taskMaterial = url.pathname.match(/^\/api\/agent\/tasks\/([^/]+)\/(material|file)$/);
    if (req.method === 'GET' && taskMaterial) {
      scope('act:deliver');
      const task = workflow.detail(user.id, taskMaterial[1]).task;
      if (task.executorId !== user.id) fail(403, 'Agent 只能读取担保人执行任务所需的材料。');
      return download(res, await research.file(user.id, task.researchId, url.searchParams.get('path')), taskMaterial[2] === 'file');
    }
    if (req.method === 'GET' && researchPath && !researchPath[2]) { scope('research:import'); ownResearch(researchPath[1]); return json(res, 200, workflow.researchDetail(user.id, researchPath[1])); }
    if (req.method === 'GET' && taskPath && !taskPath[2]) {
      scope('act:deliver');
      const detail = workflow.detail(user.id, taskPath[1]);
      if (detail.task.executorId !== user.id) fail(403, 'Agent 仅可读取担保人负责执行的任务。');
      return json(res, 200, detail);
    }
    if (req.method !== 'POST') fail(405, '此 Agent 接口不支持该操作。');
    if (url.pathname === `${prefix}/research/import`) {
      scope('research:import');
      const payload = await body(req, 32 * 1024 * 1024);
      if (payload.previousVersionId) ownResearch(payload.previousVersionId);
      scope('research:import');
      return json(res, 200, await research.importResearch(user, payload, actor));
    }
    if (researchPath?.[2] === 'review') {
      scope('research:review'); ownResearch(researchPath[1]); await body(req);
      scope('research:review');
      return json(res, 200, await community.review(user.id, researchPath[1], actor));
    }
    if (microPath) { scope('act:answer'); const payload = await body(req); scope('act:answer'); return json(res, 200, act.answer(user.id, microPath[1], payload, actor)); }
    if (taskPath?.[2]) {
      scope('act:deliver');
      const payload = await body(req, taskPath[2] === 'deliver' ? 32 * 1024 * 1024 : 65536);
      scope('act:deliver');
      if (taskPath[2] === 'claim') return json(res, 200, workflow.claim(user.id, taskPath[1], actor));
      return json(res, 200, await workflow.deliver(user.id, taskPath[1], payload, actor));
    }
    fail(403, 'Agent 只能提交材料、发起模型检测、核对或交付任务；不能审稿、验收、签发授权或上链付款。');
  }
  function attestationSource(userId, recordType, recordId) {
    if (recordType === 'profile') {
      if (recordId !== userId) fail(403, '只能登记本账号的个人档案声明。');
      const user = auth.userById(userId);
      if (!user.profile.orcid && !user.profile.openalexId) fail(409, '请先填写自己的 ORCID 或 OpenAlex 编号；填写不等于身份认证。');
      const profileStatement = { id: user.id, displayName: user.displayName, institution: user.profile.institution, orcid: user.profile.orcid,
        openalexId: user.profile.openalexId, identityStatus: 'user-declared', walletAddress: user.profile.walletAddress };
      return { contentHash: digest(profileStatement), kind: 'CLAIM', profileStatement, proofMeaning: '用户个人档案声明存证；钱包签名不证明学术身份已经认证。' };
    }
    if (recordType === 'research') {
      const record = research.present(research.row(userId, recordId, true));
      return { contentHash: record.rootHash, kind: 'SUBMIT', researchId: record.id };
    }
    if (recordType === 'review') {
      const record = parse(store.one('SELECT data FROM reviews WHERE id=? AND reviewer_id=?', recordId, userId));
      if (!record || record.status !== 'submitted') fail(403, '只能登记本人已提交的审阅意见。');
      return { contentHash: digest(record), kind: 'REVIEW', researchId: record.researchId };
    }
    if (recordType === 'contribution') {
      const record = parse(store.one('SELECT data FROM contributions WHERE id=? AND user_id=?', recordId, userId));
      if (!record) fail(403, '只能登记本人已验收的贡献。');
      return { contentHash: record.receiptHash, kind: record.kind === 'reproduction' ? 'REPRODUCE' : 'REVIEW', researchId: record.researchId };
    }
    fail(400, '不支持的链上声明类型。');
  }
  async function prepareAttestation(user, payload) {
    if (!user.profile.walletVerified || !user.profile.walletAddress) fail(409, '请先签名关联自己的钱包。');
    const recordId = field(payload.recordId, '记录编号', 1, 120);
    const source = attestationSource(user.id, payload.recordType, recordId);
    const api = await chain();
    const prepared = await api.buildRecordTransaction({ network: payload.network || 'mainnet', wallet: user.profile.walletAddress, userId: user.id, kind: source.kind, contentHash: source.contentHash });
    const attestation = { id: id('attestation'), userId: user.id, recordType: payload.recordType, recordId, ...source, network: prepared.network.key || prepared.network.network, chainId: prepared.network.chainId,
      wallet: user.profile.walletAddress, status: 'prepared', createdAt: new Date().toISOString(), rule: prepared.record.rule, contractAddress: prepared.transaction.to, transaction: prepared.transaction };
    store.run('INSERT INTO attestations(id,user_id,data) VALUES(?,?,?)', attestation.id, user.id, JSON.stringify(attestation));
    return { attestation, transaction: prepared.transaction, network: prepared.network };
  }
  async function confirmAttestation(userId, attestationId, payload) {
    const attestation = parse(store.one('SELECT data FROM attestations WHERE id=? AND user_id=?', attestationId, userId));
    if (!attestation) fail(404, '找不到本账号的待确认链上声明。');
    const txHash = field(payload.txHash, '交易哈希', 66, 66).toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) fail(400, '交易哈希无效。');
    if (attestation.status === 'confirmed') { if (attestation.txHash === txHash) return { attestation }; fail(409, '这份声明已经由另一笔交易确认。'); }
    const api = await chain();
    store.transaction(() => {
      const current = parse(store.one('SELECT data FROM attestations WHERE id=? AND user_id=?', attestationId, userId));
      if (current.status === 'confirmed') { if (current.txHash !== txHash) fail(409, '声明已由其他交易确认。'); return; }
      store.run('UPDATE attestations SET data=? WHERE id=?', JSON.stringify({ ...current, txHash, status: 'pending', submittedAt: new Date().toISOString(), lastError: null }), attestationId);
    });
    function recordFailure(error) {
      store.transaction(() => {
        const current = parse(store.one('SELECT data FROM attestations WHERE id=? AND user_id=?', attestationId, userId));
        if (current.status !== 'confirmed' && current.txHash === txHash) store.run('UPDATE attestations SET data=? WHERE id=?', JSON.stringify({ ...current, status: ['TRANSACTION_PENDING','RPC_TIMEOUT','RPC_UNAVAILABLE'].includes(error.code) ? 'pending' : 'verification_failed', lastError: { code: error.code || 'VERIFICATION_FAILED', message: String(error.message).slice(0, 1000) } }), attestationId);
      });
    }
    try {
      const verified = await api.verifyRecordTransaction({ network: attestation.network, wallet: attestation.wallet, userId, kind: attestation.kind, contentHash: attestation.contentHash, txHash });
      if (verified.verified !== true || verified.contractAddress?.toLowerCase() !== attestation.contractAddress.toLowerCase()) fail(409, '链上回执与准备的合约不一致。');
      return store.transaction(() => {
      const current = parse(store.one('SELECT data FROM attestations WHERE id=? AND user_id=?', attestationId, userId));
      if (current.status === 'confirmed') { if (current.txHash === txHash) return { attestation: current }; fail(409, '声明已确认。'); }
      const duplicate = store.one('SELECT id FROM attestations WHERE tx_hash=?', `${attestation.network}:${txHash}`);
      if (duplicate && duplicate.id !== attestationId) fail(409, '该交易已经绑定其他声明，不能重复使用。');
      const confirmed = { ...current, ...verified, status: 'confirmed', txHash };
      store.run('UPDATE attestations SET tx_hash=?,data=? WHERE id=?', `${attestation.network}:${txHash}`, JSON.stringify(confirmed), attestationId);
      if (attestation.researchId) store.event(attestation.researchId, userId, 'chain-attestation-confirmed', { attestationId, txHash, chainId: attestation.chainId });
      return { attestation: confirmed };
      });
    } catch (error) { recordFailure(error); throw error; }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const origin = requestOrigin(req);
      const rawPath = decodeURIComponent(req.url.split(/[?#]/)[0]);
      if (rawPath.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) fail(404, '路径不合法。');
      const url = new URL(req.url, origin);
      if (await sourceAdmin.handle(req, res, url)) return;
      if (await claimFlow.handle(req, res, url)) return;
      if (await paperCheckup.handle(req, res, url)) return;
      if (url.pathname.startsWith('/scholar-api/literature/')) return await publicLiteratureRoute(req, res, url);
      if (url.pathname.startsWith('/scholar-api/')) return await publicScholarRoute(req, res, url);
      if (url.pathname.startsWith('/api/agent/')) return await agentRoute(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.authorization) fail(403, 'Agent 授权只能用于专用 Agent 接口。');
        // Public scholar tools are readers, never clients of the account API.
        if (req.headers.referer) {
          try { const referrer = new URL(req.headers.referer); if (referrer.origin === origin && (referrer.pathname.startsWith('/legacy/') || referrer.pathname.startsWith('/ui/') || referrer.pathname.startsWith('/classic/') || referrer.pathname.startsWith('/workbench/') || referrer.pathname.startsWith('/live/') || referrer.pathname.startsWith('/paper/'))) fail(403, '公开档案工具不能访问科研协作账号接口。'); }
          catch (error) { if (error.status) throw error; }
        }
        const writing = ['POST','PUT','PATCH','DELETE'].includes(req.method);
        if (writing && req.headers.origin !== origin) fail(403, '写入请求必须来自当前站点。');
        if (req.method === 'GET' && url.pathname === '/api/session') { const s = auth.session(req); return json(res, 200, { user: s?.user || null, csrfToken: s?.csrfToken || null }); }
        if (req.method === 'POST' && ['/api/auth/register','/api/auth/login'].includes(url.pathname)) {
          rateLimit(req); const payload = await body(req);
          return json(res, 200, await auth[url.pathname.endsWith('register') ? 'register' : 'login'](req, res, payload));
        }
        if (req.method === 'GET' && url.pathname === '/api/community') return json(res, 200, community.snapshot(auth.session(req)?.user.id || null));
        const communityTask = url.pathname.match(/^\/api\/community\/tasks\/([^/]+)(?:\/(answer))?$/);
        if (req.method === 'GET' && communityTask && !communityTask[2]) return json(res, 200, act.task(auth.session(req)?.user.id || null, communityTask[1]));
        const current = auth.requireSession(req); const user = current.user;
        if (writing) auth.csrf(req, current);
        const researchMatch = url.pathname.match(/^\/api\/research\/([^/]+)(?:\/(assess|file|material|report|review-requests|dual-review|publish))?$/);
        const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(claim|deliver|verify))?$/);
        if (req.method === 'GET') {
          if (url.pathname === '/api/agents') return json(res, 200, { ...grants.list(user.id), allowedScopes: AGENT_SCOPES });
          if (url.pathname === '/api/community/points') return json(res, 200, act.points(user.id));
          if (url.pathname === '/api/overview') return json(res, 200, overview(user));
          if (url.pathname === '/api/export') {
            res.setHeader('Content-Disposition', 'attachment; filename="aia-my-records.json"');
            return json(res, 200, { schema: 1, exportedAt: new Date().toISOString(), ...overview(user), attestations: store.all('SELECT data FROM attestations WHERE user_id=? ORDER BY rowid DESC', user.id).map(parse) });
          }
          if (url.pathname === '/api/users') return json(res, 200, auth.search(url.searchParams.get('q') || ''));
          if (url.pathname === '/api/scholars') return json(res, 200, await scholars.search(url.searchParams.get('q') || '', { institution: url.searchParams.get('institution') || '' }));
          const scholarMatch = url.pathname.match(/^\/api\/scholars\/([^/]+)$/);
          if (scholarMatch) return json(res, 200, await scholars.author(decodeURIComponent(scholarMatch[1])));
          if (url.pathname === '/api/research') return json(res, 200, { research: research.list(user.id) });
          if (url.pathname === '/api/reviews') return json(res, 200, { reviews: workflow.reviews(user.id) });
          if (url.pathname === '/api/tasks') return json(res, 200, { tasks: workflow.tasks(user.id) });
          if (url.pathname === '/api/contributions') return json(res, 200, { contributions: workflow.contributions(user.id) });
          if (url.pathname === '/api/chain/config') return json(res, 200, await (await chain()).getChainConfig(url.searchParams.get('network') || 'mainnet'));
          if (url.pathname === '/api/attestations') return json(res, 200, { attestations: store.all('SELECT data FROM attestations WHERE user_id=? ORDER BY rowid DESC', user.id).map(parse) });
          if (researchMatch) {
            const [, researchId, action] = researchMatch;
            if (!action) { const detail = workflow.researchDetail(user.id, researchId); const info = community.detail(user.id, researchId); return json(res, 200, { ...detail, research: { ...detail.research, published: info.published }, community: info }); }
            if (action === 'dual-review') return json(res, 200, community.detail(user.id, researchId));
            if (action === 'report') return json(res, 200, research.report(user.id, researchId));
            if (action === 'file' || action === 'material') return download(res, await research.file(user.id, researchId, url.searchParams.get('path')), action === 'file');
          }
          if (taskMatch && !taskMatch[2]) return json(res, 200, workflow.detail(user.id, taskMatch[1]));
          const deliveryMatch = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/(file|material)$/);
          if (deliveryMatch) return download(res, await workflow.deliveryFile(user.id, deliveryMatch[1], url.searchParams.get('path')), deliveryMatch[2] === 'file');
          fail(404, '接口不存在。');
        }
        if (writing) {
          const payload = await body(req, url.pathname === '/api/research/import' || taskMatch?.[2] === 'deliver' ? 32 * 1024 * 1024 : 65536);
          if (req.method === 'PUT' && url.pathname === '/api/profile') return json(res, 200, auth.profile(user.id, payload));
          const agentGrant = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
          if (req.method === 'DELETE' && agentGrant) return json(res, 200, grants.revoke(user.id, agentGrant[1]));
          if (req.method !== 'POST') fail(405, '不支持该请求方式。');
          if (url.pathname === '/api/agents') return json(res, 200, grants.issue(user.id, payload));
          if (communityTask?.[2] === 'answer') return json(res, 200, act.answer(user.id, communityTask[1], payload));
          const attentionPath = url.pathname.match(/^\/api\/community\/attention\/([^/]+)\/claim$/);
          if (attentionPath) return json(res, 200, community.claimAttention(user.id, attentionPath[1]));
          if (researchMatch?.[2] === 'dual-review') return json(res, 200, await community.review(user.id, researchMatch[1]));
          if (researchMatch?.[2] === 'publish') return json(res, 200, community.publish(user.id, researchMatch[1], payload));
          if (url.pathname === '/api/auth/logout') return json(res, 200, auth.logout(req, res));
          if (url.pathname === '/api/research/import') return json(res, 200, await research.importResearch(user, payload));
          if (url.pathname === '/api/tasks') return json(res, 200, workflow.createTask(user.id, payload));
          if (researchMatch?.[2] === 'assess') return json(res, 200, await research.assess(user.id, researchMatch[1]));
          if (researchMatch?.[2] === 'review-requests') return json(res, 200, workflow.requestReview(user.id, researchMatch[1], payload));
          const reviewMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/submit$/);
          if (reviewMatch) { community.checkAttentionSubmission(user.id, reviewMatch[1]); return json(res, 200, workflow.submitReview(user.id, reviewMatch[1], payload)); }
          if (taskMatch?.[2] === 'claim') return json(res, 200, workflow.claim(user.id, taskMatch[1]));
          if (taskMatch?.[2] === 'deliver') return json(res, 200, await workflow.deliver(user.id, taskMatch[1], payload));
          if (taskMatch?.[2] === 'verify') return json(res, 200, workflow.verify(user.id, taskMatch[1], payload));
          if (url.pathname === '/api/wallet/challenge') {
            const challenge = (await chain()).createWalletChallenge({ userId: user.id, address: payload.address, origin });
            store.run('INSERT INTO wallet_challenges(id,user_id,data) VALUES(?,?,?)', challenge.id, user.id, JSON.stringify(challenge));
            return json(res, 200, { id: challenge.id, message: challenge.message, expiresAt: challenge.expiresAt });
          }
          if (url.pathname === '/api/wallet/verify') {
            const row = store.one('SELECT * FROM wallet_challenges WHERE id=? AND user_id=?', field(payload.challengeId, '钱包挑战编号', 1, 120), user.id);
            if (!row || row.consumed_at) fail(409, '签名挑战无效或已使用。');
            const challenge = parse(row);
            if (challenge.origin !== origin || Date.parse(challenge.expiresAt) <= Date.now()) fail(409, '签名挑战已过期或站点不匹配。');
            const verified = await (await chain()).verifyWalletSignature({ challenge, signature: payload.signature, address: challenge.address, userId: user.id, origin });
            const result = store.transaction(() => {
              if (store.one('SELECT consumed_at FROM wallet_challenges WHERE id=?', challenge.id).consumed_at) fail(409, '签名挑战已使用。');
              const owner = store.one("SELECT id FROM users WHERE lower(json_extract(data,'$.profile.walletAddress'))=? AND id<>?", verified.address.toLowerCase(), user.id);
              if (owner) fail(409, '该钱包已关联另一账号。');
              const fresh = auth.userById(user.id);
              fresh.profile.walletAddress = verified.address; fresh.profile.walletVerified = true;
              store.run('UPDATE wallet_challenges SET consumed_at=? WHERE id=?', new Date().toISOString(), challenge.id);
              auth.saveUser(fresh); return { user: fresh };
            });
            return json(res, 200, result);
          }
          if (url.pathname === '/api/attestations/prepare') return json(res, 200, await prepareAttestation(user, payload));
          const confirmation = url.pathname.match(/^\/api\/attestations\/([^/]+)\/confirm$/);
          if (confirmation) return json(res, 200, await confirmAttestation(user.id, confirmation[1], payload));
          fail(404, '接口不存在。');
        }
        fail(405, '不支持该请求方式。');
      }
      if (!['GET','HEAD'].includes(req.method)) fail(405, '不支持该请求方式。');
      if (url.pathname === '/admin/sources') { res.writeHead(302, { Location: '/admin/sources/', 'Cache-Control': 'no-store' }); return res.end(); }
      const adminAssets = { '/admin/sources/': ['index.html', 'text/html; charset=utf-8'], '/admin/sources/admin.js': ['admin.js', 'text/javascript; charset=utf-8'], '/admin/sources/admin.css': ['admin.css', 'text/css; charset=utf-8'] };
      if (Object.hasOwn(adminAssets, url.pathname)) {
        const [name, contentType] = adminAssets[url.pathname];
        const bytes = await readFile(path.join(ROOT, 'admin', name));
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
          'Content-Security-Policy': `default-src 'none'; script-src ${origin}/admin/sources/ ${origin}/ui/site-header.js; style-src ${origin}/admin/sources/ ${origin}/ui/site-header.css; connect-src ${origin}/admin/sources/api/; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const redirect = publicRedirect(url) || (url.pathname === '/workspace' ? `/workspace/${url.search}` : null);
      if (redirect) {
        res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (publicAssets.has(url.pathname)) {
        const relative = publicAssets.get(url.pathname);
        const absolute = path.join(REPO, ...relative.split('/'));
        const stat = await lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || path.relative(await realpath(REPO), await realpath(absolute)).replaceAll(path.sep, '/') !== relative) fail(404, '公开资源路径不合法。');
        let bytes = await readFile(absolute);
        const extension = path.extname(relative);
        if (extension === '.html') {
          bytes = Buffer.from(bytes.toString('utf8').replace(/<a\s+href="\.\.\/product\/checkup\.py"[^>]*>[^<]*<\/a>/g, '<span>评分脚本保留在仓库源代码中</span>'));
        }
        res.writeHead(200, { 'Content-Type': publicMime[extension], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
          'Content-Security-Policy': `default-src 'none'; script-src ${origin}/ui/ ${origin}/workbench/ ${origin}/live/ ${origin}/paper/ https://cdn.jsdelivr.net; style-src ${origin}/ui/ ${origin}/workbench/ ${origin}/live/ ${origin}/paper/ 'unsafe-inline'; img-src ${origin}/ui/ ${origin}/workbench/ ${origin}/brand/ ${origin}/scholar-api/literature/resource data:; connect-src ${origin}/ui/ ${origin}/workbench/ ${origin}/product/ ${origin}/chain/ ${origin}/scholar-api/ ${origin}/claim-api/ ${origin}/paper-api/ https://rpc.botchain.ai https://rpc.bohr.life https://cdn.jsdelivr.net; font-src ${origin}/ui/ ${origin}/workbench/; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const assets = { '/community.js': ['community.js', 'text/javascript; charset=utf-8'], '/workspace/community.js': ['community.js', 'text/javascript; charset=utf-8'], '/workspace/': ['index.html', 'text/html; charset=utf-8'], '/workspace/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js','text/javascript; charset=utf-8'], '/app.css': ['app.css','text/css; charset=utf-8'], '/favicon.svg': ['mark.svg','image/svg+xml'], '/mark.svg': ['mark.svg','image/svg+xml'], '/workspace/app.js': ['app.js','text/javascript; charset=utf-8'], '/workspace/app.css': ['app.css','text/css; charset=utf-8'], '/workspace/mark.svg': ['mark.svg','image/svg+xml'] };
      if (!Object.hasOwn(assets, url.pathname)) fail(404, '页面不存在。');
      const [name, contentType] = assets[url.pathname];
      const bytes = await readFile(path.join(ROOT, 'public', name));
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || error.statusCode || (error.code === 'ENOENT' ? 404 : error.code === 'TRANSACTION_PENDING' ? 409 : 400);
      const message = String(error.message || '请求未完成。');
      json(res, status, { error: /SQLITE|constraint failed|database|ENOENT|EACCES|EPERM/i.test(message) ? '记录保存或读取失败，请重试。' : message, ...(error.code && !String(error.code).startsWith('SQLITE') ? { code: error.code } : {}) });
    }
  });
  server.requestTimeout = 60000;
  let closing;
  const close = () => closing ||= (async () => { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await act.whenIdle(); await claimFlow.close?.(); await paperCheckup.close?.(); await sourceAdmin.close?.(); store.close(); })();
  return { server, dataDir, store, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8890);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
  const app = await createApp();
  const stop = async () => { try { await app.close(); } catch (error) { console.error('关闭应用失败：', error.message); process.exitCode = 1; } };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  app.server.once('error', async error => { console.error('监听失败：', error.message); process.exitCode = 1; await stop(); });
  app.server.listen(port, process.env.AIA_BIND || '127.0.0.1', () => console.log(`AIA 真实协作：http://127.0.0.1:${port}`));
}
