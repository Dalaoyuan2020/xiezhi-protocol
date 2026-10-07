import { field, fail, id, digest } from './store.mjs';
import { archiveDelivery, checkedBytes, discardArchive, checkStorageQuota } from './research-service.mjs';
import path from 'node:path';

const parse = row => JSON.parse(row.data);
const outcomes = new Set(['supports', 'differs', 'inconclusive']);
export function normalizeWorkflowActor(userId, actor) {
  if (actor == null) return null;
  if (actor.type !== 'agent' || actor.guarantorId !== userId) fail(403, 'Agent 必须由当前担保人授权。');
  const name = field(actor.name, 'Agent 名称', 1, 80);
  return { type: 'agent', agentId: field(actor.agentId, 'Agent 编号', 1, 100), name, label: 'agent:' + name,
    guarantorId: userId, guarantorName: field(actor.guarantorName, '担保人姓名', 1, 80) };
}
export function createWorkflow(store, auth, research, { dataDir } = {}) {
  let acceptanceHandler = null;
  function setAcceptanceHandler(handler) { if (typeof handler !== 'function') throw new TypeError('Acceptance handler must be a function'); acceptanceHandler = handler; }
  function withAcceptedPoints(result) {
    if (result.contribution && acceptanceHandler) result.pointsAward = acceptanceHandler(result);
    return result;
  }
  const user = value => auth.userById(field(value, '协作者账号', 1, 100)) || fail(400, '指定的协作者尚未注册。');
  function taskRow(userId, taskId) {
    const row = store.one('SELECT * FROM tasks WHERE id=?', taskId);
    if (!row) fail(404, '任务不存在。');
    if (![row.owner_id, row.executor_id, row.verifier_id].includes(userId)) fail(403, '只有本任务参与者可以访问。');
    return row;
  }
  function tasks(userId) { return store.all('SELECT data FROM tasks WHERE owner_id=? OR executor_id=? OR verifier_id=? ORDER BY rowid DESC', userId, userId, userId).map(parse); }
  function reviews(userId) { return store.all('SELECT data FROM reviews WHERE owner_id=? OR reviewer_id=? ORDER BY rowid DESC', userId, userId).map(parse); }
  function contributions(userId) {
    return store.all('SELECT c.data FROM contributions c JOIN tasks t ON t.id=c.task_id WHERE t.owner_id=? OR t.executor_id=? OR t.verifier_id=? ORDER BY c.rowid DESC', userId, userId, userId).map(parse);
  }
  function researchDetail(userId, researchId) {
    const r = research.present(research.row(userId, researchId));
    return { research: r, assessment: research.latestAssessment(researchId), reviews: reviews(userId).filter(v => v.researchId === researchId), tasks: tasks(userId).filter(t => t.researchId === researchId),
      events: store.all('SELECT data FROM events WHERE research_id=? ORDER BY rowid', researchId).map(parse),
      permissions: { canAssess: true, canRequestReview: r.ownerId === userId, canCreateTask: r.ownerId === userId, canReadMaterials: true } };
  }
  function requestReview(userId, researchId, payload) {
    return store.transaction(() => {
      const r = research.present(research.row(userId, researchId, true));
      const reviewer = user(payload.reviewerId);
      if (reviewer.id === userId) fail(400, '请指定另一位用户审阅自己的研究。');
      const focus = field(payload.focus, '审阅重点', 3, 4000);
      const pending = store.all('SELECT data FROM reviews WHERE research_id=? AND reviewer_id=?', researchId, reviewer.id).map(parse).find(v => v.status === 'requested');
      if (pending) fail(409, '已有等待该用户处理的审阅请求。');
      const review = { id: id('review'), researchId, researchTitle: r.title, researchHash: r.rootHash, ownerId: userId, reviewerId: reviewer.id, reviewerName: reviewer.displayName, focus, status: 'requested', createdAt: new Date().toISOString() };
      store.run('INSERT INTO reviews(id,research_id,owner_id,reviewer_id,data) VALUES(?,?,?,?,?)', review.id, researchId, userId, reviewer.id, JSON.stringify(review));
      store.event(researchId, userId, 'review-requested', { reviewId: review.id, reviewerId: reviewer.id });
      return { review };
    });
  }
  function submitReview(userId, reviewId, payload) {
    return store.transaction(() => {
      const row = store.one('SELECT * FROM reviews WHERE id=?', reviewId);
      if (!row) fail(404, '审阅请求不存在。');
      if (row.reviewer_id !== userId) fail(403, '只有指定审阅人可以提交这份意见。');
      const review = parse(row);
      if (review.status !== 'requested') fail(409, '该意见已归档，不可覆盖已有审阅。');
      const report = {};
      for (const key of ['originality','methodology','evidence','limitations']) report[key] = field(payload[key], key, 10, 20000);
      if (typeof payload.conflictOfInterest !== 'boolean' || !['recommend','revise','decline'].includes(payload.verdict)) fail(400, '请明确利益冲突声明和审阅建议。');
      Object.assign(report, { conflictOfInterest: payload.conflictOfInterest, verdict: payload.verdict });
      Object.assign(review, { report, reportHash: digest(report), status: 'submitted', submittedAt: new Date().toISOString() });
      store.run('UPDATE reviews SET data=? WHERE id=?', JSON.stringify(review), review.id);
      store.event(review.researchId, userId, 'review-submitted', { reviewId, reportHash: review.reportHash });
      return { review };
    });
  }
  function createTask(userId, payload) {
    return store.transaction(() => {
      const r = research.present(research.row(userId, field(payload.researchId, '研究编号', 1, 100), true));
      const executor = user(payload.executorId); const verifier = user(payload.verifierId);
      if (new Set([userId, executor.id, verifier.id]).size !== 3) fail(400, '作者、执行者和核查者必须为三个不同账号。');
      if (!['reproduction','evidence-review','maintenance'].includes(payload.kind)) fail(400, '任务类型不支持。');
      const terms = { researchId: r.id, researchHash: r.rootHash, ownerId: userId, executorId: executor.id, verifierId: verifier.id,
        title: field(payload.title, '任务标题', 3, 240), kind: payload.kind, requirements: field(payload.requirements, '交付要求', 10, 20000), acceptanceCriteria: field(payload.acceptanceCriteria, '验收条件', 10, 20000) };
      const task = { id: id('task'), ...terms, researchTitle: r.title, executorName: executor.displayName, verifierName: verifier.displayName,
        termsHash: digest(terms), status: 'open', createdAt: new Date().toISOString(), compensation: { type: 'unpaid', paymentStatus: 'not-applicable' } };
      store.run('INSERT INTO tasks(id,research_id,owner_id,executor_id,verifier_id,data) VALUES(?,?,?,?,?,?)', task.id, r.id, userId, executor.id, verifier.id, JSON.stringify(task));
      store.event(r.id, userId, 'task-created', { taskId: task.id, termsHash: task.termsHash });
      return { task };
    });
  }
  function saveTask(task) { store.run('UPDATE tasks SET data=? WHERE id=?', JSON.stringify(task), task.id); }
  function claim(userId, taskId, actor) {
    const provenance = normalizeWorkflowActor(userId, actor);
    return store.transaction(() => {
      const task = parse(taskRow(userId, taskId));
      if (task.executorId !== userId) fail(403, '只有指定的执行者可以领取。');
      if (task.status !== 'open') fail(409, '任务已领取或已进入后续阶段。');
      Object.assign(task, { status: 'claimed', claimedAt: new Date().toISOString(), ...(provenance ? { claimedBy: provenance } : {}) }); saveTask(task);
      store.event(task.researchId, userId, 'task-claimed', { taskId, ...(provenance ? { actor: provenance } : {}) });
      return { task };
    });
  }
  async function deliver(userId, taskId, payload, actor) {
    const provenance = normalizeWorkflowActor(userId, actor);
    const original = parse(taskRow(userId, taskId));
    if (original.executorId !== userId) fail(403, '只有指定执行者可以提交交付。');
    if (!['claimed','revision_requested'].includes(original.status)) fail(409, '请先领取任务，或等待要求补充的决定。');
    const summary = field(payload.summary, '工作报告', 10, 20000);
    const environment = field(payload.environment ?? '', '运行环境', 0, 10000);
    const commands = field(payload.commands ?? '', '执行命令', 0, 10000);
    if (!outcomes.has(payload.outcome)) fail(400, '请说明提交者观察到的结果。');
    checkStorageQuota(store, userId);
    if (store.one('SELECT count(*) AS count FROM deliveries WHERE task_id=?', taskId).count >= 50) fail(409, '单任务最多归档 50 次交付。');
    const archive = await archiveDelivery(dataDir, payload.files);
    try { return store.transaction(() => {
      checkStorageQuota(store, userId, archive.files.reduce((sum, file) => sum + file.bytes, 0));
      const task = parse(taskRow(userId, taskId));
      if (task.status !== original.status || task.latestDeliveryId !== original.latestDeliveryId) fail(409, '任务已变化，请刷新后再提交。');
      const content = { taskId, termsHash: task.termsHash, submitterId: userId, summary, environment, commands, outcome: payload.outcome, files: archive.files, ...(provenance ? { actor: provenance } : {}) };
      const delivery = { id: id('delivery'), ...content, rootHash: digest(content), executionSource: 'submitter-reported', createdAt: new Date().toISOString() };
      store.run('INSERT INTO deliveries(id,task_id,data,archive) VALUES(?,?,?,?)', delivery.id, taskId, JSON.stringify(delivery), path.basename(archive.directory));
      Object.assign(task, { status: 'submitted', latestDeliveryId: delivery.id }); saveTask(task);
      store.event(task.researchId, userId, 'delivery-submitted', { taskId, deliveryId: delivery.id, deliveryHash: delivery.rootHash, ...(provenance ? { actor: provenance } : {}) });
      return { task, delivery };
    }); } catch (error) { await discardArchive(archive.directory, path.join(dataDir, 'deliveries')); throw error; }
  }
  function verify(userId, taskId, payload) {
    return store.transaction(() => {
      const task = parse(taskRow(userId, taskId));
      if (task.verifierId !== userId) fail(403, '只有指定的独立核查者可以验收。');
      if (!['accept','revise','reject'].includes(payload.decision) || !outcomes.has(payload.finding)) fail(400, '核查决定或科学结果无效。');
      if (task.status === 'accepted' && payload.decision === 'accept' && payload.deliveryId === task.latestDeliveryId) {
        return withAcceptedPoints({ task, verification: parse(store.one('SELECT data FROM verifications WHERE delivery_id=?', payload.deliveryId)), contribution: parse(store.one('SELECT data FROM contributions WHERE task_id=?', taskId)) });
      }
      if (task.status !== 'submitted' || payload.deliveryId !== task.latestDeliveryId) fail(409, '核查必须针对最新的待验收交付；旧结果不能复用。');
      const delivery = parse(store.one('SELECT data FROM deliveries WHERE id=? AND task_id=?', payload.deliveryId, taskId));
      const note = field(payload.note, '核查意见', 10, 20000);
      if (!Array.isArray(payload.checkedFiles) || !payload.checkedFiles.length || payload.checkedFiles.length > 100 || new Set(payload.checkedFiles).size !== payload.checkedFiles.length || !payload.checkedFiles.every(p => typeof p === 'string' && delivery.files.some(f => f.path === p))) fail(400, '请列出实际核查的交付文件，路径必须属于本次交付且不可重复。');
      const verification = { id: id('verification'), taskId, deliveryId: delivery.id, deliveryHash: delivery.rootHash, verifierId: userId, decision: payload.decision, finding: payload.finding, note, checkedFiles: [...payload.checkedFiles], createdAt: new Date().toISOString() };
      verification.receiptHash = digest(verification);
      store.run('INSERT INTO verifications(id,task_id,delivery_id,data) VALUES(?,?,?,?)', verification.id, taskId, delivery.id, JSON.stringify(verification));
      task.status = { accept: 'accepted', revise: 'revision_requested', reject: 'rejected' }[payload.decision];
      task.scientificFinding = payload.finding;
      task.lastVerificationId = verification.id;
      saveTask(task);
      let contribution;
      if (payload.decision === 'accept') {
        contribution = { id: id('contribution'), taskId, researchId: task.researchId, userId: task.executorId, verifierId: userId, deliveryId: delivery.id, deliveryHash: delivery.rootHash, verificationId: verification.id, verificationHash: verification.receiptHash, termsHash: task.termsHash, kind: task.kind, createdAt: new Date().toISOString(), ...(delivery.actor ? { actor: delivery.actor } : {}) };
        contribution.receiptHash = digest(contribution);
        store.run('INSERT INTO contributions(id,task_id,user_id,data) VALUES(?,?,?,?)', contribution.id, taskId, task.executorId, JSON.stringify(contribution));
      }
      store.event(task.researchId, userId, 'delivery-verified', { taskId, deliveryId: delivery.id, verificationId: verification.id, decision: payload.decision, finding: payload.finding, ...(contribution ? { contributionId: contribution.id } : {}) });
      return withAcceptedPoints({ task, verification, ...(contribution ? { contribution } : {}) });
    });
  }
  function detail(userId, taskId) {
    const task = parse(taskRow(userId, taskId));
    return { task, research: research.present(research.row(userId, task.researchId)), deliveries: store.all('SELECT data FROM deliveries WHERE task_id=? ORDER BY rowid', taskId).map(parse), verifications: store.all('SELECT data FROM verifications WHERE task_id=? ORDER BY rowid', taskId).map(parse), contributions: store.all('SELECT data FROM contributions WHERE task_id=?', taskId).map(parse),
      permissions: { canClaim: task.executorId === userId && task.status === 'open', canDeliver: task.executorId === userId && ['claimed','revision_requested'].includes(task.status), canVerify: task.verifierId === userId && task.status === 'submitted', canReadMaterials: true } };
  }
  async function deliveryFile(userId, deliveryId, filePath) {
    const row = store.one('SELECT * FROM deliveries WHERE id=?', deliveryId);
    if (!row) fail(404, '交付不存在。');
    taskRow(userId, row.task_id);
    const delivery = parse(row); const file = delivery.files.find(f => f.path === filePath);
    if (!file) fail(404, '交付中没有该文件。');
    const archiveName = path.basename(row.archive);
    if (!/^archive-[a-f0-9-]{36}$/.test(archiveName)) fail(409, '交付归档索引不合法。');
    return { file, bytes: await checkedBytes(path.join(dataDir, 'deliveries', archiveName), file) };
  }
  return { tasks, reviews, contributions, researchDetail, requestReview, submitReview, createTask, claim, deliver, verify, detail, deliveryFile, taskRow, setAcceptanceHandler };
}
