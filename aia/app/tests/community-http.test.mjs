import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';

const manuscript = () => ({ title: 'A private research claim', abstract: 'An explicitly supplied abstract.', files: [{ path: 'PAPER.md', text: '# Materials\nThis supplied research note is deliberately private until its owner explicitly consents to publication.' }] });
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-community-'));
  const app = await createApp({ dataDir, sourceAdminOptions: { env: {} }, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); assert.ok(path.basename(dataDir).startsWith('aia-community-')); await rm(dataDir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, cookie, csrf, bearer, headers = {} } = {}) {
    const browser = !bearer && method !== 'GET';
    const res = await fetch(origin + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(browser ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data: result, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(name) {
    const res = await request('/api/auth/register', { method: 'POST', body: { username: name, displayName: name, password: 'community-test-private-password' } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const client = { user: res.data.user, request: (route, method = 'GET', body, extra = {}) => request(route, { method, body, cookie: res.cookie, csrf: res.data.csrfToken, ...extra }) };
    return client;
  }
  return { app, origin, request, register };
}
async function ok(client, route, method = 'GET', body) { const res = await client.request(route, method, body); assert.equal(res.status, 200, JSON.stringify(res.data)); return res.data; }
const fakeDual = (status = 'disagreement') => ({ configuration: () => ({ ready: true }), review: async ({ research }) => ({ id: `dual-${randomUUID()}`, researchId: research.id, researchHash: research.rootHash, createdAt: new Date().toISOString(), status, needsHumanReview: status === 'disagreement', verdict: status === 'agreed' ? { water_risk: 'low' } : null, disagreements: status === 'disagreement' ? ['water_risk'] : [], models: [], localChecks: [{ id: 'test-fixture-only', earned: 65 }], localScore: { value: 65, max: 100, label: '材料可检查度', artifactHash: research.rootHash } }) });

test('delegated reproduction can read only assigned materials and needs a different human to verify before earning eight points', async t => {
  const f = await fixture(t);
  const a = await f.register('reproduction-author'), b = await f.register('reproduction-executor'), c = await f.register('reproduction-verifier');
  const { research } = await ok(a, '/api/research/import', 'POST', manuscript());
  const { task } = await ok(a, '/api/tasks', 'POST', { researchId: research.id, executorId: b.user.id, verifierId: c.user.id, title: '核对所选主张的原始材料', kind: 'reproduction', requirements: '记录实际检查的输入、运行环境、命令与原始结果。', acceptanceCriteria: '独立核对文件与研究条件，结果不一致仍可以合格。' });
  const grant = await ok(b, '/api/agents', 'POST', { name: '复现执行助手', scopes: ['act:deliver'] });
  const agent = (url, method = 'GET', body) => f.request(url, { method, body, bearer: grant.token });
  const file = await agent(`/api/agent/tasks/${task.id}/material?path=PAPER.md`);
  assert.equal(file.status, 200); assert.match(file.data.text, /deliberately private/);
  assert.equal((await agent(`/api/agent/tasks/${task.id}/material?path=../../.env`)).status, 404);
  assert.equal((await agent(`/api/agent/research/${research.id}`)).status, 403);
  assert.equal((await agent(`/api/agent/tasks/${task.id}/claim`, 'POST', {})).status, 200);
  const delivered = await agent(`/api/agent/tasks/${task.id}/deliver`, 'POST', { summary: '只核对了交付材料与声明差异，未发现足够数据支持原结论。', environment: 'isolated test runner', commands: 'manual fixture verification', outcome: 'differs', files: [{ path: 'report.txt', text: 'A local test fixture report, no scientific claims.' }] });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));
  assert.equal(delivered.data.delivery.actor.agentId, grant.agent.id);
  const decision = { deliveryId: delivered.data.delivery.id, decision: 'accept', finding: 'differs', checkedFiles: ['report.txt'], note: '逐一核对了交付条件与报告，工作已完成，结果差异保留在记录中。' };
  assert.equal((await agent(`/api/agent/tasks/${task.id}/verify`, 'POST', decision)).status, 403);
  assert.equal((await b.request(`/api/tasks/${task.id}/verify`, 'POST', decision)).status, 403);
  const accepted = await ok(c, `/api/tasks/${task.id}/verify`, 'POST', decision);
  assert.equal(accepted.pointsAward.amount, 8); assert.equal(accepted.contribution.actor.agentId, grant.agent.id);
  await ok(c, `/api/tasks/${task.id}/verify`, 'POST', decision);
  const points = await ok(b, '/api/community/points'); assert.equal(points.balance, 8); assert.equal(points.ledger.length, 1);
});

test('community is publicly readable but imports, reviews, private tasks and credentials are never auto-published', async t => {
  const f = await fixture(t), author = await f.register('community-owner');
  let response = await f.request('/api/community'); assert.equal(response.status, 200); assert.equal(response.data.viewer, null);
  assert.ok(response.data.tasks.length >= 5); assert.equal(response.data.ideas.length, 0);
  assert.equal(JSON.stringify(response.data).includes('goldAnswer'), false); assert.equal(JSON.stringify(response.data).includes('gold_answer'), false);
  assert.ok(response.data.tasks.every(item => item.type !== 'bastet' && !item.title.includes('Bastet')));
  const { research } = await ok(author, '/api/research/import', 'POST', manuscript());
  const check = await ok(author, `/api/research/${research.id}/dual-review`, 'POST', {});
  assert.equal(check.review.status, 'unconfigured'); assert.equal(check.review.verdict, null);
  assert.equal(check.review.researchHash, research.rootHash);
  assert.equal((await f.request('/api/community')).data.ideas.length, 0);
  assert.equal((await author.request(`/api/research/${research.id}/publish`, 'POST', { published: true })).status, 400);
  await ok(author, `/api/research/${research.id}/publish`, 'POST', { published: true, allowReviewMaterials: true });
  response = await f.request('/api/community'); assert.equal(response.data.ideas.length, 1); assert.equal(response.data.attention.length, 0);
  assert.equal(response.data.ideas[0].rootHash, research.rootHash); assert.equal(response.data.ideas[0].files, undefined);
  assert.equal((await f.request(`/api/research/${research.id}/material?path=PAPER.md`)).status, 401);
  await ok(author, `/api/research/${research.id}/publish`, 'POST', { published: false });
  assert.equal((await f.request('/api/community')).data.ideas.length, 0);
});

test('publishing requires a separate reference opt-in before the server creates a DOI check', async t => {
  let calls = 0;
  const f = await fixture(t, { communityActOptions: { referenceFetch: async () => { calls++; return new Response('Resource not found.', { status: 404 }); } } });
  const author = await f.register('reference-opt-in');
  const payload = manuscript(); payload.files[0].text += '\nReferences: 10.1234/community-http-fixture';
  const { research } = await ok(author, '/api/research/import', 'POST', payload);
  const url = `/api/research/${research.id}/publish`;
  const ordinary = await ok(author, url, 'POST', { published: true, allowReviewMaterials: true });
  assert.equal(ordinary.referenceChecks.scheduled, false); assert.equal(calls, 0);
  const optedIn = await ok(author, url, 'POST', { published: true, allowReviewMaterials: true, allowReferenceTasks: true });
  assert.equal(optedIn.referenceChecks.scheduled, true);
  let task;
  for (let tries = 0; tries < 100 && !task; tries++) {
    task = (await f.request('/api/community')).data.tasks.find(item => item.kind === 'reference-doi-check');
    if (!task) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(calls, 1); assert.equal(task.subject.doi, '10.1234/community-http-fixture');
  assert.equal(JSON.stringify(task).includes(research.id), false);
});

test('disagreement creates a version-bound triage request, with consent, independent identity and score enforced server-side', async t => {
  const f = await fixture(t, { dualReview: fakeDual() });
  const author = await f.register('community-author'), reviewer = await f.register('community-reviewer');
  const { research } = await ok(author, '/api/research/import', 'POST', manuscript());
  const result = await ok(author, `/api/research/${research.id}/dual-review`, 'POST', {});
  assert.equal(result.review.status, 'disagreement');
  const detail = await ok(author, `/api/research/${research.id}/dual-review`);
  assert.equal(detail.attention.kind, 'gate-check'); assert.equal(detail.gate.passed, false);
  assert.equal((await f.request('/api/community')).data.attention.length, 0);
  await ok(author, `/api/research/${research.id}/publish`, 'POST', { published: true, allowReviewMaterials: true });
  await ok(reviewer, '/api/profile', 'PUT', { displayName: 'reviewer', openalexId: 'A123456789', score: 950, identityStatus: 'verified' });
  const route = `/api/community/attention/${detail.attention.id}/claim`;
  assert.equal((await reviewer.request(route, 'POST', {})).status, 403);
  // Only fixture trusted storage writes simulate an independently checked identity.
  f.app.store.run('INSERT INTO reviewer_credentials(user_id,data) VALUES(?,?)', reviewer.user.id, JSON.stringify({ status: 'verified', authorId: 'A123456789', score: 749, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  assert.equal((await reviewer.request(route, 'POST', {})).status, 403);
  f.app.store.run("UPDATE reviewer_credentials SET data=json_set(data,'$.score',750) WHERE user_id=?", reviewer.user.id);
  const assigned = await ok(reviewer, route, 'POST', {});
  assert.equal(assigned.review.reviewerId, reviewer.user.id); assert.equal(assigned.review.researchHash, research.rootHash);
  assert.equal((await reviewer.request(route, 'POST', {})).status, 409);
  assert.equal((await reviewer.request(`/api/research/${research.id}/material?path=PAPER.md`)).status, 200);
  const outsider = await f.register('community-outsider');
  assert.equal((await outsider.request(`/api/research/${research.id}/material?path=PAPER.md`)).status, 403);
});

test('seven-day Agent grants enforce scopes, guarantor attribution, revocation, expiration and human-only routes', async t => {
  let clock = Date.now(); const f = await fixture(t, { agentGrantOptions: { now: () => clock } });
  const owner = await f.register('agent-owner'), stranger = await f.register('agent-stranger');
  assert.equal((await owner.request('/api/agents', 'POST', { name: 'overpowered', scopes: ['verify'] })).status, 400);
  const issued = await ok(owner, '/api/agents', 'POST', { name: '研究助理', scopes: ['research:import', 'research:review', 'act:answer'] });
  assert.equal(Date.parse(issued.agent.expiresAt) - Date.parse(issued.agent.createdAt), 7 * 86400000);
  assert.ok(!JSON.stringify(await ok(owner, '/api/agents')).includes(issued.token));
  assert.ok(!f.app.store.one('SELECT token_hash FROM agent_grants WHERE id=?', issued.agent.id).token_hash.includes(issued.token));
  const agent = (route, body, method = 'POST') => f.request(route, { method, body, bearer: issued.token });
  const imported = await agent('/api/agent/research/import', manuscript());
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.research.createdBy.guarantorId, owner.user.id);
  assert.equal(imported.data.research.createdBy.name, '研究助理');
  const review = await agent(`/api/agent/research/${imported.data.research.id}/review`, {});
  assert.equal(review.status, 200); assert.equal(review.data.review.status, 'unconfigured'); assert.equal(review.data.review.performedBy.agentId, issued.agent.id);
  const humanPaper = (await ok(owner, '/api/research/import', 'POST', manuscript())).research;
  assert.equal((await agent(`/api/agent/research/${humanPaper.id}/review`, {})).status, 403);
  for (const url of ['/api/agent/tasks/arbitrary/verify', '/api/agent/reviews/arbitrary/submit', '/api/agent/agents']) assert.equal((await agent(url, {})).status, 403);
  assert.equal((await agent('/api/agents', { name: 'second', scopes: ['act:answer'] })).status, 403);
  assert.equal((await f.request('/api/agent/capabilities', { bearer: issued.token, headers: { Origin: f.origin } })).status, 403);
  const task = (await f.request('/api/community')).data.tasks[0];
  assert.equal((await agent(`/api/agent/act-tasks/${task.id}/answer`, { answer: 'unsure', reason: '我查阅了当前快照，暂时不足以确定归属。' })).status, 200);
  assert.equal((await owner.request(`/api/community/tasks/${task.id}/answer`, 'POST', { answer: 'yes', reason: '同一个担保人不能再重复回答这道题。' })).status, 409);
  assert.equal((await stranger.request(`/api/agents/${issued.agent.id}`, 'DELETE', {})).status, 404);
  await ok(owner, `/api/agents/${issued.agent.id}`, 'DELETE', {});
  assert.equal((await agent('/api/agent/capabilities', undefined, 'GET')).status, 401);
  const expires = await ok(owner, '/api/agents', 'POST', { name: '有期限', scopes: ['act:answer'] });
  clock += 7 * 86400000 + 1;
  assert.equal((await f.request('/api/agent/capabilities', { bearer: expires.token })).status, 401);
});

test('dual review coalesces concurrent clicks into one call per research version', async t => {
  let count = 0, release;
  const dual = fakeDual('agreed'); const original = dual.review;
  dual.review = async input => { count++; await new Promise(resolve => { release = resolve; }); return original(input); };
  const f = await fixture(t, { dualReview: dual }), author = await f.register('concurrent-author');
  const { research } = await ok(author, '/api/research/import', 'POST', manuscript());
  const a = author.request(`/api/research/${research.id}/dual-review`, 'POST', {});
  const b = author.request(`/api/research/${research.id}/dual-review`, 'POST', {});
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 30)); release();
  const results = await Promise.all([a, b]); assert.ok(results.every(r => r.status === 200));
  assert.equal(count, 1); assert.equal(results[0].data.review.id, results[1].data.review.id);
});

test('agreement opens formal review only with a matching version-bound local score of at least 60 out of 100', async t => {
  let clock = Date.now(), scenario;
  const dual = fakeDual('agreed'), original = dual.review;
  dual.review = async input => {
    const result = await original(input);
    // Deliberately large check totals and caller payloads must not substitute for the bound score.
    result.localChecks = [{ id: 'test-forged-check-total', weight: 100, earned: 100 }];
    result.localScore = scenario.score === null ? null : { value: scenario.value, max: scenario.max ?? 100,
      artifactHash: scenario.wrongHash ? 'f'.repeat(64) : input.research.rootHash };
    result.verdict.water_risk = scenario.risk || 'low';
    return result;
  };
  const f = await fixture(t, { dualReview: dual, communityOptions: { now: () => clock } });
  const author = await f.register('score-gate-owner');
  const { research } = await ok(author, '/api/research/import', 'POST', manuscript());
  await ok(author, `/api/research/${research.id}/publish`, 'POST', { published: true, allowReviewMaterials: true });
  const cases = [
    { name: 'missing local score', score: null, passed: false },
    { name: 'below threshold', value: 59, passed: false },
    { name: 'score from another artifact', value: 100, wrongHash: true, passed: false },
    { name: 'wrong score denominator', value: 65, max: 1000, passed: false },
    { name: 'non-numeric score', value: '100', passed: false },
    { name: 'out-of-range score', value: 101, passed: false },
    { name: 'exact threshold', value: 60, passed: true },
    { name: 'medium risk and complete materials', value: 100, risk: 'mid', passed: true },
    { name: 'high risk still fails', value: 100, risk: 'high', passed: false },
  ];
  for (scenario of cases) {
    clock += 300001; // Avoid confusing the independent per-account billing limit with admission checks.
    const response = await ok(author, `/api/research/${research.id}/dual-review`, 'POST', { localScore: { value: 100, max: 100, artifactHash: research.rootHash } });
    assert.equal(response.review.status, 'agreed', scenario.name);
    assert.equal(response.gate.passed, scenario.passed, scenario.name);
    const detail = await ok(author, `/api/research/${research.id}/dual-review`);
    assert.equal(detail.gate.passed, scenario.passed, scenario.name);
    assert.equal(detail.attention?.kind ?? null, scenario.passed ? 'peer-review' : null, scenario.name);
    if (scenario.passed) assert.equal(detail.attention.researchHash, research.rootHash);
    const community = (await f.request('/api/community')).data;
    assert.equal(community.ideas[0].gate.passed, scenario.passed, scenario.name);
    assert.equal(community.attention.length, scenario.passed ? 1 : 0, scenario.name);
  }
});

test('completed gate-check can advance to formal review while assigned triage and formal requests stay frozen', async t => {
  let status = 'disagreement';
  const dual = { configuration: () => ({ ready: true }), review: input => fakeDual(status).review(input) };
  const f = await fixture(t, { dualReview: dual });
  const author = await f.register('triage-author'), reviewer = await f.register('triage-reviewer'), formalReviewer = await f.register('formal-reviewer');
  for (const [person, authorId] of [[reviewer, 'A123456789'], [formalReviewer, 'A987654321']]) {
    await ok(person, '/api/profile', 'PUT', { displayName: person.user.displayName, openalexId: authorId });
    // Trusted fixture setup models a maintainer-verified identity; ordinary profile input cannot grant it.
    f.app.store.run('INSERT INTO reviewer_credentials(user_id,data) VALUES(?,?)', person.user.id,
      JSON.stringify({ status: 'verified', authorId, score: 750, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  }
  const { research } = await ok(author, '/api/research/import', 'POST', manuscript());
  const reviewRoute = `/api/research/${research.id}/dual-review`;
  await ok(author, reviewRoute, 'POST', {});
  await ok(author, `/api/research/${research.id}/publish`, 'POST', { published: true, allowReviewMaterials: true });
  const initial = await ok(author, reviewRoute);
  const claimRoute = `/api/community/attention/${initial.attention.id}/claim`;
  const assigned = await ok(reviewer, claimRoute, 'POST', {});
  assert.equal(assigned.attention.kind, 'gate-check');

  status = 'agreed';
  assert.equal((await ok(author, reviewRoute, 'POST', {})).gate.passed, true);
  assert.deepEqual((await ok(author, reviewRoute)).attention, assigned.attention, 'new model agreement must not overwrite a claimed triage');
  assert.equal((await formalReviewer.request(claimRoute, 'POST', {})).status, 409);

  const report = { originality: '已核对稿件声称的创新点，本次不包含外部查新。', methodology: '已核对当前归档的方法描述与双模型分歧条目。',
    evidence: '已逐项核对提供的材料，未把模型一致作为实验成立的证据。', limitations: '本次只核对材料门槛，不能代替后续独立正式审稿。', conflictOfInterest: false, verdict: 'recommend' };
  const submitted = await ok(reviewer, `/api/reviews/${assigned.review.id}/submit`, 'POST', report);
  const beforeRerun = (await f.request('/api/community')).data.attention[0];
  assert.equal(beforeRerun.kind, 'gate-check'); assert.equal(beforeRerun.status, 'submitted');

  await ok(author, reviewRoute, 'POST', {});
  const promoted = (await ok(author, reviewRoute)).attention;
  assert.equal(promoted.id, initial.attention.id); assert.equal(promoted.kind, 'peer-review'); assert.equal(promoted.status, 'open');
  assert.equal(promoted.reviewId, null); assert.equal(promoted.priorGateReviewId, assigned.review.id); assert.equal(promoted.researchHash, research.rootHash);
  assert.deepEqual(JSON.parse(f.app.store.one('SELECT data FROM reviews WHERE id=?', assigned.review.id).data), submitted.review, 'triage evidence must remain archived unchanged');

  await ok(author, `/api/research/${research.id}/publish`, 'POST', { published: true, allowReviewMaterials: true });
  assert.equal((await ok(author, reviewRoute)).attention.priorGateReviewId, assigned.review.id, 'republishing retains the archived triage link');

  const formal = await ok(formalReviewer, claimRoute, 'POST', {});
  assert.notEqual(formal.review.id, assigned.review.id); assert.equal(formal.attention.kind, 'peer-review');
  status = 'disagreement';
  assert.equal((await ok(author, reviewRoute, 'POST', {})).gate.passed, false);
  assert.deepEqual((await ok(author, reviewRoute)).attention, formal.attention, 'later disagreement must not replace a formal review already accepted by a human');
  assert.equal((await reviewer.request(claimRoute, 'POST', {})).status, 409);
});
