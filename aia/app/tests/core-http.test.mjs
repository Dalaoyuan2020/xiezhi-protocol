import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createApp } from '../server.mjs';
import * as chain from '../lib/chain.mjs';

const paper = '# A real supplied research note\n\nThis manuscript describes the supplied observations and their limited scope. The original bytes must survive import and export.\n';
const manuscript = () => ({ title: 'Private research', files: [{ path: 'paper.md', text: paper }, { path: 'src/run.py', text: 'raise RuntimeError("Uploaded code must never execute")\n' }] });
const report = { originality: 'This is an actual reviewer statement about originality.', methodology: 'The method needs an explicit comparison and data description.', evidence: 'I inspected the supplied manuscript and its referenced materials.', limitations: 'No experiment was executed by this material review.', conflictOfInterest: false, verdict: 'revise' };
const deliveryBody = suffix => ({ summary: `Actual work report with evidence ${suffix}.`, environment: 'Local external environment declared by submitter', commands: 'No platform execution; manual material reading', outcome: 'differs', files: [{ path: 'report.txt', text: `Actual delivered bytes ${suffix}\n` }, { path: 'manifest.json', text: '{"supplied":true}\n' }] });

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-core-'));
  let app, origin;
  async function start() { app = await createApp({ dataDir, ...options }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`; }
  await start();
  t.after(async () => { await app.close(); assert.ok(path.basename(dataDir).startsWith('aia-core-')); await rm(dataDir, { recursive: true, force: true }); });
  const clients = [];
  function client() {
    const state = { cookie: '', csrf: '' };
    clients.push(state);
    return { state, async request(route, method = 'GET', payload, headers = {}) {
      const response = await fetch(origin + route, { method, headers: { ...(state.cookie ? { Cookie: state.cookie } : {}), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) } : {}), ...headers }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const result = response.headers.get('content-type')?.includes('json') ? JSON.parse(bytes.toString()) : bytes;
      if (response.headers.get('set-cookie')) state.cookie = response.headers.get('set-cookie').split(';')[0];
      if (result.csrfToken) state.csrf = result.csrfToken;
      return { status: response.status, data: result, headers: response.headers };
    } };
  }
  async function register(name) { const c = client(); const res = await c.request('/api/auth/register', 'POST', { username: name, displayName: name, password: 'a sufficiently long passphrase' }); assert.equal(res.status, 200, JSON.stringify(res.data)); c.user = res.data.user; return c; }
  return { client, register, dataDir, get app() { return app; }, async restart() { await app.close(); await start(); } };
}
async function ok(c, route, method = 'GET', payload) { const res = await c.request(route, method, payload); assert.equal(res.status, 200, `${route}: ${JSON.stringify(res.data)}`); return res.data; }

test('empty real accounts enforce session/Origin/CSRF and private version ownership; no demo header grants access', async t => {
  const env = await setup(t); const anonymous = env.client();
  assert.deepEqual((await ok(anonymous, '/api/session')), { user: null, csrfToken: null });
  assert.equal((await anonymous.request('/api/overview', 'GET', undefined, { 'X-Demo-Actor': 'author' })).status, 401);
  assert.equal((await anonymous.request('/api/auth/register', 'POST', { username: 'evil', displayName: 'evil', password: 'longpassword' }, { Origin: 'https://evil.invalid' })).status, 403);
  const a = await env.register('author-a'), b = await env.register('reader-b');
  assert.equal((await ok(a, '/api/overview')).ideas.length, 0);
  assert.equal((await a.request('/api/profile', 'PUT', { displayName: 'name' }, { 'X-CSRF-Token': 'forged' })).status, 403);
  assert.equal((await a.request('/api/profile', 'PUT', { displayName: 'name', orcid: '0009-0008-5473-5368' })).status, 400);
  const { user } = await ok(a, '/api/profile', 'PUT', { displayName: 'Real owner', orcid: '0009-0008-5473-5367', openalexId: 'A5126602136', bio: 'User declared profile', institution: 'Self declared' });
  assert.equal(user.profile.identityStatus, 'user-declared');
  const { research } = await ok(a, '/api/research/import', 'POST', manuscript());
  assert.equal(research.ownerId, a.user.id); assert.equal(research.version, 1);
  assert.equal(JSON.stringify(research).includes('sourceDir'), false); assert.equal(Object.hasOwn(research, 'prices'), false);
  assert.equal((await b.request(`/api/research/${research.id}`, 'GET', undefined, { 'X-Demo-Actor': 'author' })).status, 403);
  assert.equal((await ok(b, '/api/research')).research.length, 0);
  assert.equal((await b.request('/api/research/import', 'POST', { ...manuscript(), previousVersionId: research.id })).status, 403);
  const file = await a.request(`/api/research/${research.id}/file?path=paper.md`); assert.deepEqual(file.data, Buffer.from(paper));
  const assessed = await ok(a, `/api/research/${research.id}/assess`, 'POST', {});
  assert.equal(assessed.assessment.artifactHash, research.rootHash); assert.equal(assessed.assessment.engine, 'local-evidence-checks');
  const second = (await ok(a, '/api/research/import', 'POST', { ...manuscript(), previousVersionId: research.id })).research;
  assert.equal(second.version, 2); assert.equal(second.previousVersionId, research.id);
  const sid = (await ok(a, '/api/session')).csrfToken;
  await env.restart(); assert.equal((await ok(a, '/api/session')).csrfToken, sid);
  assert.equal((await ok(a, '/api/research')).research.length, 2);
  await ok(a, '/api/auth/logout', 'POST', {}); assert.equal((await a.request('/api/overview')).status, 401);
  const login = await ok(a, '/api/auth/login', 'POST', { username: 'AUTHOR-A', password: 'a sufficiently long passphrase' }); assert.equal(login.user.id, user.id);
});

test('three real accounts review, deliver, revise and independently accept once; records survive restart', async t => {
  const env = await setup(t); const a = await env.register('owner-a'), b = await env.register('worker-b'), c = await env.register('reviewer-c'), outsider = await env.register('outsider-d');
  const r = (await ok(a, '/api/research/import', 'POST', manuscript())).research;
  assert.equal((await a.request(`/api/research/${r.id}/review-requests`, 'POST', { reviewerId: a.user.id, focus: 'Review this material' })).status, 400);
  const review = (await ok(a, `/api/research/${r.id}/review-requests`, 'POST', { reviewerId: b.user.id, focus: 'Inspect methods and evidence' })).review;
  assert.equal((await a.request(`/api/reviews/${review.id}/submit`, 'POST', report)).status, 403);
  assert.equal((await ok(b, `/api/reviews/${review.id}/submit`, 'POST', report)).review.status, 'submitted');
  assert.equal((await b.request(`/api/reviews/${review.id}/submit`, 'POST', report)).status, 409);
  const taskBody = { researchId: r.id, title: 'Investigate missing evidence', kind: 'evidence-review', requirements: 'Deliver a cited explanation and actual work files.', acceptanceCriteria: 'Verifier reads the report and checks specific cited files.', executorId: b.user.id, verifierId: c.user.id };
  assert.equal((await a.request('/api/tasks', 'POST', { ...taskBody, verifierId: b.user.id })).status, 400);
  const task = (await ok(a, '/api/tasks', 'POST', taskBody)).task;
  assert.equal(task.compensation.paymentStatus, 'not-applicable');
  assert.equal((await outsider.request(`/api/tasks/${task.id}`)).status, 403);
  assert.equal((await outsider.request(`/api/research/${r.id}`)).status, 403);
  assert.equal((await a.request(`/api/tasks/${task.id}/claim`, 'POST', {})).status, 403);
  await ok(b, `/api/tasks/${task.id}/claim`, 'POST', {});
  const first = (await ok(b, `/api/tasks/${task.id}/deliver`, 'POST', deliveryBody('first'))).delivery;
  const acceptance = { deliveryId: first.id, decision: 'accept', finding: 'differs', note: 'I checked the actual supplied files and its reported limitations.', checkedFiles: ['report.txt'] };
  assert.equal((await b.request(`/api/tasks/${task.id}/verify`, 'POST', acceptance)).status, 403);
  assert.equal((await a.request(`/api/tasks/${task.id}/verify`, 'POST', acceptance)).status, 403);
  assert.equal((await c.request(`/api/tasks/${task.id}/verify`, 'POST', { ...acceptance, checkedFiles: ['missing.txt'] })).status, 400);
  await ok(c, `/api/tasks/${task.id}/verify`, 'POST', { ...acceptance, decision: 'revise' });
  assert.equal((await ok(b, '/api/contributions')).contributions.length, 0);
  const second = (await ok(b, `/api/tasks/${task.id}/deliver`, 'POST', deliveryBody('corrected'))).delivery;
  assert.notEqual(second.rootHash, first.rootHash);
  assert.equal((await c.request(`/api/tasks/${task.id}/verify`, 'POST', acceptance)).status, 409);
  const acceptLatest = { ...acceptance, deliveryId: second.id };
  const simultaneous = await Promise.all([c.request(`/api/tasks/${task.id}/verify`, 'POST', acceptLatest), c.request(`/api/tasks/${task.id}/verify`, 'POST', acceptLatest)]);
  assert.ok(simultaneous.every(result => result.status === 200));
  assert.equal(simultaneous[0].data.contribution.id, simultaneous[1].data.contribution.id);
  assert.equal(simultaneous[0].data.task.scientificFinding, 'differs');
  assert.equal((await ok(b, '/api/contributions')).contributions.length, 1);
  assert.equal((await ok(outsider, '/api/contributions')).contributions.length, 0);
  assert.equal((await outsider.request(`/api/deliveries/${second.id}/file?path=report.txt`)).status, 403);
  assert.deepEqual((await c.request(`/api/deliveries/${second.id}/file?path=manifest.json`)).data, Buffer.from('{"supplied":true}\n'));
  await env.restart();
  const detail = await ok(c, `/api/tasks/${task.id}`); assert.equal(detail.task.status, 'accepted'); assert.equal(detail.deliveries.length, 2); assert.equal(detail.verifications.length, 2); assert.equal(detail.contributions.length, 1);
  assert.equal((await ok(b, '/api/overview')).counts.contributions, 1);
  const exported = await ok(outsider, '/api/export'); assert.equal(exported.tasks.length, 0); assert.equal(JSON.stringify(exported).includes('password_hash'), false);
});

test('unsafe imports leave no partial research and simultaneous deliveries commit only one archive', async t => {
  const env = await setup(t); const a = await env.register('owner-a'), b = await env.register('worker-b'), c = await env.register('checker-c');
  assert.equal((await a.request('/api/research/import', 'POST', { files: [{ path: '../escape.md', text: paper }] })).status, 400);
  assert.equal((await ok(a, '/api/research')).research.length, 0);
  assert.deepEqual(await readdir(path.join(env.dataDir, 'staging')), []);
  const r = (await ok(a, '/api/research/import', 'POST', manuscript())).research;
  const task = (await ok(a, '/api/tasks', 'POST', { researchId: r.id, title: 'Actual task', kind: 'reproduction', requirements: 'Record the actual runtime and command.', acceptanceCriteria: 'Check submitted evidence against the declared conditions.', executorId: b.user.id, verifierId: c.user.id })).task;
  await ok(b, `/api/tasks/${task.id}/claim`, 'POST', {});
  const results = await Promise.all([b.request(`/api/tasks/${task.id}/deliver`, 'POST', deliveryBody('one')), b.request(`/api/tasks/${task.id}/deliver`, 'POST', deliveryBody('two'))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await readdir(path.join(env.dataDir, 'deliveries'))).length, 1);
  assert.equal((await a.request('/api/research/import', 'POST', { files: [{ path: 'PAPER.md', text: paper }, { path: 'a/../bad.py', text: 'x' }] })).status, 400);
  assert.equal((await b.request('/api/reset', 'POST', { confirm: 'RESET_DEMO' })).status, 404);
});

test('wallet challenges bind real signatures and are single use; chain confirmations remain separate, deduplicated records', async t => {
  const wallet = Wallet.createRandom();
  const chainApi = { ...chain, async verifyRecordTransaction(args) { const prepared = await chain.buildRecordTransaction(args); return { verified: true, status: 'confirmed', txHash: args.txHash, chainId: prepared.network.chainId, network: args.network, contractAddress: prepared.transaction.to, wallet: args.wallet, contentHash: args.contentHash, blockNumber: 123, actionId: '7', logIndex: 0, confirmedAt: new Date().toISOString() }; } };
  const env = await setup(t, { chain: chainApi }); const a = await env.register('owner-a'), b = await env.register('worker-b');
  const challenge = await ok(a, '/api/wallet/challenge', 'POST', { address: wallet.address });
  const signature = await wallet.signMessage(challenge.message);
  assert.equal((await b.request('/api/wallet/verify', 'POST', { challengeId: challenge.id, signature })).status, 409);
  const results = await Promise.all([a.request('/api/wallet/verify', 'POST', { challengeId: challenge.id, signature }), a.request('/api/wallet/verify', 'POST', { challengeId: challenge.id, signature })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await ok(a, '/api/session')).user.profile.walletVerified, true);
  assert.equal((await a.request('/api/attestations/prepare', 'POST', { recordType: 'profile', recordId: a.user.id, network: 'testnet' })).status, 409);
  await ok(a, '/api/profile', 'PUT', { displayName: 'Original profile', institution: 'Original institution', openalexId: 'A5126602136', bio: 'Private free-text biography' });
  const profile = await ok(a, '/api/attestations/prepare', 'POST', { recordType: 'profile', recordId: a.user.id, network: 'testnet' });
  assert.equal(profile.attestation.kind, 'CLAIM');
  assert.equal(profile.attestation.profileStatement.identityStatus, 'user-declared');
  assert.equal(Object.hasOwn(profile.attestation.profileStatement, 'bio'), false);
  assert.equal(Object.hasOwn(profile.attestation, 'researchId'), false);
  await ok(a, '/api/profile', 'PUT', { displayName: 'Changed profile', institution: 'Changed institution', openalexId: 'A5126602136' });
  const profileConfirmed = await ok(a, `/api/attestations/${profile.attestation.id}/confirm`, 'POST', { txHash: '0x' + 'cd'.repeat(32) });
  assert.equal(profileConfirmed.attestation.profileStatement.displayName, 'Original profile');
  assert.equal(profileConfirmed.attestation.contentHash, profile.attestation.contentHash);
  const r = (await ok(a, '/api/research/import', 'POST', manuscript())).research;
  const prepared = await ok(a, '/api/attestations/prepare', 'POST', { recordType: 'research', recordId: r.id, network: 'testnet' });
  assert.equal(prepared.attestation.status, 'prepared'); assert.equal(prepared.transaction.from.toLowerCase(), wallet.address.toLowerCase());
  const txHash = '0x' + 'ab'.repeat(32);
  assert.equal((await b.request(`/api/attestations/${prepared.attestation.id}/confirm`, 'POST', { txHash })).status, 404);
  const confirmed = await ok(a, `/api/attestations/${prepared.attestation.id}/confirm`, 'POST', { txHash }); assert.equal(confirmed.attestation.status, 'confirmed');
  assert.equal((await ok(a, `/api/attestations/${prepared.attestation.id}/confirm`, 'POST', { txHash })).attestation.txHash, txHash);
  const again = await ok(a, '/api/attestations/prepare', 'POST', { recordType: 'research', recordId: r.id, network: 'testnet' });
  assert.equal((await a.request(`/api/attestations/${again.attestation.id}/confirm`, 'POST', { txHash })).status, 409);
  await env.restart(); assert.equal((await ok(a, '/api/attestations')).attestations.length, 3);
});

test('canonical teammate UI replaces public entry points while workspace and private account records remain isolated', async t => {
  const env = await setup(t); const anonymous = env.client();
  const origin = `http://127.0.0.1:${env.app.server.address().port}`;
  const query = '?case=A5126602136&network=mainnet&q=Lv%20Z&tag=1&tag=2';
  for (const [before, after] of [['/', '/ui/'], ['/classic', '/ui/'], ['/ui/card.html', '/ui/checkup.html'], ['/classic/live', '/live/'], ['/index.html', '/ui/'], ['/ui', '/ui/'], ['/workbench/card.html', '/workbench/checkup.html'], ['/legacy/ui/card.html', '/ui/checkup.html'], ['/legacy/ui/', '/ui/'], ['/legacy/ui/index.html', '/ui/index.html'], ['/legacy/ui/checkup.html', '/ui/checkup.html'], ['/legacy/ui/search.js', '/ui/search.js'], ['/legacy/product/mock_cases.json', '/product/mock_cases.json'], ['/workspace', '/workspace/']]) {
    const response = await fetch(origin + before + query, { redirect: 'manual' });
    assert.equal(response.status, 302, before); assert.equal(response.headers.get('location'), after + query, before);
  }
  const seal = await anonymous.request('/brand/seal.png');
  assert.equal(seal.status, 200); assert.equal(seal.headers.get('content-type'), 'image/png');
  assert.equal((await anonymous.request('/brand/README.md')).status, 404);
  const home = await anonymous.request('/workbench/');
  assert.equal(home.status, 200); assert.deepEqual(home.data, await readFile(new URL('../../../新ui/index.html', import.meta.url)));
  assert.match(home.data.toString(), /workbench\.css/);
  assert.equal(home.headers.get('x-aia-legacy'), null);
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:\d+\/ui\//);
  assert.match(csp, /form-action 'none'/); assert.equal(csp.includes("connect-src 'self'"), false);
  for (const file of ['/workbench/workbench.css', '/workbench/index.html', '/workbench/checkup.html', '/workbench/org.html', '/workbench/search.js', '/workbench/cases.html', '/workbench/workbench.js', '/workbench/page-registry.js']) assert.equal((await anonymous.request(file)).status, 200, file);
  assert.match(home.data.toString(), /src="workbench\.js"/);
  assert.doesNotMatch(home.data.toString(), /<script\s*>/);
  assert.match(home.data.toString(), /id="ss-source-note"/);
  const classic = await anonymous.request('/ui/');
  assert.equal(classic.status, 200);
  assert.deepEqual(classic.data, await readFile(new URL('../../../xiezhi-ui/index.html', import.meta.url)));
  assert.match(classic.data.toString(), /style-guanya\.css/);
  for (const file of ['/ui/index.html', '/ui/style-guanya.css', '/ui/menu.js', '/ui/menu.css', '/ui/checkup.html', '/ui/papers.html', '/live/']) assert.equal((await anonymous.request(file)).status, 200, file);
  assert.match(classic.headers.get('content-security-policy'), /script-src http:\/\/127\.0\.0\.1:\d+\/ui\/ http:\/\/127\.0\.0\.1:\d+\/workbench\//);
  const live = await anonymous.request('/workbench/live/');
  const classicLive = await anonymous.request('/live/');
  assert.match(live.data.toString(), /workbench\.css/);
  assert.match(classicLive.data.toString(), /\/ui\/style-guanya\.css/);
  for (const file of ['/ui/.env', '/ui/README.md', '/ui/package.json', '/ui/tests/search-core.test.cjs', '/live/README.md', '/ui/../app/.runtime/aia.sqlite']) assert.equal((await anonymous.request(file)).status, 404, file);
  const workspace = await anonymous.request('/workspace/');
  assert.equal(workspace.status, 200); assert.match(workspace.data.toString(), /AIA Commons/);
  for (const file of ['/app.js', '/app.css', '/mark.svg', '/workspace/app.js', '/workspace/app.css', '/workspace/mark.svg']) assert.equal((await anonymous.request(file)).status, 200, file);
  assert.deepEqual((await anonymous.request('/product/mock_cases.json')).data, JSON.parse(await readFile(new URL('../../product/mock_cases.json', import.meta.url), 'utf8')));
  for (const file of ['/legacy/ui/search.js','/legacy/ui/search-data.json','/legacy/ui/org.html','/legacy/ui/checkup.html','/legacy/ui/checkup-chain.js','/legacy/ui/checkup-actions.css','/legacy/product/mock_cases.json','/legacy/chain/artifacts/ActionRegistry.json','/legacy/chain/deployments/botchain-testnet.json','/legacy/chain/deployments/journals-testnet.json']) assert.equal((await anonymous.request(file)).status, 200, file);
  const oldCard = await anonymous.request('/legacy/ui/card.html?network=testnet'); assert.equal(oldCard.status, 200);
  for (const file of ['/legacy/ui/points-rules.js','/legacy/ui/checkup-points-core.js','/legacy/ui/checkup-points.js','/legacy/chain/artifacts/PointsLedger.json','/legacy/chain/deployments/points-testnet.json']) assert.equal((await anonymous.request(file)).status, 200, file);
  assert.match(oldCard.data.toString(), /学术体检/); assert.equal(oldCard.data.toString().includes('href="../product/checkup.py"'), false);
  for (const file of ['/legacy/ui/README.md','/legacy/ui/package.json','/legacy/ui/tests/org-core.test.cjs','/legacy/product/checkup.py','/legacy/chain/config.mjs','/legacy/chain/contracts/ActionRegistry.sol','/legacy/chain/receipts/private.json','/legacy/app/.runtime/aia.sqlite','/legacy/.env','/legacy/ui/.env','/legacy/ui/node_modules/package.json','/legacy/api/state','/legacy/ui/%2e%2e%2fapp/server.mjs','/legacy/ui/%5c..%5c.env']) assert.equal((await anonymous.request(file)).status, 404, file);
  const a = await env.register('legacy-guard');
  assert.equal((await a.request('/api/session', 'GET', undefined, { Referer: origin + '/legacy/ui/checkup.html' })).status, 403);
  assert.equal((await a.request('/api/profile', 'PUT', { displayName: 'Unauthorized historical write' }, { Referer: origin + '/legacy/ui/checkup.html' })).status, 403);
  assert.equal((await a.request('/api/session', 'GET', undefined, { Referer: origin + '/workbench/checkup.html' })).status, 403);
  assert.equal((await a.request('/api/profile', 'PUT', { displayName: 'Unauthorized public write' }, { Referer: origin + '/workbench/' })).status, 403);
  for (const path of ['/ui/', '/ui/papers.html', '/live/']) {
    assert.equal((await a.request('/api/session', 'GET', undefined, { Referer: origin + path })).status, 403);
    assert.equal((await a.request('/api/profile', 'PUT', { displayName: 'Unauthorized classic write' }, { Referer: origin + path })).status, 403);
  }
  assert.equal((await a.request('/api/session', 'GET', undefined, { Referer: origin + '/workspace/' })).status, 200);
  assert.equal((await a.request('/legacy/api/tasks', 'POST', {})).status, 405);
  for (const file of ['/workbench/README.md','/workbench/package.json','/workbench/product/checkup.py','/workbench/tests/org-core.test.cjs','/product/checkup.py','/chain/config.mjs','/chain/receipts/private.json','/app/.runtime/aia.sqlite','/workspace/.runtime/aia.sqlite','/workspace/server.mjs','/.env','/aia/public-ui.mjs','/xiezhi-ui/README.md']) assert.equal((await anonymous.request(file)).status, 404, file);
  assert.equal((await ok(a, '/api/session')).user.displayName, 'legacy-guard');
});
