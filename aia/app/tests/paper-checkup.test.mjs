import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import zipTools from '@aia/research-core/zip';
import { createPaperCheckup, readPaperZip } from '../lib/paper-checkup.mjs';

const text = '# Uploaded private manuscript\n\nThis research manuscript explains the original observations, their limitations, and the scope of the conclusion. It has not been scientifically certified.\n';
const asFile = (name, bytes) => ({ file: { name, base64: Buffer.from(bytes).toString('base64') } });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aia-paper-checkup-'));
  let origin;
  const service = await createPaperCheckup({ dataDir, requestOrigin: () => origin, ...options });
  const server = http.createServer(async (req, res) => { if (!(await service.handle(req, res, new URL(req.url, origin)))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); assert.ok(path.basename(dataDir).startsWith('aia-paper-checkup-')); await rm(dataDir, { recursive: true, force: true }); });
  function client() {
    const state = { cookie: '', csrf: '' };
    return { state, async request(route, method = 'GET', payload, headers = {}) {
      const response = await fetch(origin + route, { method, headers: { ...(state.cookie ? { Cookie: state.cookie } : {}), ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', 'X-Paper-CSRF': state.csrf } : {}), ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      if (response.headers.get('set-cookie')) state.cookie = response.headers.get('set-cookie').split(';')[0];
      if (data.csrfToken) state.csrf = data.csrfToken;
      return { status: response.status, data, headers: response.headers };
    } };
  }
  return { client, dataDir };
}
async function ready(env) { const client = env.client(); assert.equal((await client.request('/paper-api/session')).status, 200); return client; }
async function assess(client, payload) { const response = await client.request('/paper-api/assess', 'POST', payload); assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; }
function pdfBytes() {
  const content = 'BT /F1 10 Tf 40 700 Td (A supplied research manuscript with original observations and limitations. Material checks do not certify scientific validity.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`; return Buffer.from(result);
}
function compressedZip(name, original, { claimedLength = original.length } = {}) {
  const nameBytes = Buffer.from(name), data = deflateRawSync(original), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22), crc = zipTools.crc32(original);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(claimedLength, 22); local.writeUInt16LE(nameBytes.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(claimedLength, 24); central.writeUInt16LE(nameBytes.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nameBytes.length, 12); end.writeUInt32LE(30 + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

test('plain upload retains its exact SHA and does not count generated PAPER.md as original ARA', async t => {
  const env = await setup(t), client = await ready(env);
  const report = await assess(client, asFile('private.md', text));
  assert.equal(report.source.sha256, sha(text)); assert.equal(report.source.simulated, false);
  assert.equal(report.structure.find(item => item.id === 'manifest').status, 'missing');
  assert.equal(report.verdict, 'missing-materials'); assert.equal(report.protocol.officialSeal, false);
  assert.deepEqual(report.originalFiles.map(file => file.path), ['private.md']);
  assert.ok(report.generatedFiles.some(file => file.path === 'PAPER.md'));
  assert.equal(JSON.stringify(report).includes(env.dataDir), false);
  assert.deepEqual(await readdir(path.join(env.dataDir, 'paper-checkup-tmp')), []);
});

test('two synthetic examples use real checks: consistent evidence versus metric contradiction and absent materials', async t => {
  const env = await setup(t), client = await ready(env);
  const good = await assess(client, { sample: 'complete' });
  assert.equal(good.source.simulated, true); assert.equal(good.verdict, 'structure-present');
  assert.ok(good.structure.every(item => item.status === 'pass'));
  assert.equal(good.checks.find(item => item.id === 'consistency').status, 'pass');
  const bad = await assess(client, { sample: 'incomplete' });
  assert.equal(bad.checks.find(item => item.id === 'consistency').status, 'fail');
  assert.ok(bad.findings.some(item => item.id.startsWith('metric-mismatch-') && item.detail.includes('0.99') && item.detail.includes('0.75')));
  assert.ok(bad.structure.some(item => item.id === 'source' && item.status === 'missing'));
  assert.ok(bad.structure.some(item => item.id === 'trace' && item.status === 'missing'));
  assert.ok(bad.findings.some(item => item.id.startsWith('broken-reference-')));
  assert.ok(good.score.value > bad.score.value);
  const archive = await client.request(good.source.downloadUrl);
  assert.equal(archive.status, 200); assert.equal(sha(archive.data), good.source.sha256);
  const repeated = await assess(client, asFile('downloaded-example.zip', archive.data));
  assert.equal(repeated.score.value, good.score.value); assert.equal(repeated.verdict, good.verdict);
});

test('reports require the same anonymous session and origin/CSRF, with private downloadable response', async t => {
  const env = await setup(t), first = await ready(env), second = await ready(env), anonymous = env.client();
  const report = await assess(first, { sample: 'complete' });
  const endpoint = `/paper-api/reports/${report.id}`;
  assert.equal((await anonymous.request(endpoint)).status, 401);
  assert.equal((await second.request(endpoint)).status, 404);
  assert.equal((await first.request('/paper-api/assess', 'POST', { sample: 'complete' }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await first.request('/paper-api/assess', 'POST', { sample: 'complete' }, { 'X-Paper-CSRF': 'forged' })).status, 403);
  assert.equal((await first.request(endpoint, 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const download = await first.request(endpoint + '/download');
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal(download.headers.get('cache-control'), 'no-store'); assert.equal(download.data.source.sha256, report.source.sha256);
});

test('real PDF parsing extracts text but a lone PDF remains incomplete ARA', async t => {
  const env = await setup(t), client = await ready(env), bytes = pdfBytes();
  const report = await assess(client, asFile('published-paper.pdf', bytes));
  assert.equal(report.source.sha256, sha(bytes)); assert.equal(report.source.kind, 'pdf');
  assert.ok(report.generatedFiles.some(item => item.path === '_derived/published-paper.pdf.txt'));
  assert.equal(report.checks.find(item => item.id === 'manuscript').status, 'pass');
  assert.equal(report.structure.find(item => item.id === 'manifest').status, 'missing');
  assert.deepEqual(await readdir(path.join(env.dataDir, 'paper-checkup-tmp')), []);
});

test('ZIP upload recognizes an enclosing folder and preserves file hashes without executing supplied code', async t => {
  const env = await setup(t), client = await ready(env);
  const fixture = JSON.parse(await readFile(new URL('../../paper-checkup/fixtures/complete.json', import.meta.url), 'utf8'));
  const entries = fixture.files.map(file => ({ name: `research/${file.path}`, text: file.path.endsWith('.py') ? 'raise RuntimeError("must not execute")\n' : file.text }));
  const bytes = Buffer.from(zipTools.zip(entries));
  const report = await assess(client, asFile('research.zip', bytes));
  assert.equal(report.source.sha256, sha(bytes)); assert.equal(report.verdict, 'structure-present');
  assert.ok(report.originalFiles.some(file => file.path === 'src/evaluate.py' && file.sha256 === sha('raise RuntimeError("must not execute")\n')));
  assert.deepEqual(await readdir(path.join(env.dataDir, 'paper-checkup-tmp')), []);
});

test('ZIP parser supports deflate and rejects traversal, links, duplicate files, corruption and inflation bombs', () => {
  const compressed = compressedZip('paper.md', Buffer.from(text));
  assert.equal(Buffer.from(readPaperZip(compressed)[0].base64, 'base64').toString(), text);
  for (const name of ['../paper.md', '/paper.md', 'C:/paper.md', 'a\\paper.md', 'a/../../paper.md']) assert.throws(() => readPaperZip(zipTools.zip([{ name, text }])), /路径/);
  assert.throws(() => readPaperZip(zipTools.zip([{ name: 'PAPER.md', text }, { name: 'paper.md', text }])), /重复/);
  const corrupt = Buffer.from(zipTools.zip([{ name: 'paper.md', text }])); corrupt[40] ^= 1;
  assert.throws(() => readPaperZip(corrupt), /校验/);
  const symlink = Buffer.from(zipTools.zip([{ name: 'paper.md', text }])); const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); symlink.writeUInt32LE(0xa0000000, central + 38);
  assert.throws(() => readPaperZip(symlink), /链接/);
  assert.throws(() => readPaperZip(compressedZip('paper.md', Buffer.alloc(2 * 1024 * 1024, 65))), /压缩率/);
  assert.throws(() => readPaperZip(compressedZip('paper.md', Buffer.from(text), { claimedLength: 8 })), /超出/);
  assert.throws(() => readPaperZip(zipTools.zip(Array.from({ length: 101 }, (_, i) => ({ name: `${i}.md`, text: 'x' })))), /100/);
});

test('upload failures leave no private material behind', async t => {
  const env = await setup(t, { pdfParser: async () => { throw new Error('invalid PDF'); } }), client = await ready(env);
  assert.equal((await client.request('/paper-api/assess', 'POST', asFile('broken.pdf', '%PDF-broken'))).status, 400);
  assert.equal((await client.request('/paper-api/assess', 'POST', { file: { name: 'bad.txt', base64: '%%%' } })).status, 400);
  assert.equal((await client.request('/paper-api/assess', 'POST', asFile('bad.exe', 'fake'))).status, 400);
  assert.deepEqual(await readdir(path.join(env.dataDir, 'paper-checkup-tmp')), []);
});

test('parallel processing is bounded before parsing another upload', async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const env = await setup(t, { limits: { concurrent: 1 }, pdfParser: () => { entered(); return new Promise(resolve => { release = () => resolve(text); }); } });
  const first = await ready(env), second = await ready(env);
  const pending = first.request('/paper-api/assess', 'POST', asFile('slow.pdf', '%PDF-testing'));
  await started;
  try { assert.equal((await second.request('/paper-api/assess', 'POST', { sample: 'complete' })).status, 429); }
  finally { release(); }
  assert.equal((await pending).status, 200);
});

test('session expiry prevents further report access and rate limiting rejects repeated work', async t => {
  let timestamp = Date.now();
  const env = await setup(t, { now: () => timestamp, limits: { ttl: 1000, perMinute: 1 } }), client = await ready(env);
  const report = await assess(client, { sample: 'complete' });
  assert.equal((await client.request('/paper-api/assess', 'POST', { sample: 'incomplete' })).status, 429);
  timestamp += 1100;
  assert.equal((await client.request(`/paper-api/reports/${report.id}`)).status, 401);
});

test('anonymous text complexity and report retention are bounded', async t => {
  const env = await setup(t), client = await ready(env);
  const complex = await client.request('/paper-api/assess', 'POST', asFile('too-many-refs.md', text + '[missing](no.md)\n'.repeat(1001)));
  assert.equal(complex.status, 400); assert.match(complex.data.error, /引用或主张过多/);
  const first = await assess(client, { sample: 'complete' });
  for (let index = 0; index < 3; index++) await assess(client, { sample: 'complete' });
  assert.equal((await client.request(`/paper-api/reports/${first.id}`)).status, 404);
  assert.deepEqual(await readdir(path.join(env.dataDir, 'paper-checkup-tmp')), []);
});
