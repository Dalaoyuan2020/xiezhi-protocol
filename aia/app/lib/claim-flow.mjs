import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { id as keccakId, isAddress, ZeroAddress } from 'ethers';
import { createClaimLedger, LOCAL_CHAIN } from './claim-ledger.mjs';
import { createClaimPublicChain } from './claim-public-chain.mjs';
import { sendClaimCode, smtpConfigured } from './claim-mail.mjs';

const PREFIX = '/claim-api', COOKIE = 'aia_claim_session';
const HOUR = 3600000, SESSION_MS = 6 * HOUR;
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max = 350) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
const clone = value => JSON.parse(JSON.stringify(value));
export function canonicalCertificate(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalCertificate).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalCertificate(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const certificateHash = payload => `0x${hash(canonicalCertificate(payload))}`;
function fail(status, message) { const error = new Error(message); error.status = status; error.claimSafe = true; throw error; }
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }
async function bodyOf(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, '请以 JSON 格式提交。');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) fail(413, '提交内容过大。'); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, '提交内容无效。'); }
  if (!object(body)) fail(400, '提交内容必须是对象。');
  return body;
}
const demo = () => ({
  author: { id: 'demo-xulinsen', name: '徐林森', institution: '模拟研究机构 · 交互案例', fictional: true },
  works: [
    { id: 'DEMO-XU-01', title: '开放研究数据的可追溯核查方法（模拟论文）', year: 2025, doi: null, source: '明确标注的模拟材料', fictional: true, hint: '案例设定：属于本人；可以认领。' },
    { id: 'DEMO-XU-02', title: '同名作者的海洋材料研究（模拟错挂论文）', year: 2024, doi: null, source: '明确标注的模拟材料', fictional: true, hint: '案例设定：同名作者成果；请排除。' },
    { id: 'DEMO-XU-03', title: '待补充原始数据的协作实验（模拟论文）', year: 2026, doi: null, source: '明确标注的模拟材料', fictional: true, hint: '案例设定：证据不足；可以选择待核对。' },
  ], notice: '这是以“徐林森”为检索示例名称的虚构认领材料，不代表同名真实学者的论文、机构或信誉。',
});

export async function createClaimFlow({ dataDir, credentials = () => ({}), requestOrigin, secureCookies = false,
  now = Date.now, fetchImpl = fetch, sendMail = sendClaimCode, ledger: injectedLedger, publicLedger: injectedPublicLedger } = {}) {
  if (!dataDir || typeof requestOrigin !== 'function') throw new Error('Claim flow requires private storage and an origin validator');
  const certificateDir = path.join(dataDir, 'claim-certificates');
  const sessionDir = path.join(dataDir, 'claim-sessions');
  await mkdir(certificateDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const ledger = injectedLedger || createClaimLedger({ dataDir });
  const publicLedger = injectedPublicLedger || createClaimPublicChain();
  const sessions = new Map(), limits = new Map(); let closed = false;
  async function saveSession(current) {
    const file = path.join(sessionDir, `${current.id}.json`), temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    // Persist only the hashed cookie identifier. Neither raw email addresses nor OTPs are stored.
    const value = { version: 1, id: current.id, csrfToken: current.csrfToken, expires: current.expires, flow: current.flow };
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file);
  }
  for (const entry of await readdir(sessionDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    const file = path.join(sessionDir, entry);
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.version !== 1 || value.id !== entry.slice(0, -5) || !/^[a-f0-9]{64}$/.test(value.csrfToken) || !Number.isFinite(value.expires)) throw new Error('Invalid persisted claim session; stored data preserved');
    if (value.expires <= now()) { await unlink(file); continue; }
    sessions.set(value.id, { ...value, queue: Promise.resolve() });
  }
  function limit(key, maximum, window = HOUR) {
    const time = now();
    for (const [id, item] of limits) if (item.until <= time) limits.delete(id);
    const current = limits.get(key) || { count: 0, until: time + window };
    if (limits.size > 10000 || current.count >= maximum) fail(429, '操作次数过多，请稍后重试。');
    current.count++; limits.set(key, current);
  }
  async function session(req, res, create = false) {
    for (const [id, value] of sessions) if (value.expires <= now()) {
      sessions.delete(id);
      await unlink(path.join(sessionDir, `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const cookie = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const id = cookie && /^[a-f0-9]{64}$/.test(cookie) ? hash(cookie) : null;
    let current = id && sessions.get(id);
    if (!current && create) {
      limit(`session:${req.socket.remoteAddress}`, 60);
      if (sessions.size >= 500) fail(503, '当前会话较多，请稍后再试。');
      const token = randomBytes(32).toString('hex');
      current = { id: hash(token), csrfToken: randomBytes(32).toString('hex'), expires: now() + SESSION_MS, flow: null, queue: Promise.resolve() };
      await saveSession(current);
      sessions.set(current.id, current);
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/claim-api/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secureCookies ? '; Secure' : ''}`);
    }
    return current;
  }
  function visible(flow) {
    if (!flow) return null;
    return { id: flow.id, mode: flow.mode, author: flow.author, works: flow.works, decisions: flow.decisions,
      notice: flow.notice, email: flow.email ? { masked: flow.email.masked, delivery: flow.email.delivery,
        verified: flow.email.verified, previewConfirmed: flow.email.previewConfirmed,
        retryAfter: Math.max(0, Math.ceil((flow.email.sentAt + 60000 - now()) / 1000)),
        expiresIn: Math.max(0, Math.ceil((flow.email.expires - now()) / 1000)),
        challengeActive: Boolean(flow.email.challenge && flow.email.expires > now() && flow.email.attempts < 5),
        scope: '邮箱控制权，不代表作者身份' } : null,
      assessment: assessment(flow), finalizing: Boolean(flow.pendingPayload && !flow.certificate),
      mainnetAnchor: flow.pendingPublicAnchor || null, certificate: flow.certificate || null };
  }
  function state(current) { return { flow: visible(current.flow), mail: { configured: smtpConfigured(credentials()) }, chain: LOCAL_CHAIN, publicChain: publicLedger.config() }; }
  function assessment(flow) {
    const totals = { claimed: 0, excluded: 0, unsure: 0, total: flow.works.length };
    for (const decision of flow.decisions) totals[decision.decision === 'claim' ? 'claimed' : decision.decision === 'exclude' ? 'excluded' : 'unsure']++;
    return { ...totals, score: totals.total ? Math.round((totals.claimed + totals.excluded) / totals.total * 100) : 0,
      label: '材料整理完成度', notice: '这是材料分类完成度，不是学术信誉分，也不证明作者身份。' };
  }
  function active(current, body, { mutable = true } = {}) {
    const flow = current.flow;
    if (!flow || body.flowId !== flow.id) fail(409, '认领流程已变化，请重新打开当前认领步骤。');
    if (mutable && flow.certificate) fail(409, '该证书已完成，请重新开始新的认领流程。');
    if (mutable && flow.pendingPayload) fail(409, '存证材料已锁定，请完成或重试当前存证。');
    return flow;
  }
  function freezePayload(flow, anchor) {
    if (!flow.pendingPayload) flow.pendingPayload = {
      id: flow.id, issuedAt: new Date(now()).toISOString(), mode: flow.mode, author: clone(flow.author), assessment: assessment(flow),
      works: flow.works.map(work => ({ ...work, decision: flow.decisions.find(item => item.workId === work.id).decision })),
      emailVerification: { mode: flow.email.delivery, verified: flow.email.verified, masked: flow.email.masked,
        commitment: flow.email.commitment, commitmentAlgorithm: 'sha256(flowId + ":" + lowercaseEmail)', scope: '邮箱控制权，不代表作者身份' },
      ...(anchor ? { anchor } : {}),
      notice: anchor ? '公开材料的自述认领记录，BOT Chain 主网存证；邮箱及钱包控制权不证明作者身份，链上记录不证明学术真实性。'
        : flow.mode === 'demo' ? '虚构交互案例 · 模拟认领证书 · 本地模拟链，非主网。'
          : '公开材料的自述认领记录；邮箱验证不证明作者身份。仅在本地模拟链存证，非主网。',
    };
    return flow.pendingPayload;
  }
  async function issueCertificate(flow, receipt) {
    const payload = flow.pendingPayload;
    const certificate = { schema: 'scholar-claim-certificate/v1', payload, hash: certificateHash(payload), receipt };
    const file = path.join(certificateDir, `${flow.id}.json`), temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(certificate, null, 2), { mode: 0o600 }); await rename(temporary, file);
    flow.certificate = certificate;
    return certificate;
  }
  async function issuedByThisService(certificate) {
    const id = certificate.payload?.id;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return false;
    let saved;
    try { saved = JSON.parse(await readFile(path.join(certificateDir, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    // A valid on-chain hash proves a wallet recorded that content, not that this service issued it.
    return canonicalCertificate(saved) === canonicalCertificate(certificate);
  }
  async function publicChainCall(action) {
    try { return await action(); }
    catch (error) { if (error.claimSafe) throw error; fail(502, '主网核验暂不可用，请保留交易编号并稍后重试；不会自动再次发送交易。'); }
  }
  async function openalex(resource) {
    const url = new URL(resource, 'https://api.openalex.org');
    if (credentials().OPENALEX_API_KEY) url.searchParams.set('api_key', credentials().OPENALEX_API_KEY);
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) fail(response.status === 404 ? 404 : 502, response.status === 404 ? '未找到该公开作者档案。' : '公开文献源暂不可用，请稍后重试。');
      return await response.json();
    } catch (error) { if (error.claimSafe) throw error; fail(502, '公开文献源暂不可用，请稍后重试。'); }
  }
  async function publicMaterials(authorId) {
    if (typeof authorId !== 'string' || !/^A\d{1,20}$/.test(authorId)) fail(400, '请选择有效的 OpenAlex 作者候选。');
    const [author, result] = await Promise.all([openalex(`/authors/${authorId}`), openalex(`/works?filter=author.id:${authorId}&per-page=25&sort=publication_year:desc`)]);
    if (author.id !== `https://openalex.org/${authorId}` || !Array.isArray(result.results)) fail(502, '公开作者材料格式不完整。');
    const works = result.results.filter(work => /^https:\/\/openalex.org\/W\d+$/.test(work.id || '')).slice(0, 25).map(work => ({
      id: work.id.split('/').pop(), title: clean(work.display_name || work.title), year: Number(work.publication_year) || null,
      doi: typeof work.doi === 'string' && /^https:\/\/doi.org\/10\./.test(work.doi) ? clean(work.doi, 220) : null,
      source: work.id, fictional: false,
    }));
    if (!works.length) fail(422, '该作者尚无可核对的公开论文，请先选择其他档案。');
    return { author: { id: authorId, name: clean(author.display_name, 120), institution: clean(author.last_known_institutions?.[0]?.display_name, 160), fictional: false }, works,
      notice: `从 OpenAlex 获取最近 ${works.length} 篇公开材料；此处的自述认领需后续独立核查，邮箱验证不证明作者身份。` };
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      if (closed) fail(503, '认领服务暂不可用。');
      const origin = requestOrigin(req);
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, '请求来源不匹配。');
      const route = url.pathname.slice(PREFIX.length), writing = req.method === 'POST';
      if (!['GET', 'POST'].includes(req.method)) fail(405, '不支持该方法。');
      if (writing && req.headers.origin !== origin) fail(403, '请求来源不匹配。');
      const current = await session(req, res, route === '/session' && req.method === 'GET');
      if (!current) fail(401, '认领会话已过期，请刷新页面重新开始。');
      if (writing && !same(req.headers['x-csrf-token'], current.csrfToken)) fail(403, '会话校验失败，请刷新页面。');
      if (route === '/session' && req.method === 'GET') { send(res, 200, { csrfToken: current.csrfToken, ...state(current) }); return true; }
      if (route === '/chain' && req.method === 'GET') { limit(`chain:${req.socket.remoteAddress}`, 120, 60000); send(res, 200, await ledger.status()); return true; }
      if (route === '/certificate' && req.method === 'GET') {
        if (!current.flow?.certificate) fail(404, '当前会话还没有证书。');
        res.setHeader('Content-Disposition', `attachment; filename="scholar-claim-${current.flow.id}.json"`);
        send(res, 200, current.flow.certificate); return true;
      }
      if (!writing) fail(404, '认领接口不存在。');
      const body = await bodyOf(req);
      const operation = current.queue.then(async () => {
        try {
          if (route === '/reset') { current.flow = null; return state(current); }
          if (route === '/start') {
            limit(`start:${req.socket.remoteAddress}`, 40);
            if (!['demo', 'public'].includes(body.mode)) fail(400, '请选择公开档案或模拟认领案例。');
            const materials = body.mode === 'demo' ? demo() : await publicMaterials(body.authorId);
            current.flow = { id: randomBytes(16).toString('hex'), mode: body.mode, ...materials, decisions: [], email: null, certificate: null };
            return state(current);
          }
          if (route === '/certificate/verify') {
            limit(`verify:${req.socket.remoteAddress}`, 30, 60000);
            const certificate = body.certificate;
            if (!object(certificate) || !object(certificate.payload) || certificate.schema !== 'scholar-claim-certificate/v1') fail(400, '证书格式无效。');
            const computedHash = certificateHash(certificate.payload), hashMatches = same(certificate.hash, computedHash);
            const mainnet = certificate.receipt?.mode === 'mainnet';
            const anchor = certificate.payload.anchor;
            const bindingMatches = !mainnet || anchor?.mode === 'mainnet' && anchor.chainId === 677
              && typeof anchor.walletAddress === 'string' && typeof certificate.receipt.walletAddress === 'string'
              && anchor.walletAddress.toLowerCase() === certificate.receipt.walletAddress.toLowerCase()
              && anchor.subjectHash === certificate.receipt.subjectHash;
            const chainMatches = Boolean(hashMatches && bindingMatches && (mainnet
              ? await publicChainCall(() => publicLedger.verify(certificate.receipt, computedHash))
              : await ledger.verify(certificate.receipt, computedHash)));
            const recognized = await issuedByThisService(certificate);
            return { valid: Boolean(hashMatches && chainMatches), hashMatches, chainMatches, computedHash, issuedByThisService: recognized,
              mode: mainnet ? 'mainnet' : 'local', notice: `${mainnet ? '核验范围为文件指纹、钱包与 BOT Chain 主网记录。' : '核验范围为文件指纹与本地 EVM 记录，不是主网。'}${recognized
                ? '文件与本站保存的签发档案一致。' : '本站没有匹配的签发档案，链记录一致不能证明本站完成过邮箱验证或签发此证书。'}均不代表论文作者身份或学术真实性认证。` };
          }
          if (!['/selection', '/email/send', '/email/verify', '/finalize', '/prepare-anchor', '/confirm-anchor'].includes(route)) fail(404, '认领接口不存在。');
          const flow = active(current, body, { mutable: !['/finalize', '/prepare-anchor', '/confirm-anchor'].includes(route) });
          if (route === '/selection') {
            if (!Array.isArray(body.decisions) || body.decisions.length !== flow.works.length) fail(400, '请给每篇论文选择认领、排除或待核对。');
            const ids = new Set();
            for (const decision of body.decisions) {
              if (!object(decision) || !flow.works.some(work => work.id === decision.workId) || ids.has(decision.workId) || !['claim', 'exclude', 'unsure'].includes(decision.decision)) fail(400, '论文选择无效或重复。');
              ids.add(decision.workId);
            }
            flow.decisions = body.decisions.map(({ workId, decision }) => ({ workId, decision }));
            flow.email = null; flow.pendingPayload = null;
            return state(current);
          }
          if (route === '/email/send') {
            if (flow.decisions.length !== flow.works.length) fail(409, '请先完成论文认领选择。');
            if (!['smtp', 'preview'].includes(body.delivery) || (body.delivery === 'preview' && flow.mode !== 'demo')) fail(400, '公开档案必须通过真实邮箱验证码验证。');
            if (typeof body.email !== 'string' || body.email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(body.email)) fail(400, '请输入有效邮箱。');
            if (flow.email && now() - flow.email.sentAt < 60000) fail(429, '验证码刚刚发送，请 60 秒后再试。');
            const email = body.email.toLowerCase();
            if (body.delivery === 'smtp' && !smtpConfigured(credentials())) fail(503, '服务器尚未配置 SMTP，请管理员在管理页填写发信服务。');
            limit(`mail-ip:${req.socket.remoteAddress}`, 15);
            limit(`mail-address:${hash(email)}`, 5);
            if (body.delivery === 'smtp') limit('mail-global', 100);
            const code = String(randomInt(0, 1000000)).padStart(6, '0'), salt = randomBytes(32).toString('hex');
            const [local, domain] = email.split('@');
            flow.pendingPayload = null;
            flow.email = { masked: `${local.slice(0, 1)}***@${domain}`, commitment: `0x${hash(`${flow.id}:${email}`)}`, delivery: body.delivery, verified: false, previewConfirmed: false,
              sentAt: now(), expires: now() + 600000, attempts: 0, salt, challenge: hash(`${salt}:${code}`) };
            if (body.delivery === 'smtp') {
              // A restart after SMTP accepts the message must not lose the delivered challenge.
              await saveSession(current);
              try { await sendMail({ credentials, email, code }); }
              catch { flow.email.challenge = null; fail(502, '验证码发送失败，请检查 SMTP 配置后稍后重试。'); }
            }
            return { sent: true, delivery: body.delivery, expiresIn: 600, retryAfter: 60,
              ...(body.delivery === 'preview' ? { demoCode: code, notice: '模拟收件箱，仅当前会话可见；未发送邮件，不表示真实邮箱验证。' } : {}), ...state(current) };
          }
          if (route === '/email/verify') {
            const email = flow.email;
            if (!email?.challenge || email.expires <= now() || email.attempts >= 5) fail(400, '验证码已失效，请重新发送。');
            email.attempts++;
            if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) || !same(hash(`${email.salt}:${body.code}`), email.challenge)) fail(400, '验证码不正确。');
            email.challenge = null;
            email.verified = email.delivery === 'smtp'; email.previewConfirmed = email.delivery === 'preview';
            return state(current);
          }
          if (route === '/prepare-anchor') {
            limit(`prepare:${req.socket.remoteAddress}`, 30, 60000);
            if (flow.mode !== 'public' || !flow.email?.verified) fail(409, '主网存证需要公开材料及真实邮箱验证。');
            if (body.acknowledged !== true) fail(400, '请确认主网公开存证及钱包 Gas 费用说明。');
            if (typeof body.walletAddress !== 'string' || !isAddress(body.walletAddress) || body.walletAddress.toLowerCase() === ZeroAddress) fail(400, '请连接有效的钱包地址，不能使用零地址。');
            if (flow.certificate) return { ...state(current), certificate: flow.certificate };
            if (flow.pendingPayload && !flow.pendingPublicAnchor) fail(409, '当前材料已选择本地存证，请完成当前流程。');
            const walletAddress = body.walletAddress.toLowerCase(), subjectHash = keccakId(`openalex:${flow.author.id}`);
            if (flow.pendingPublicAnchor && flow.pendingPublicAnchor.walletAddress !== walletAddress) fail(409, '此存证已绑定原钱包，请使用原钱包继续。');
            const payload = freezePayload(flow, { mode: 'mainnet', chainId: 677, walletAddress, subjectHash });
            flow.pendingPublicAnchor ||= { walletAddress, subjectHash, contentHash: certificateHash(payload), transactionHash: null, preparation: null };
            await saveSession(current);
            const pending = flow.pendingPublicAnchor;
            if (!pending.preparation) pending.preparation = await publicChainCall(() => publicLedger.prepare(pending));
            return { ...state(current), anchor: pending.preparation };
          }
          if (route === '/confirm-anchor') {
            limit(`confirm:${req.socket.remoteAddress}`, 60, 60000);
            if (flow.mode !== 'public' || !flow.email?.verified || !flow.pendingPublicAnchor) fail(409, '请先准备当前材料的主网存证。');
            if (flow.certificate) return { ...state(current), certificate: flow.certificate, chain: flow.certificate.receipt };
            if (typeof body.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)) fail(400, '请输入钱包返回的有效交易编号。');
            const pending = flow.pendingPublicAnchor;
            pending.transactionHash = body.transactionHash;
            await saveSession(current);
            const receipt = await publicChainCall(() => publicLedger.confirm(pending));
            if (receipt.pending) return { ...state(current), pending: true };
            const certificate = await issueCertificate(flow, receipt);
            return { ...state(current), certificate, chain: receipt };
          }
          if (route === '/finalize') {
            limit(`finalize:${req.socket.remoteAddress}`, 30, 60000);
            if (flow.certificate) return { ...state(current), certificate: flow.certificate,
              chain: flow.certificate.receipt.mode === 'mainnet' ? flow.certificate.receipt : await ledger.status() };
            if (flow.pendingPublicAnchor) fail(409, '当前材料已准备主网存证，请在钱包确认后核验交易，不能切换成本地记录。');
            if (!(flow.email?.verified || flow.mode === 'demo' && flow.email?.previewConfirmed)) fail(409, '请先完成当前材料的邮箱验证。');
            const payload = freezePayload(flow), contentHash = certificateHash(payload);
            // Fix the exact content hash before sending a transaction, so a restart can retry safely.
            await saveSession(current);
            const receipt = await ledger.record({ contentHash, subjectHash: `0x${hash(`claim:${flow.mode}:${flow.author.id}`)}` });
            const certificate = await issueCertificate(flow, receipt);
            return { ...state(current), certificate, chain: await ledger.status() };
          }
        } finally {
          // Failed OTP attempts and delivery errors also change state and must survive restarts.
          await saveSession(current);
        }
      });
      current.queue = operation.catch(() => {});
      send(res, 200, await operation);
    } catch (error) {
      send(res, error.claimSafe ? error.status : 500, { error: error.claimSafe ? error.message : '认领服务暂时无法处理，请稍后重试。' });
    }
    return true;
  }
  return { handle, close: async () => { closed = true; await Promise.allSettled([...sessions.values()].map(item => item.queue)); await ledger.close(); sessions.clear(); limits.clear(); } };
}
