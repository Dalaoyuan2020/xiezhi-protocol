import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { field, fail, id, digest, hashBytes } from './store.mjs';
import { normalizeWorkflowActor } from './workflow.mjs';

const ANSWERS = new Set(['yes', 'no', 'unsure']);
const REWARDS = Object.freeze({ reproduction: 8, 'evidence-review': 3, maintenance: 2 });
const SETTLEMENT = 'offchain-pending';
const DEFAULT_SEEDS = new URL('../data/act-source-snapshots.json', import.meta.url);
const parse = row => row ? JSON.parse(row.data) : null;
const periodOf = date => new Date(new Date(date).getTime() + 8 * 3600000).toISOString().slice(0, 7);
const POLICY = Object.freeze({ microReward: 3, monthlyMicroLimit: 30, requiredPeople: 3, timezone: 'Asia/Shanghai', settlement: SETTLEMENT,
  notice: '廌点链下记账，待上链；不可转让、不可买卖。多数核对只记录参与者对公开材料的判断，不证明真实身份或科研结论。' });

export function loadActSeedFile(file = DEFAULT_SEEDS) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('Act 种子版本或结构不正确。');
  return data.tasks;
}

function sourceUrl(value) {
  const text = field(value, '证据链接', 10, 600);
  let url; try { url = new URL(text); } catch { fail(400, '证据链接不合法。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !['api.openalex.org', 'openalex.org', 'api.crossref.org', 'doi.org', 'orcid.org', 'pub.orcid.org'].includes(url.hostname)) fail(400, '证据须为不带凭据的规范公开来源链接。');
  return url.href;
}

function subjectOf(value) {
  if (value.kind === 'reference-doi-check') {
    const doi = normalizedDoi(value.subject?.doi);
    if (!doi) fail(400, '参考文献核对必须包含规范 DOI。');
    return { doi };
  }
  const authorId = value.subject?.authorId || value.evidence?.map(e => /^https:\/\/api\.openalex\.org\/authors\/(A\d+)$/.exec(e.url || '')?.[1]).find(Boolean);
  const workId = value.subject?.workId || value.evidence?.map(e => /^https:\/\/api\.openalex\.org\/works\/(W\d+)$/.exec(e.url || '')?.[1]).find(Boolean);
  if (!/^A\d+$/.test(authorId || '') || !/^W\d+$/.test(workId || '')) fail(400, '微任务必须明确公开论文编号与目标作者编号。');
  return { authorId, workId };
}
const semanticKey = subject => subject.doi ? digest({ kind: 'crossref-doi-check', doi: subject.doi }) : digest({ kind: 'openalex-authorship', authorId: subject.authorId, workId: subject.workId });
function normalizedDoi(value) {
  if (typeof value !== 'string' || value.length > 240) return null;
  const doi = value.trim().toLowerCase();
  return /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/.test(doi) ? doi : null;
}
function referenceDois(files) {
  const result = new Set();
  let remaining = 256 * 1024;
  // Inspect only bounded text supplied by the verified archive loader. No PDF
  // parser, script execution, filename or surrounding manuscript text is sent.
  for (const file of files) {
    if (file.binary || typeof file.text !== 'string' || remaining <= 0) continue;
    const text = file.text.slice(0, remaining); remaining -= text.length;
    for (const match of text.matchAll(/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi)) {
      // Skip uncommon suffixes rather than truncating them into a false 404.
      if (/[<>%+?=#]/.test(text[match.index + match[0].length] || '\n')) continue;
      let candidate = match[0].replace(/[.,;:]+$/, '');
      while (candidate.endsWith(')') && (candidate.match(/\)/g)?.length || 0) > (candidate.match(/\(/g)?.length || 0)) candidate = candidate.slice(0, -1);
      const doi = normalizedDoi(candidate);
      if (doi) result.add(doi);
      if (result.size === 3) return [...result];
    }
  }
  return [...result];
}
async function boundedResponseBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('response-too-large');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) { void reader.cancel().catch(() => {}); throw new Error('response-too-large'); }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function knownAnswerOf(task) {
  const evidence = task.evidence.find(item => item.url === `https://api.openalex.org/works/${task.subject.workId}`);
  if (!evidence) return null;
  let snapshot; try { snapshot = JSON.parse(evidence.excerpt); } catch { return null; }
  if (snapshot.workId !== task.subject.workId || digest(snapshot) !== evidence.snapshotHash || !Array.isArray(snapshot.authors) || snapshot.authors.length < 1 || snapshot.authors.length > 30 ||
      !snapshot.authors.every(author => /^A\d+$/.test(author.id || '') && typeof author.name === 'string')) return null;
  return snapshot.authors.some(author => author.id === task.subject.authorId) ? 'yes' : 'no';
}

function checkedSeed(value, allowFixtureGold) {
  if (value?.kind === 'reference-doi-check') fail(400, 'DOI 核对题只由授权公开版本的真实 Crossref 检查生成。');
  if (!value || typeof value !== 'object' || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 5) fail(400, '微任务必须附可核对来源。');
  const evidence = value.evidence.map(item => {
    const retrievedAt = new Date(item.retrievedAt).toISOString();
    if (!/^[a-f0-9]{64}$/.test(item.snapshotHash || '')) fail(400, '证据快照指纹无效。');
    return { url: sourceUrl(item.url), label: field(item.label, '来源标题', 1, 200), retrievedAt,
      timestampBasis: field(item.timestampBasis || 'source-retrieval', '时间依据', 1, 160), snapshotHash: item.snapshotHash,
      excerpt: field(item.excerpt, '证据摘录', 10, 12000) };
  });
  const subject = subjectOf(value);
  const task = { type: 'micro', source: 'public-record-snapshot', kind: 'bibliography-check', subject, title: field(value.title, '任务标题', 3, 240),
    prompt: field(value.prompt, '核对问题', 10, 4000), evidence, reward: 3, status: 'open', result: null,
    createdAt: new Date(value.createdAt || evidence[0].retrievedAt).toISOString() };
  const fixtureGold = allowFixtureGold ? value.goldAnswer ?? null : null;
  if (fixtureGold !== null && !['yes', 'no'].includes(fixtureGold)) fail(400, '暗题必须有明确证据答案。');
  task.id = 'micro-' + semanticKey(subject).slice(0, 24);
  task.identityKey = semanticKey(subject);
  return { task, key: semanticKey(subject), knownAnswer: knownAnswerOf(task), fixtureGold };
}

// Offline by default. Rebuild from real local sources with:
// node aia/app/scripts/seed-act-tasks.mjs --from-cache --snapshot-only
// --refresh explicitly fetches at most three fixed OpenAlex endpoints. Import
// those snapshots with the seed script or restart. It is not an endless queue:
// repeated work/author pairs retain one task and cannot earn another reward.
// The server alone chooses hidden checks from verifiable snapshot membership.
export function createCommunityAct(store, auth, research, workflow, options = {}) {
  const now = options.now || (() => Date.now());
  const timestamp = () => new Date(now()).toISOString();
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS act_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, gold_answer TEXT CHECK(gold_answer IS NULL OR gold_answer IN ('yes','no')));
    CREATE TABLE IF NOT EXISTS act_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS act_task_keys (semantic_key TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES act_tasks(id));
    CREATE TABLE IF NOT EXISTS act_reference_runs (run_key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS act_reference_lookups (id TEXT PRIMARY KEY, run_key TEXT NOT NULL REFERENCES act_reference_runs(run_key), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS act_answers (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES act_tasks(id), user_id TEXT NOT NULL REFERENCES users(id), answer TEXT NOT NULL CHECK(answer IN ('yes','no','unsure')), data TEXT NOT NULL, UNIQUE(task_id,user_id));
    CREATE TABLE IF NOT EXISTS points_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, reference_id TEXT NOT NULL, task_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), period TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(user_id,kind,reference_id));
    CREATE INDEX IF NOT EXISTS points_ledger_user ON points_ledger(user_id,period);
  `);
  store.run('INSERT OR IGNORE INTO act_settings(name,value) VALUES(?,?)', 'gold-selection-key-v1', randomBytes(32).toString('hex'));
  const goldKey = Buffer.from(store.one('SELECT value FROM act_settings WHERE name=?', 'gold-selection-key-v1').value, 'hex');
  if (goldKey.length !== 32) throw new Error('Act 服务端核对配置无效。');
  // Preserve identifiers and prior rewards from deployments using snapshot IDs.
  // Duplicate historical rows remain archived, but only one canonical task is open.
  store.transaction(() => {
    for (const row of store.all('SELECT * FROM act_tasks ORDER BY rowid')) {
      const task = parse(row), subject = subjectOf(task);
      task.subject = subject;
      task.identityKey = semanticKey(subject);
      store.run('UPDATE act_tasks SET data=? WHERE id=?', JSON.stringify(task), row.id);
      store.run('INSERT OR IGNORE INTO act_task_keys(semantic_key,task_id) VALUES(?,?)', semanticKey(subject), row.id);
    }
  });
  const requireUser = userId => auth.userById(field(userId, '账号', 1, 100)) || fail(401, '请先登录自己的账号。');
  function seed(values) {
    if (!Array.isArray(values) || values.length > 500) fail(400, '单批最多导入 500 个有来源任务。');
    const allowFixtureGold = Object.hasOwn(options, 'seedTasks');
    const checked = values.map(value => checkedSeed(value, allowFixtureGold));
    const eligible = [...new Map(checked.filter(item => item.knownAnswer && !item.fixtureGold).map(item => [item.key, item])).values()];
    eligible.sort((a, b) => createHmac('sha256', goldKey).update(a.key).digest('hex').localeCompare(createHmac('sha256', goldKey).update(b.key).digest('hex')));
    const hiddenChecks = new Set(eligible.slice(0, Math.floor(eligible.length / 5)).map(item => item.key));
    return store.transaction(() => {
      let inserted = 0;
      for (const { task, key, knownAnswer, fixtureGold } of checked) {
        const existing = store.one('SELECT task_id FROM act_task_keys WHERE semantic_key=?', key);
        const goldAnswer = fixtureGold || (hiddenChecks.has(key) ? knownAnswer : null);
        if (existing) {
          // Legacy unattempted tasks adopt the private selection. Once anyone
          // answers, its quality-check policy never changes retroactively.
          if (!store.one('SELECT count(*) AS count FROM act_answers WHERE task_id=?', existing.task_id).count) store.run('UPDATE act_tasks SET gold_answer=? WHERE id=?', goldAnswer, existing.task_id);
          continue;
        }
        inserted += Number(store.run('INSERT OR IGNORE INTO act_tasks(id,data,gold_answer) VALUES(?,?,?)', task.id, JSON.stringify(task), goldAnswer).changes);
        store.run('INSERT OR IGNORE INTO act_task_keys(semantic_key,task_id) VALUES(?,?)', key, task.id);
      }
      return { inserted, total: store.one('SELECT count(*) AS count FROM act_tasks').count };
    });
  }
  function points(userId) {
    requireUser(userId);
    const period = periodOf(timestamp());
    return { balance: store.one('SELECT COALESCE(SUM(amount),0) AS total FROM points_ledger WHERE user_id=?', userId).total,
      monthlyMicroEarned: store.one("SELECT COALESCE(SUM(amount),0) AS total FROM points_ledger WHERE user_id=? AND kind='micro' AND period=?", userId, period).total,
      monthlyMicroLimit: 30, period, settlement: SETTLEMENT,
      ledger: store.all('SELECT data FROM points_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 50', userId).map(parse) };
  }
  function award({ userId, kind, referenceId, taskId, amount, evidenceHash, actor = null, reason }) {
    const existing = parse(store.one('SELECT data FROM points_ledger WHERE user_id=? AND kind=? AND reference_id=?', userId, kind, referenceId));
    if (existing) return existing;
    if (kind === 'micro') {
      const key = semanticKey(parse(store.one('SELECT data FROM act_tasks WHERE id=?', taskId)).subject);
      const prior = store.one("SELECT p.data FROM points_ledger p JOIN act_tasks t ON t.id=p.task_id WHERE p.user_id=? AND p.kind='micro' AND json_extract(t.data,'$.identityKey')=? LIMIT 1", userId, key);
      if (prior) return parse(prior);
    }
    const createdAt = timestamp(), period = periodOf(createdAt);
    if (kind === 'micro') {
      const used = store.one("SELECT COALESCE(SUM(amount),0) AS total FROM points_ledger WHERE user_id=? AND kind='micro' AND period=?", userId, period).total;
      if (used + amount > 30) return null;
    }
    const entry = { id: id('zhidian'), userId, kind, referenceId, taskId, amount, evidenceHash, actor, reason, createdAt, period, settlement: SETTLEMENT };
    store.run('INSERT INTO points_ledger(id,user_id,kind,reference_id,task_id,amount,period,data) VALUES(?,?,?,?,?,?,?,?)', entry.id, userId, kind, referenceId, taskId, amount, period, JSON.stringify(entry));
    return entry;
  }
  function safeTask(row, userId) {
    const { identityKey, ...data } = parse(row);
    const answerCount = store.one('SELECT count(*) AS count FROM act_answers WHERE task_id=?', row.id).count;
    const own = userId ? parse(store.one('SELECT data FROM act_answers WHERE task_id=? AND user_id=?', row.id, userId)) : null;
    return { ...data, answerCount, slotsRemaining: Math.max(0, 3 - answerCount),
      myAnswer: own ? { id: own.id, answer: own.answer, reason: own.reason, actor: own.actor, createdAt: own.createdAt } : null,
      canAnswer: Boolean(userId && !own && data.status === 'open' && answerCount < 3) };
  }
  function task(userId, taskId) {
    if (userId) requireUser(userId);
    const row = store.one('SELECT * FROM act_tasks WHERE id=?', field(taskId, '任务编号', 1, 100));
    if (!row) fail(404, '公开微任务不存在。');
    if (store.one('SELECT task_id FROM act_task_keys WHERE semantic_key=?', semanticKey(parse(row).subject))?.task_id !== row.id) fail(409, '该记录已有同题归档，请返回任务池查看。');
    return { task: safeTask(row, userId) };
  }
  function snapshot(userId = null) {
    if (userId) requireUser(userId);
    const paperTasks = userId ? workflow.tasks(userId).map(item => ({ id: item.id, type: 'paper', title: item.title, kind: item.kind, status: item.status,
      reward: REWARDS[item.kind] || 0, createdAt: item.createdAt, visibility: 'participants-only', source: 'existing-workflow' })) : [];
    return { tasks: store.all('SELECT t.* FROM act_tasks t JOIN act_task_keys k ON k.task_id=t.id ORDER BY t.rowid LIMIT 100').map(row => safeTask(row, userId)), paperTasks,
      points: userId ? points(userId) : null, policy: POLICY };
  }
  function answer(userId, taskId, payload, actor) {
    requireUser(userId);
    if (!payload || !ANSWERS.has(payload.answer)) fail(400, '请选择是、否或不确定。');
    const reason = field(payload.reason, '核对依据', 10, 2000);
    const provenance = normalizeWorkflowActor(userId, actor);
    return store.transaction(() => {
      const row = store.one('SELECT * FROM act_tasks WHERE id=?', field(taskId, '任务编号', 1, 100));
      if (!row) fail(404, '公开微任务不存在。');
      const data = parse(row);
      if (store.one('SELECT task_id FROM act_task_keys WHERE semantic_key=?', semanticKey(data.subject))?.task_id !== row.id) fail(409, '该记录已有同题归档，请返回任务池查看。');
      const existing = store.one("SELECT a.id FROM act_answers a JOIN act_tasks t ON t.id=a.task_id WHERE a.user_id=? AND json_extract(t.data,'$.identityKey')=? LIMIT 1", userId, semanticKey(data.subject));
      if (existing) fail(409, '同一担保人对同一任务只能提交一次，人和其授权 Agent 共用一个名额。');
      if (data.status !== 'open' || store.one('SELECT count(*) AS count FROM act_answers WHERE task_id=?', taskId).count >= 3) fail(409, '本题已收齐三位参与者的回答。');
      const record = { id: id('act-answer'), taskId, userId, answer: payload.answer, reason, actor: provenance, createdAt: timestamp() };
      store.run('INSERT INTO act_answers(id,task_id,user_id,answer,data) VALUES(?,?,?,?,?)', record.id, taskId, userId, record.answer, JSON.stringify(record));
      const replies = store.all('SELECT data FROM act_answers WHERE task_id=? ORDER BY rowid', taskId).map(parse);
      if (replies.length === 3) {
        const majority = ['yes', 'no'].find(choice => replies.filter(reply => reply.answer === choice).length >= 2) || null;
        Object.assign(data, { status: majority ? 'resolved' : 'inconclusive', result: majority, resolvedAt: timestamp(), conclusionMeaning: data.kind === 'reference-doi-check' ? '三位独立担保人对文献能否定位的核对；Crossref 未收录不证明文献不存在或学术不端。' : '三位独立担保人的公开记录核对，不等同学术身份认证。' });
        store.run('UPDATE act_tasks SET data=? WHERE id=?', JSON.stringify(data), taskId);
        const evidenceHash = digest({ taskId, sources: data.evidence.map(e => e.snapshotHash), answers: replies, result: majority });
        for (const reply of replies) if (majority && reply.answer === majority && (!row.gold_answer || reply.answer === row.gold_answer)) {
          award({ userId: reply.userId, kind: 'micro', referenceId: taskId, taskId, amount: 3, evidenceHash, actor: reply.actor, reason: '公开记录核对经三人多数确认' });
        }
      }
      return { task: safeTask(store.one('SELECT * FROM act_tasks WHERE id=?', taskId), userId), answer: { id: record.id, answer: record.answer, reason, actor: record.actor, createdAt: record.createdAt }, points: points(userId) };
    });
  }
  const pendingReferenceChecks = new Set();
  const referenceFetch = options.referenceFetch || globalThis.fetch;
  const referenceTimeoutMs = Math.min(10000, Math.max(10, Number(options.referenceTimeoutMs) || 6000));
  function publicationMatches(userId, researchId, rootHash) {
    if (!store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='community_publications'")) return false;
    const record = store.one('SELECT owner_id,data FROM research WHERE id=?', researchId);
    const publication = parse(store.one('SELECT data FROM community_publications WHERE research_id=?', researchId));
    return Boolean(record?.owner_id === userId && parse(record)?.rootHash === rootHash && publication?.researchHash === rootHash && publication?.allowReferenceTasks === true);
  }
  function persistReferenceTask(lookupId) {
    // This is deliberately private: neither a seed file nor an HTTP payload may
    // supply an alleged 404. Read only a completed, server-produced lookup.
    const lookup = parse(store.one('SELECT data FROM act_reference_lookups WHERE id=?', lookupId));
    if (!lookup || lookup.httpStatus !== 404 || lookup.state !== 'not-found' ||
        hashBytes(Buffer.from(lookup.responseBase64, 'base64')) !== lookup.responseSha256) return false;
    const subject = { doi: lookup.doi }, key = semanticKey(subject);
    if (store.one('SELECT task_id FROM act_task_keys WHERE semantic_key=?', key)) return false;
    const snapshot = { doi: lookup.doi, sourceUrl: lookup.sourceUrl, httpStatus: 404, checkedAt: lookup.checkedAt, responseSha256: lookup.responseSha256 };
    const task = { id: 'micro-' + key.slice(0, 24), identityKey: key, type: 'micro', kind: 'reference-doi-check', source: 'crossref-http-check', subject,
      title: `参考文献待核对 · ${lookup.doi}`,
      prompt: `DOI ${lookup.doi} 在所列检查时间由 Crossref 返回 HTTP 404。请通过 DOI 注册页、出版机构等公开来源核对：能否定位到该 DOI 对应的文献？能定位选“是”，核对后仍无法定位选“否”，材料不足选“不确定”，并写明来源。404 只表示本次 Crossref 查询未找到记录，不代表文献不存在或造假。`,
      evidence: [{ url: lookup.sourceUrl, label: 'Crossref 单 DOI 查询（HTTP 404）', retrievedAt: lookup.checkedAt,
        timestampBasis: 'server HTTP response received', httpStatus: 404, responseSha256: lookup.responseSha256, snapshotHash: digest(snapshot), excerpt: JSON.stringify(snapshot) },
      { url: `https://doi.org/${encodeURIComponent(lookup.doi)}`, label: 'DOI 注册解析入口（供人工核对，未自动验证）', retrievedAt: lookup.checkedAt,
        timestampBasis: 'reference link, not a retrieved snapshot', snapshotHash: digest({ doi: lookup.doi }), excerpt: '此链接仅作为人工继续核对的入口，系统没有声称它已成功解析。' }],
      reward: 3, status: 'open', result: null, createdAt: lookup.checkedAt };
    store.run('INSERT OR IGNORE INTO act_tasks(id,data,gold_answer) VALUES(?,?,NULL)', task.id, JSON.stringify(task));
    store.run('INSERT OR IGNORE INTO act_task_keys(semantic_key,task_id) VALUES(?,?)', key, task.id);
    return true;
  }
  async function lookupReference(doi, runKey) {
    const sourceUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const controller = new AbortController();
    let timer, httpStatus = null;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('request-timeout')); }, referenceTimeoutMs); });
    const lookup = { id: id('reference-check'), doi, sourceUrl, checkedAt: timestamp(), httpStatus: null, state: 'request-failed' };
    try {
      const result = await Promise.race([deadline, (async () => {
        const response = await referenceFetch(sourceUrl, { method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'AIA-ReferenceCheck/1.0' } });
        httpStatus = Number.isInteger(response.status) ? response.status : null;
        if (response.url && response.url !== sourceUrl) throw new Error('unexpected-response-url');
        const bytes = await boundedResponseBytes(response, 64 * 1024);
        return { bytes, httpStatus };
      })()]);
      Object.assign(lookup, { checkedAt: timestamp(), httpStatus: result.httpStatus,
        state: result.httpStatus === 404 ? 'not-found' : result.httpStatus === 200 ? 'found' : 'upstream-unavailable',
        responseSha256: hashBytes(result.bytes), responseBase64: result.bytes.toString('base64') });
    } catch (error) {
      controller.abort();
      Object.assign(lookup, { checkedAt: timestamp(), httpStatus, state: controller.signal.aborted && error.message === 'request-timeout' ? 'timeout' : 'request-failed' });
    } finally { clearTimeout(timer); }
    // Raw bytes, including unsuccessful responses, stay in this private table;
    // public tasks receive only DOI, timestamp, HTTP status and fingerprints.
    store.run('INSERT INTO act_reference_lookups(id,run_key,data) VALUES(?,?,?)', lookup.id, runKey, JSON.stringify(lookup));
    return lookup;
  }
  async function runReferenceChecks(run) {
    try {
      if (!publicationMatches(run.userId, run.researchId, run.rootHash)) { run.status = 'cancelled'; return; }
      const artifact = await research.artifactForReview(run.userId, run.researchId);
      if (artifact.rootHash !== run.rootHash || !publicationMatches(run.userId, run.researchId, run.rootHash)) { run.status = 'cancelled'; return; }
      const dois = referenceDois(artifact.files);
      run.status = 'completed';
      for (const doi of dois) {
        if (!publicationMatches(run.userId, run.researchId, run.rootHash)) { run.status = 'cancelled'; break; }
        if (store.one('SELECT task_id FROM act_task_keys WHERE semantic_key=?', semanticKey({ doi }))) continue;
        const lookup = await lookupReference(doi, run.key);
        run.checked += 1;
        if (!publicationMatches(run.userId, run.researchId, run.rootHash)) { run.status = 'cancelled'; break; }
        if (lookup.state === 'not-found') store.transaction(() => {
          if (publicationMatches(run.userId, run.researchId, run.rootHash) && persistReferenceTask(lookup.id)) run.inserted += 1;
        });
        // Crossref requests clients to back off on 429. Do not continue the batch
        // or relabel rate limiting, timeouts or service errors as missing DOIs.
        if (lookup.httpStatus === 429 || lookup.state === 'timeout') break;
      }
    } catch { run.status = 'failed'; }
    finally {
      run.finishedAt = timestamp();
      store.run('UPDATE act_reference_runs SET data=? WHERE run_key=?', JSON.stringify(run), run.key);
    }
  }
  // Explicit opt-in only. Called after community.publish persists
  // allowReferenceTasks:true for this exact research hash. The return is
  // synchronous; all archive loading and at most three DOI GETs run afterwards.
  // Four jobs at most; each response <=64 KiB, each request <=10 s, scan <=256K
  // text characters. No automatic retry, broad bibliography crawl or parsing
  // of binary files. Re-publishing the same version never reissues the batch.
  // Reference DOI identity is global, so the same DOI cannot earn +3 twice.
  function scheduleReferenceChecks(userId, researchId) {
    requireUser(userId);
    const record = parse(research.row(userId, field(researchId, '研究编号', 1, 100), true));
    if (!publicationMatches(userId, researchId, record.rootHash)) return { scheduled: false, reason: 'not-authorized' };
    const key = digest({ kind: 'crossref-reference-run', researchId, rootHash: record.rootHash });
    if (store.one('SELECT run_key FROM act_reference_runs WHERE run_key=?', key)) return { scheduled: false, reason: 'already-scheduled' };
    if (pendingReferenceChecks.size >= 4) return { scheduled: false, reason: 'busy' };
    const run = { key, userId, researchId, rootHash: record.rootHash, status: 'scheduled', checked: 0, inserted: 0, createdAt: timestamp() };
    store.run('INSERT INTO act_reference_runs(run_key,data) VALUES(?,?)', key, JSON.stringify(run));
    const job = Promise.resolve().then(() => runReferenceChecks(run));
    pendingReferenceChecks.add(job);
    void job.finally(() => pendingReferenceChecks.delete(job)).catch(() => {});
    return { scheduled: true };
  }
  async function whenIdle() { while (pendingReferenceChecks.size) await Promise.allSettled([...pendingReferenceChecks]); }
  // Called inside workflow.verify's transaction, or wrapped by the public helper.
  function acceptedPoints(result) {
    const contributionId = result?.contribution?.id;
    const contribution = parse(store.one('SELECT data FROM contributions WHERE id=?', contributionId || ''));
    if (!contribution) fail(409, '只有已验收并归档的贡献可以记账。');
    const task = parse(store.one('SELECT data FROM tasks WHERE id=?', contribution.taskId));
    const verification = parse(store.one('SELECT data FROM verifications WHERE id=?', contribution.verificationId));
    if (!task || task.status !== 'accepted' || !verification || verification.decision !== 'accept' || task.lastVerificationId !== verification.id ||
      new Set([task.ownerId, task.executorId, task.verifierId]).size !== 3 || contribution.userId !== task.executorId || verification.verifierId !== task.verifierId) fail(409, '贡献必须经过作者、执行者、核查者三人分离验收。');
    const amount = REWARDS[task.kind];
    if (!amount) return null;
    return award({ userId: contribution.userId, kind: task.kind, referenceId: contribution.id, taskId: task.id, amount, evidenceHash: contribution.receiptHash,
      actor: contribution.actor || null, reason: task.kind === 'reproduction' ? '独立复现工作验收通过' : task.kind === 'evidence-review' ? '证据核对工作验收通过' : '运维工作验收通过' });
  }
  function awardContribution(result) { return store.transaction(() => acceptedPoints(result)); }
  workflow.setAcceptanceHandler(acceptedPoints);
  seed(options.seedTasks ?? loadActSeedFile(options.seedFile));
  return { snapshot, task, answer, points, seed, awardContribution, scheduleReferenceChecks, whenIdle };
}
