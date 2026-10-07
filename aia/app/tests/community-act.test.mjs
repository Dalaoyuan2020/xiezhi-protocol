import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore, digest } from '../lib/store.mjs';
import { createAuth } from '../lib/auth.mjs';
import { createResearchService } from '../lib/research-service.mjs';
import { createWorkflow } from '../lib/workflow.mjs';
import { createCommunityAct, loadActSeedFile } from '../lib/community-act.mjs';
import { buildActSeeds } from '../scripts/seed-act-tasks.mjs';

const reason = '逐项核对了公开快照中的作者编号和完整列表。';
const seed = (index, goldAnswer) => ({ subject: { authorId: 'A' + (100000 + index), workId: 'W2969480053' }, title: `公开记录核对 ${index}`, prompt: `请核对编号 ${index} 所指的公开作者列表，并说明所检查的证据。`,
  evidence: [{ url: 'https://api.openalex.org/works/W2969480053', label: 'OpenAlex 公开论文记录', retrievedAt: '2026-10-07T13:27:39.137Z', snapshotHash: digest({ fixture: index }), excerpt: '测试中的明确来源材料，不是产品启动时使用的真实种子。' }],
  ...(goldAnswer ? { goldAnswer } : {}) });
const agent = user => ({ type: 'agent', agentId: 'agent-one', name: '核对助手', label: 'ignored client label', guarantorId: user, guarantorName: user });

async function setup(t, seeds = [seed(1)], options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-act-'));
  const store = openStore(dataDir);
  t.after(async () => { await act.whenIdle(); store.close(); assert.ok(path.basename(dataDir).startsWith('aia-act-')); await rm(dataDir, { recursive: true, force: true }); });
  const users = {};
  for (const name of ['a', 'b', 'c', 'd']) {
    const user = { id: 'user-' + name, username: name, displayName: name, profile: {}, createdAt: '2026-10-07T00:00:00.000Z' };
    users[name] = user;
    store.run('INSERT INTO users(id,username,password_hash,data) VALUES(?,?,?,?)', user.id, name, 'test-only-unusable-password', JSON.stringify(user));
  }
  const auth = createAuth(store), research = createResearchService(store, auth, { dataDir }), workflow = createWorkflow(store, auth, research, { dataDir });
  const act = createCommunityAct(store, auth, research, workflow, { seedTasks: seeds, now: () => Date.parse('2026-10-08T01:00:00Z'), ...options });
  return { dataDir, store, auth, research, workflow, act, users };
}
function vote(act, user, task, answer = 'yes', actor) { return act.answer(user.id || user, task.id || task, { answer, reason }, actor); }

test('micro tasks reserve one slot per guarantor and settle only after three independent people', async t => {
  const { act, users } = await setup(t);
  const task = act.snapshot().tasks[0];
  assert.equal(act.snapshot().points, null); assert.equal(task.canAnswer, false);
  const first = vote(act, users.a, task, 'yes', agent(users.a.id));
  assert.equal(first.points.balance, 0); assert.equal(first.task.answerCount, 1);
  assert.equal(first.answer.actor.label, 'agent:核对助手');
  assert.throws(() => vote(act, users.a, task), error => error.status === 409);
  assert.throws(() => vote(act, users.b, task, 'yes', agent(users.a.id)), error => error.status === 403);
  assert.equal(act.task(users.b.id, task.id).task.myAnswer, null);
  assert.equal(vote(act, users.b, task).points.balance, 0);
  const result = vote(act, users.c, task, 'no');
  assert.equal(result.task.status, 'resolved'); assert.equal(result.task.result, 'yes');
  assert.equal(act.points(users.a.id).balance, 3); assert.equal(act.points(users.b.id).balance, 3); assert.equal(result.points.balance, 0);
  assert.equal(act.points(users.a.id).ledger[0].actor.guarantorId, users.a.id);
  assert.throws(() => vote(act, users.d, task), error => error.status === 409);
  assert.equal(act.points(users.a.id).ledger[0].settlement, 'offchain-pending');
});

test('gold answers never appear in responses; wrong gold votes and unsure-only results earn nothing', async t => {
  const { act, users } = await setup(t, [seed(1, 'no'), seed(2), seed(3, 'yes')]);
  const [gold, uncertain, correct] = act.snapshot().tasks;
  assert.doesNotMatch(JSON.stringify(act.snapshot(users.a.id)), /gold_answer|goldAnswer|expectedAnswer/);
  for (const user of [users.a, users.b, users.c]) vote(act, user, gold, 'yes');
  assert.equal(act.points(users.a.id).balance, 0);
  vote(act, users.a, uncertain, 'yes'); vote(act, users.b, uncertain, 'no');
  const mixed = vote(act, users.c, uncertain, 'unsure');
  assert.equal(mixed.task.status, 'inconclusive'); assert.equal(mixed.task.result, null);
  for (const user of [users.a, users.b, users.c]) vote(act, user, correct, 'yes');
  assert.equal(act.points(users.a.id).balance, 3);
  assert.doesNotMatch(JSON.stringify(act.task(users.a.id, gold.id)), /gold_answer|goldAnswer/);
});

test('monthly +30 cap includes agents, respects Beijing month boundary, and seed replays do not award again', async t => {
  let clock = Date.parse('2026-10-31T15:59:59Z');
  const { act, users } = await setup(t, Array.from({ length: 12 }, (_, i) => seed(i)), { now: () => clock });
  const tasks = act.snapshot().tasks;
  for (const task of tasks.slice(0, 11)) {
    vote(act, users.a, task, 'yes', agent(users.a.id)); vote(act, users.b, task); vote(act, users.c, task);
  }
  assert.equal(act.points(users.a.id).balance, 30); assert.equal(act.points(users.a.id).monthlyMicroEarned, 30);
  assert.equal(act.points(users.a.id).ledger.length, 10); assert.equal(act.points(users.a.id).period, '2026-10');
  assert.equal(act.seed([seed(0)]).inserted, 0);
  clock = Date.parse('2026-10-31T16:00:00Z');
  vote(act, users.a, tasks[11]); vote(act, users.b, tasks[11]); vote(act, users.c, tasks[11]);
  assert.equal(act.points(users.a.id).balance, 33); assert.equal(act.points(users.a.id).monthlyMicroEarned, 3);
  assert.equal(act.points(users.a.id).period, '2026-11');
});

test('independent acceptance awards +8 once even when reproduction differs and binds Agent provenance to delivery', async t => {
  const { act, users, research, workflow, store } = await setup(t, []);
  const r = (await research.importResearch(users.a, { title: 'Private study', files: [{ path: 'PAPER.md', text: '# Private study\n\nThese are private materials, never a public Act task payload.\n' }] })).research;
  const terms = { researchId: r.id, executorId: users.b.id, verifierId: users.c.id, title: 'Reproduce one measurable claim', kind: 'reproduction', requirements: 'Deliver the complete commands, output and discrepancies.', acceptanceCriteria: 'Check the supplied evidence independently, regardless of scientific direction.' };
  assert.throws(() => workflow.createTask(users.a.id, { ...terms, verifierId: users.b.id }), /三个不同账号/);
  const task = workflow.createTask(users.a.id, terms).task;
  assert.deepEqual(act.snapshot().paperTasks, []); assert.deepEqual(act.snapshot(users.d.id).paperTasks, []);
  assert.equal(act.snapshot(users.b.id).paperTasks[0].id, task.id);
  assert.doesNotMatch(JSON.stringify(act.snapshot(users.b.id).paperTasks), /private materials|PAPER.md|acceptanceCriteria/);
  const actor = agent(users.b.id);
  workflow.claim(users.b.id, task.id, actor);
  const delivered = await workflow.deliver(users.b.id, task.id, { summary: 'The declared conditions produced a reproducible discrepancy.', environment: 'test environment', commands: 'run-check', outcome: 'differs', files: [{ path: 'results.txt', text: 'The observed metric differed; this file is the submitted result.' }] }, actor);
  const { id: deliveryId, rootHash, executionSource, createdAt, ...content } = delivered.delivery;
  assert.equal(rootHash, digest(content)); assert.equal(content.actor.agentId, actor.agentId);
  const verify = { deliveryId, decision: 'accept', finding: 'differs', note: 'Checked the complete submitted output under the agreed conditions.', checkedFiles: ['results.txt'] };
  assert.throws(() => workflow.verify(users.b.id, task.id, verify), error => error.status === 403);
  assert.throws(() => act.awardContribution({ contribution: { id: 'made-up', userId: users.b.id } }), error => error.status === 409);
  const accepted = workflow.verify(users.c.id, task.id, verify);
  assert.equal(accepted.pointsAward.amount, 8); assert.equal(accepted.contribution.actor.agentId, actor.agentId);
  assert.equal(accepted.pointsAward.actor.guarantorId, users.b.id);
  const again = workflow.verify(users.c.id, task.id, verify);
  assert.equal(again.pointsAward.id, accepted.pointsAward.id);
  assert.equal(act.awardContribution({ contribution: { id: accepted.contribution.id, userId: users.d.id } }).userId, users.b.id);
  assert.equal(act.points(users.b.id).balance, 8); assert.equal(act.points(users.d.id).balance, 0);
  assert.equal(store.one('SELECT count(*) AS count FROM points_ledger').count, 1);
  const logs = store.all('SELECT data FROM events WHERE research_id=?', r.id).map(row => JSON.parse(row.data));
  assert.equal(logs.find(event => event.action === 'delivery-submitted').actor.agentId, actor.agentId);
});

test('a failed acceptance hook rolls back acceptance and no points are granted for revision', async t => {
  const { users, research, workflow, act } = await setup(t, []);
  const r = (await research.importResearch(users.a, { title: 'Atomic study', files: [{ path: 'PAPER.md', text: '# Atomic study\n\nEvidence is supplied as a versioned manuscript.\n' }] })).research;
  const task = workflow.createTask(users.a.id, { researchId: r.id, executorId: users.b.id, verifierId: users.c.id, title: 'Independent replication', kind: 'reproduction', requirements: 'Provide all outputs and exact commands.', acceptanceCriteria: 'Independent person checks original outputs.' }).task;
  workflow.claim(users.b.id, task.id);
  const delivered = await workflow.deliver(users.b.id, task.id, { summary: 'This is the initial work report with a result.', outcome: 'inconclusive', files: [{ path: 'result.txt', text: 'Initial evidence with limitations.' }] });
  const payload = { deliveryId: delivered.delivery.id, decision: 'accept', finding: 'inconclusive', note: 'Checked the original evidence with all declared limitations.', checkedFiles: ['result.txt'] };
  workflow.setAcceptanceHandler(() => { throw new Error('ledger unavailable'); });
  assert.throws(() => workflow.verify(users.c.id, task.id, payload), /ledger unavailable/);
  assert.equal(workflow.detail(users.a.id, task.id).task.status, 'submitted');
  assert.equal(workflow.detail(users.a.id, task.id).contributions.length, 0);
  workflow.verify(users.c.id, task.id, { ...payload, decision: 'revise' });
  assert.equal(act.points(users.b.id).balance, 0);
});

test('bundled seeds contain traceable records but hide check selection behind a persistent server secret', async t => {
  const bundle = JSON.parse(await readFile(new URL('../data/act-source-snapshots.json', import.meta.url), 'utf8'));
  const tasks = loadActSeedFile();
  assert.equal(tasks.length, 10); assert.doesNotMatch(JSON.stringify(bundle), /goldAnswer|isGold|gold_answer|gold-selection-key|sourceFile|\.cache\//);
  for (const source of bundle.snapshots) { assert.equal(source.snapshotHash, digest(source.snapshot)); assert.match(source.sourceSha256, /^[a-f0-9]{64}$/); assert.equal(new URL(source.sourceUrl).hostname, 'api.openalex.org'); }
  for (const task of tasks) {
    assert(task.evidence.every(e => new URL(e.url).search === ''));
  }
  assert.throws(() => buildActSeeds([]), /不足五道题/);
  const { act, store, auth, research, workflow } = await setup(t, tasks);
  assert.equal(act.snapshot().tasks.length, 10);
  assert.doesNotMatch(JSON.stringify(act.snapshot()), /goldAnswer|sourceFile|Bastet/);
  const selected = store.all('SELECT id,gold_answer FROM act_tasks WHERE gold_answer IS NOT NULL ORDER BY id');
  assert.equal(selected.length, 2);
  const serverKey = store.one('SELECT value FROM act_settings WHERE name=?', 'gold-selection-key-v1').value;
  assert.match(serverKey, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(act.snapshot()).includes(serverKey)); assert(!JSON.stringify(bundle).includes(serverKey));
  for (const row of selected) {
    const task = act.task(null, row.id).task;
    const source = bundle.snapshots.find(source => source.snapshot.workId === task.subject.workId);
    assert.equal(row.gold_answer, source.snapshot.authors.some(author => author.id === task.subject.authorId) ? 'yes' : 'no');
  }
  createCommunityAct(store, auth, research, workflow);
  assert.equal(store.one('SELECT value FROM act_settings WHERE name=?', 'gold-selection-key-v1').value, serverKey);
  assert.deepEqual(store.all('SELECT id,gold_answer FROM act_tasks WHERE gold_answer IS NOT NULL ORDER BY id'), selected);
  assert.throws(() => act.seed([{ ...seed(99), evidence: [{ ...seed(99).evidence[0], url: 'https://api.openalex.org/works/W1?api_key=not-a-key' }] }]), /不带凭据/);
});

test('semantic identity ignores refresh time, snapshot hashes and prompt edits; answered pairs cannot earn again', async t => {
  const original = seed(1);
  const { act, users } = await setup(t, [original]);
  const task = act.snapshot().tasks[0];
  for (const user of [users.a, users.b, users.c]) vote(act, user, task);
  const refreshed = { ...original, title: '同一记录的新抓取标题', prompt: original.prompt + ' 这是重新抓取的相同记录。',
    evidence: original.evidence.map(item => ({ ...item, retrievedAt: '2026-11-01T00:00:00.000Z', snapshotHash: digest('new snapshot bytes') })) };
  assert.deepEqual(act.seed([refreshed]), { inserted: 0, total: 1 });
  assert.equal(act.snapshot().tasks[0].id, task.id);
  assert.equal(act.points(users.a.id).balance, 3);
  assert.throws(() => vote(act, users.a, task), error => error.status === 409);
});

test('legacy snapshot-based IDs map to one canonical task and old rewarded answers stay spent after upgrade', async t => {
  const { users, store, auth, research, workflow } = await setup(t, []);
  const data = { ...seed(1), id: 'micro-legacy-snapshot-time-based', type: 'micro', source: 'public-record-snapshot', kind: 'bibliography-check', status: 'open', result: null, reward: 3, createdAt: '2026-10-07T00:00:00Z' };
  delete data.subject;
  // Old production rows carried work and author canonical URLs, not a subject property.
  data.evidence.push({ ...data.evidence[0], url: 'https://api.openalex.org/authors/A100001' });
  store.run('INSERT INTO act_tasks(id,data,gold_answer) VALUES(?,?,NULL)', data.id, JSON.stringify(data));
  const upgraded = createCommunityAct(store, auth, research, workflow, { seedTasks: [seed(1)] });
  assert.equal(upgraded.snapshot().tasks.length, 1);
  const task = upgraded.snapshot().tasks[0];
  assert.equal(task.id, data.id);
  for (const user of [users.a, users.b, users.c]) vote(upgraded, user, task);
  const restarted = createCommunityAct(store, auth, research, workflow, { seedTasks: [seed(1)] });
  assert.equal(restarted.snapshot().tasks.length, 1);
  assert.equal(upgraded.points(users.a.id).balance, 3);
  assert.throws(() => vote(restarted, users.a, task), error => error.status === 409);
});

async function referenceStudy(context, text, permission = true) {
  const { store, users, research } = context;
  const record = (await research.importResearch(users.a, { title: 'PRIVATE manuscript title never for a DOI task',
    files: [{ path: 'PAPER.md', text: '# Private study\n\nPrivate surrounding manuscript text.\n\n' + text }] })).research;
  store.db.exec('CREATE TABLE IF NOT EXISTS community_publications(research_id TEXT PRIMARY KEY REFERENCES research(id), data TEXT NOT NULL)');
  if (permission !== null) store.run('INSERT INTO community_publications(research_id,data) VALUES(?,?)', record.id,
    JSON.stringify({ researchId: record.id, researchHash: record.rootHash, publishedAt: '2026-10-08T00:00:00Z', allowReviewMaterials: true, allowReferenceTasks: permission }));
  return record;
}

test('only a fetched 404 from an explicitly published archive creates a DOI-only task with persisted evidence', async t => {
  const calls = [];
  const context = await setup(t, [], { referenceFetch: async (url, options) => {
    calls.push({ url, options });
    const doi = decodeURIComponent(new URL(url).pathname.slice('/works/'.length));
    if (doi === '10.1234/located') return new Response('{"message":{"DOI":"10.1234/located"}}', { status: 200 });
    if (doi === '10.1234/missing') return new Response('Upstream original body, never public.', { status: 404 });
    return new Response('Rate limited', { status: 429 });
  } });
  const { act, users, store } = context;
  const study = await referenceStudy(context, 'https://doi.org/10.1234/located\nDOI: 10.1234/MISSING\n10.1234/limited\n10.1234/fourth');
  assert.deepEqual(act.scheduleReferenceChecks(users.a.id, study.id), { scheduled: true });
  assert.equal(calls.length, 0, 'the publishing response need not await archive loading or upstream HTTP');
  await act.whenIdle();
  assert.equal(calls.length, 3);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://api.crossref.org'); assert.equal(new URL(url).search, '');
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET'); assert(!Object.hasOwn(options, 'body'));
  }
  const tasks = act.snapshot().tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].kind, 'reference-doi-check');
  assert.deepEqual(tasks[0].subject, { doi: '10.1234/missing' });
  assert.match(tasks[0].prompt, /不代表文献不存在或造假/);
  assert.equal(tasks[0].evidence[0].httpStatus, 404);
  const saved = store.all('SELECT data FROM act_reference_lookups').map(row => JSON.parse(row.data));
  assert.deepEqual(saved.map(row => row.httpStatus), [200, 404, 429]);
  const missing = saved[1];
  assert.equal(Buffer.from(missing.responseBase64, 'base64').toString(), 'Upstream original body, never public.');
  assert.equal(tasks[0].evidence[0].responseSha256, missing.responseSha256);
  assert.equal(tasks[0].evidence[0].snapshotHash, digest(JSON.parse(tasks[0].evidence[0].excerpt)));
  const serialized = JSON.stringify(act.snapshot());
  for (const secret of ['PRIVATE manuscript', 'surrounding manuscript', study.id, users.a.id, 'PAPER.md', 'Upstream original body', 'responseBase64']) assert(!serialized.includes(secret));
  assert.deepEqual(act.scheduleReferenceChecks(users.a.id, study.id), { scheduled: false, reason: 'already-scheduled' });
  assert.throws(() => act.seed([{ ...seed(22), kind: 'reference-doi-check', subject: { doi: '10.1234/forged' }, httpStatus: 404 }]), /真实 Crossref/);
  for (const user of [users.a, users.b, users.c]) vote(act, user, tasks[0], 'unsure');
  assert.equal(act.points(users.a.id).balance, 0);
});

test('a DOI shared by different public studies is one global task and cannot pay the same guarantor twice', async t => {
  let requests = 0;
  const context = await setup(t, [], { referenceFetch: async () => { requests++; return new Response('Resource not found.', { status: 404 }); } });
  const { act, users, store, auth, research, workflow } = context;
  const first = await referenceStudy(context, 'DOI: 10.5555/SAME');
  act.scheduleReferenceChecks(users.a.id, first.id); await act.whenIdle();
  const task = act.snapshot().tasks[0];
  for (const user of [users.a, users.b, users.c]) vote(act, user, task, 'no');
  assert.equal(act.points(users.a.id).balance, 3);
  const second = await referenceStudy(context, '(https://doi.org/10.5555/same).');
  act.scheduleReferenceChecks(users.a.id, second.id); await act.whenIdle();
  assert.equal(requests, 1); assert.equal(act.snapshot().tasks.length, 1);
  assert.equal(act.points(users.a.id).balance, 3);
  const restarted = createCommunityAct(store, auth, research, workflow, { seedTasks: [] });
  assert.equal(restarted.snapshot().tasks[0].id, task.id);
  assert.throws(() => vote(restarted, users.a, task), error => error.status === 409);
});

test('private studies, unconsented references and stale publication hashes never start a Crossref request', async t => {
  let requests = 0;
  const context = await setup(t, [], { referenceFetch: async () => { requests++; return new Response('Missing', { status: 404 }); } });
  const { act, users, store } = context;
  for (const consent of [null, false]) {
    const study = await referenceStudy(context, '10.1234/private', consent);
    assert.deepEqual(act.scheduleReferenceChecks(users.a.id, study.id), { scheduled: false, reason: 'not-authorized' });
  }
  const study = await referenceStudy(context, '10.1234/version-mismatch');
  store.run('UPDATE community_publications SET data=? WHERE research_id=?', JSON.stringify({ allowReferenceTasks: true, researchHash: 'stale-version' }), study.id);
  assert.equal(act.scheduleReferenceChecks(users.a.id, study.id).reason, 'not-authorized');
  assert.throws(() => act.scheduleReferenceChecks(users.b.id, study.id), error => error.status === 403);
  await act.whenIdle(); assert.equal(requests, 0); assert.deepEqual(act.snapshot().tasks, []);
});

test('a public version checks at most three unique DOI strings within the bounded text scan', async t => {
  const calls = [];
  const context = await setup(t, [], { referenceFetch: async url => { calls.push(url); return new Response('Resource not found.', { status: 404 }); } });
  const { act, users } = context;
  const study = await referenceStudy(context, '10.1234/ONE 10.1234/one 10.1234/two 10.1234/three 10.1234/four');
  act.scheduleReferenceChecks(users.a.id, study.id); await act.whenIdle();
  assert.equal(calls.length, 3); assert.equal(act.snapshot().tasks.length, 3);
  assert.deepEqual(act.snapshot().tasks.map(task => task.subject.doi), ['10.1234/one', '10.1234/two', '10.1234/three']);
  const beyond = await referenceStudy(context, 'x'.repeat(256 * 1024) + '\n10.1234/beyond-scan');
  act.scheduleReferenceChecks(users.a.id, beyond.id); await act.whenIdle();
  assert.equal(calls.length, 3);
});

test('withdrawal during HTTP and tampered archived bytes cannot produce public reference tasks', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const context = await setup(t, [], { referenceFetch: async () => { started(); await gate; return new Response('Missing', { status: 404 }); } });
  const { act, users, store, dataDir } = context;
  const study = await referenceStudy(context, '10.1234/withdrawn');
  act.scheduleReferenceChecks(users.a.id, study.id); await waiting;
  store.run('DELETE FROM community_publications WHERE research_id=?', study.id);
  release(); await act.whenIdle();
  assert.deepEqual(act.snapshot().tasks, []);
  assert.equal(JSON.parse(store.one('SELECT data FROM act_reference_runs').data).status, 'cancelled');
  const changed = await referenceStudy(context, '10.1234/tampered');
  await writeFile(path.join(dataDir, 'library', changed.id, 'files', 'PAPER.md'), 'Changed archive bytes with DOI 10.1234/tampered');
  act.scheduleReferenceChecks(users.a.id, changed.id); await act.whenIdle();
  assert.deepEqual(act.snapshot().tasks, []);
  assert.equal(store.one('SELECT count(*) AS count FROM act_reference_lookups').count, 1);
});

test('timeouts, 429, server errors, redirects and oversized 404 bodies are not evidence of missing references', async t => {
  const cases = [
    ['timeout', async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))],
    ['429', async () => new Response('Retry later', { status: 429 })],
    ['503', async () => new Response('Service unavailable', { status: 503 })],
    ['redirect', async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })],
    ['oversized', async () => new Response('x'.repeat(64 * 1024 + 1), { status: 404 })],
  ];
  for (const [label, referenceFetch] of cases) await t.test(label, async sub => {
    const context = await setup(sub, [], { referenceFetch, referenceTimeoutMs: 30 });
    const study = await referenceStudy(context, 'DOI: 10.1234/problem');
    context.act.scheduleReferenceChecks(context.users.a.id, study.id);
    await context.act.whenIdle();
    assert.deepEqual(context.act.snapshot().tasks, []);
    const evidence = JSON.parse(context.store.one('SELECT data FROM act_reference_lookups').data);
    assert.notEqual(evidence.state, 'not-found');
    assert.equal(context.store.one('SELECT count(*) AS count FROM points_ledger').count, 0);
  });
});
