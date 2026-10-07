import { fail, field, id } from './store.mjs';

const read = row => row ? JSON.parse(row.data) : null;

/** Explicit publication and independent review are distinct from private imports. */
export function createCommunity(store, auth, research, workflow, act, dual, { now = Date.now } = {}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS community_publications (
    research_id TEXT PRIMARY KEY REFERENCES research(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dual_reviews (id TEXT PRIMARY KEY, research_id TEXT NOT NULL REFERENCES research(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attention_requests (id TEXT PRIMARY KEY, research_id TEXT NOT NULL UNIQUE REFERENCES research(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reviewer_credentials (user_id TEXT PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL);`);
  const inFlight = new Map(), budgets = new Map();
  function latest(researchId) { return read(store.one('SELECT data FROM dual_reviews WHERE research_id=? ORDER BY rowid DESC LIMIT 1', researchId)); }
  function gate(result) {
    if (!result) return { passed: false, reason: '等待双模型评审。' };
    if (result.status === 'unconfigured') return { passed: false, reason: '模型未配置，尚无评审结论。' };
    if (result.status === 'failed') return { passed: false, reason: '模型调用未完成，请检查后重试。' };
    if (result.status === 'disagreement') return { passed: false, reason: '双模型存在分歧，先核对门槛，再决定是否进入正式审稿。' };
    const risk = result.verdict?.water_risk;
    const local = result.localScore;
    const materialScore = local?.artifactHash === result.researchHash && local.max === 100 && Number.isFinite(local.value) && local.value >= 0 && local.value <= 100 ? local.value : 0;
    return ['low', 'mid'].includes(risk) && materialScore >= 60
      ? { passed: true, reason: '双模型风险意见一致且非高风险，材料可检查度至少 60/100；这不是学术真实性认证。' }
      : { passed: false, reason: '请先补足材料或处理高风险问题；进入正式审稿需材料可检查度至少 60/100，且双模型一致为非高风险。' };
  }
  function eligibility(userId) {
    const user = userId && auth.userById(userId);
    if (!user) return { eligible: false, score: null, identityStatus: 'unverified', reason: '登录并核验学术身份后可申请审稿。' };
    const verified = read(store.one('SELECT data FROM reviewer_credentials WHERE user_id=?', userId));
    const valid = verified && verified.authorId === user.profile?.openalexId && Date.parse(verified.expiresAt) > now() && verified.status === 'verified';
    if (!valid) return { eligible: false, score: null, identityStatus: 'unverified', reason: '需由维护者核对账号与学术身份，再确认学术分达到 750；手填档案和钱包签名不能代替身份核验。' };
    return { eligible: verified.score >= 750, score: verified.score, identityStatus: 'verified', authorId: verified.authorId, expiresAt: verified.expiresAt, reason: verified.score >= 750 ? '学术身份已核对，学术分达到 750。' : '已核验身份，学术分尚未达到 750。' };
  }
  function requestFor(researchId) { return read(store.one('SELECT data FROM attention_requests WHERE research_id=?', researchId)); }
  function syncRequest(record, result) {
    const existing = requestFor(record.id);
    // Keep an assigned review frozen. After a completed triage, a fresh,
    // unanimous passing model review may open the formal queue on that version.
    const completedTriage = existing?.kind === 'gate-check' && existing.reviewId &&
      read(store.one('SELECT data FROM reviews WHERE id=?', existing.reviewId))?.status === 'submitted';
    const promote = completedTriage && gate(result).passed;
    if (existing && existing.status !== 'open' && !promote) return existing;
    if (!result || (!result.needsHumanReview && !gate(result).passed)) {
      if (existing) store.run('DELETE FROM attention_requests WHERE id=?', existing.id);
      return null;
    }
    const attention = { id: existing?.id || id('attention'), researchId: record.id, researchHash: record.rootHash, title: record.title,
      ownerId: record.ownerId, ownerName: record.ownerName, kind: result.needsHumanReview ? 'gate-check' : 'peer-review', status: 'open',
      reason: result.needsHumanReview ? '双模型分歧：先由人核对门槛；尚未通过正式审稿门槛。' : gate(result).reason,
      dualReviewId: result.id, createdAt: existing?.createdAt || new Date(now()).toISOString(), reviewId: null,
      ...(promote ? { priorGateReviewId: existing.reviewId } : existing?.priorGateReviewId ? { priorGateReviewId: existing.priorGateReviewId } : {}) };
    store.run('INSERT INTO attention_requests(id,research_id,data) VALUES(?,?,?) ON CONFLICT(research_id) DO UPDATE SET data=excluded.data', attention.id, record.id, JSON.stringify(attention));
    return attention;
  }
  function snapshot(userId = null) {
    const ideas = [], attention = [];
    for (const row of store.all('SELECT r.data FROM research r JOIN community_publications p ON p.research_id=r.id ORDER BY r.rowid DESC LIMIT 100')) {
      const record = read(row), result = latest(record.id);
      ideas.push({ id: record.id, title: record.title, abstract: record.abstract, ownerName: record.ownerName, rootHash: record.rootHash, version: record.version, createdAt: record.createdAt, createdBy: record.createdBy || null, reviewStatus: result?.status || 'not-reviewed', gate: gate(result) });
      const request = requestFor(record.id);
      if (request) {
        const submitted = request.reviewId && read(store.one('SELECT data FROM reviews WHERE id=?', request.reviewId))?.status === 'submitted';
        attention.push({ ...request, status: submitted ? 'submitted' : request.status });
      }
    }
    const pool = act.snapshot(userId);
    const tasks = [...(pool.tasks || []), ...(pool.paperTasks || [])];
    return { ideas, attention, tasks, stats: { ideas: ideas.length, attention: attention.filter(x => x.status === 'open').length, tasks: tasks.length },
      policy: pool.policy, viewer: userId ? { points: act.points(userId), eligibility: eligibility(userId) } : null };
  }
  function publish(userId, researchId, payload) {
    const record = research.present(research.row(userId, researchId, true));
    if (typeof payload.published !== 'boolean') fail(400, '请明确是否公开摘要。');
    if (!payload.published) {
      store.run('DELETE FROM community_publications WHERE research_id=?', researchId);
      return { published: false, notice: '已从公共列表撤下；已授权的协作者及已归档记录仍可查阅。' };
    }
    if (payload.allowReviewMaterials !== true) fail(400, '请明确同意合格的独立审阅者读取这份研究材料。');
    const publication = { researchId, researchHash: record.rootHash, publishedAt: new Date(now()).toISOString(), allowReviewMaterials: true, allowReferenceTasks: payload.allowReferenceTasks === true };
    store.transaction(() => {
      store.run('INSERT INTO community_publications(research_id,data) VALUES(?,?) ON CONFLICT(research_id) DO UPDATE SET data=excluded.data', researchId, JSON.stringify(publication));
      syncRequest(record, latest(researchId));
      store.event(researchId, userId, 'community-published', { researchHash: record.rootHash });
    });
    const referenceChecks = publication.allowReferenceTasks ? act.scheduleReferenceChecks(userId, researchId) : { scheduled: false, reason: 'not-authorized' };
    return { published: true, publication, referenceChecks };
  }
  async function review(userId, researchId, actor = null) {
    const row = research.row(userId, researchId, true);
    if (inFlight.has(researchId)) return inFlight.get(researchId);
    if (inFlight.size >= 2) fail(429, '已有两个双模型评审正在进行，请稍后再试。');
    for (const [key, value] of budgets) if (value.at + 300000 <= now()) budgets.delete(key);
    const budget = budgets.get(userId) || { at: now(), count: 0 };
    if (budget.count >= 4) fail(429, '每个账号每五分钟最多发起四次双模型评审。');
    budget.count++; budgets.set(userId, budget);
    const operation = (async () => {
      const artifact = await research.artifactForReview(userId, researchId);
      const { assessment } = await research.assess(userId, researchId);
      const record = research.present(row);
      const result = await dual.review({ research: record, artifact, assessment });
      if (result.researchHash !== record.rootHash) fail(502, '评审结果与研究版本不匹配。');
      const saved = { ...result, ...(actor ? { performedBy: actor } : {}) };
      store.transaction(() => {
        research.row(userId, researchId, true);
        store.run('INSERT INTO dual_reviews(id,research_id,data) VALUES(?,?,?)', saved.id, researchId, JSON.stringify(saved));
        syncRequest(record, saved);
        store.event(researchId, userId, 'dual-review-completed', { reviewId: saved.id, status: saved.status, researchHash: record.rootHash, ...(actor ? { performedBy: actor } : {}) });
      });
      return { review: saved, gate: gate(saved) };
    })();
    inFlight.set(researchId, operation);
    try { return await operation; } finally { inFlight.delete(researchId); }
  }
  function detail(userId, researchId) {
    research.row(userId, researchId);
    const result = latest(researchId);
    return { review: result, gate: gate(result), published: Boolean(store.one('SELECT research_id FROM community_publications WHERE research_id=?', researchId)), attention: requestFor(researchId) };
  }
  function claimAttention(userId, attentionId) {
    const request = read(store.one('SELECT data FROM attention_requests WHERE id=?', attentionId));
    if (!request) fail(404, '审阅请求不存在。');
    if (!store.one('SELECT research_id FROM community_publications WHERE research_id=?', request.researchId)) fail(409, '作者尚未授权社区审阅或已经撤下。');
    if (!eligibility(userId).eligible) fail(403, eligibility(userId).reason);
    if (request.ownerId === userId) fail(403, '作者不能认领自己的审稿。');
    if (request.status !== 'open') fail(409, '这份审阅请求已被领取。');
    if (request.kind === 'peer-review' && !gate(latest(request.researchId)).passed) fail(409, '此版本尚未通过 Idea 门槛。');
    const focus = request.kind === 'gate-check' ? '请核对双模型分歧与材料缺口，并说明是否满足正式审稿的门槛。' : '请独立核对创新主张、方法、证据和可复现性，披露利益冲突。';
    const { review: assigned } = workflow.requestReview(request.ownerId, request.researchId, { reviewerId: userId, focus });
    request.status = 'claimed'; request.reviewerId = userId; request.reviewId = assigned.id;
    store.run('UPDATE attention_requests SET data=? WHERE id=?', JSON.stringify(request), request.id);
    return { review: assigned, attention: request };
  }
  function checkAttentionSubmission(userId, reviewId) {
    const request = store.one("SELECT id FROM attention_requests WHERE json_extract(data,'$.reviewId')=? OR json_extract(data,'$.priorGateReviewId')=?", reviewId, reviewId);
    if (request && !eligibility(userId).eligible) fail(403, '审稿资格已过期或不满足 750 分门槛，请先重新核验身份。');
  }
  function reviewCredentials() { return dual.configuration(); }
  return { snapshot, publish, review, detail, eligibility, claimAttention, checkAttentionSubmission, reviewCredentials };
}
