import test from 'node:test';
import assert from 'node:assert/strict';
import { createSciverse } from '../lib/sciverse.mjs';

const DOC = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const schema = { fields: ['unique_id', 'doc_id', 'title', 'author', 'abstract', 'publication_published_year', 'doi'].map(name => ({ name, type: 'String', filterable: true, sortable: true, searchable: true, operators: ['FILTER_OP_EQ', 'FILTER_OP_MATCH'] })), default_fields: ['title', 'author'], filter_operators: ['EQ', 'MATCH'] };
const paper = { unique_id: 'paper:10.1234/test', doc_id: DOC, is_content_accessible: true, title: 'Research <script>', author: [{ name: 'Ada Lovelace' }], doi: '10.1234/test', abstract: 'Abstract', publication_published_year: 2025 };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(handler, options = {}) {
  const calls = [];
  const service = createSciverse({ token: 'test-credential-not-real', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.pathname === '/meta-catalog' ? json(schema) : handler(url, init);
  }, ...options });
  return { service, calls };
}

test('metadata discovers available fields, uses fuzzy author filters, and caches without exposing credentials', async () => {
  const { service, calls } = fixture(() => json({ results: [paper], total_count: 23 }));
  const result = await service.search({ q: 'combustion', author: 'Ada Lovelace' });
  assert.equal(result.total, 23);
  assert.equal(result.hasMore, true);
  assert.equal(result.results[0].canRead, true);
  assert.deepEqual(result.results[0].authors, ['Ada Lovelace']);
  assert.equal(result.results[0].url, 'https://doi.org/10.1234/test');
  assert.deepEqual(calls.map(call => call.url.pathname), ['/meta-catalog', '/meta-search']);
  const request = calls[1];
  assert.equal(request.url.origin, 'https://api.sciverse.space');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.Authorization, 'Bearer test-credential-not-real');
  assert.deepEqual(JSON.parse(request.init.body), { collection: 'papers', page: 1, page_size: 10, query: 'combustion', filters: [{ field: 'author', operator: 'FILTER_OP_MATCH', value: 'Ada Lovelace' }], fields: schema.fields.map(item => item.name) });
  assert.equal((await service.search({ q: 'combustion', author: 'Ada Lovelace' })).cached, true);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /test-credential|Authorization/);
});

test('DOI is an exact filter; author-only searches do not put an author name in the title query', async () => {
  const { service, calls } = fixture(() => json({ results: [], total_count: 0 }));
  await service.search({ q: 'https://doi.org/10.1234/test' });
  assert.deepEqual(JSON.parse(calls[1].init.body).filters, [{ field: 'doi', operator: 'FILTER_OP_EQ', value: '10.1234/test' }]);
  assert.equal(JSON.parse(calls[1].init.body).query, undefined);
  await service.search({ author: 'Lovelace', page: '2' });
  const request = JSON.parse(calls[2].init.body);
  assert.equal(request.query, undefined);
  assert.equal(request.page, 2);
  assert.deepEqual(request.sort, [{ field: 'publication_published_year', order: 'SORT_ORDER_DESC' }]);
});

test('field catalog retains valid per-field operators without accepting arbitrary values', async () => {
  const service = createSciverse({ token: 'fake', fetchImpl: async () => json({ ...schema, code: 'SUCCESS', biz_code: 0, fields: [{ ...schema.fields[0], operators: ['FILTER_OP_EQ', 'MATCH', null, {}, '<script>', 'x'.repeat(100)] }] }) });
  const catalog = await service.catalog();
  assert.deepEqual(catalog.fields[0].operators, ['FILTER_OP_EQ', 'MATCH']);
  assert.deepEqual(catalog.filterOperators, ['EQ', 'MATCH']);
});

test('HTTP 200 business failures are rejected rather than shown as an empty search', async () => {
  for (const envelope of [{ code: 'UNAUTHORIZED', biz_code: 401 }, { code: 'SUCCESS', biz_code: 17 }, { code: null }]) {
    const { service } = fixture(() => json({ results: [], total_count: 0, message: 'secret-provider-message', ...envelope }));
    await assert.rejects(service.search({ q: 'Research' }), error => error.status === 502 && !error.message.includes('secret-provider-message'));
  }
  const { service } = fixture(() => json({ code: 'SUCCESS', biz_code: 0, results: [], total_count: 0 }));
  assert.deepEqual((await service.search({ q: 'Research' })).results, []);
});

test('semantic request uses the real retrieval parameter, reports soft author filtering and preserves chunk offset', async () => {
  const { service, calls } = fixture(() => json({ hits: [{ chunk_id: 'chunk-1', doc_id: DOC, title: 'A result', chunk: 'A finding', author: ['Actual author', 'Actual author'], offset: 3, score: 0.9 }] }));
  const result = await service.search({ q: 'How does this work?', author: 'Ada', mode: 'semantic' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { query: 'How does this work?', top_k: 8, retrieval: 'hybrid', filters: { author: ['Ada'] } });
  assert.equal(result.hasMore, false);
  assert.equal(result.results[0].offset, 3);
  assert.equal(result.results[0].canRead, true);
  assert.deepEqual(result.results[0].authors, ['Actual author']);
  assert.match(result.note, /近似过滤/);
  assert.equal(result.results[0].score, undefined);
});

test('invalid modes, pagination, controls, and empty queries never reach the data source', async () => {
  const { service, calls } = fixture(() => assert.fail());
  for (const params of [{}, { q: 'x' }, { q: 'ab\u0000cd' }, { q: 'x'.repeat(401) }, { q: 'valid', mode: 'raw' }, { q: 'valid', page: 101 }, { q: 'valid', page: 1.1 }, { q: 'valid', mode: 'semantic', page: 2 }, { author: 'Ada', mode: 'semantic' }]) {
    await assert.rejects(service.search(params), { status: 400 });
  }
  assert.equal(calls.length, 0);
  const unconfigured = createSciverse({ token: '', fetchImpl: () => assert.fail() });
  assert.equal(unconfigured.health().configured, false);
  await assert.rejects(unconfigured.search({ q: 'valid' }), { status: 503 });
});

test('content access requires an accessible returned document and forwards Unicode offsets unchanged', async () => {
  const { service, calls } = fixture(url => url.pathname === '/meta-search' ? json({ results: [paper, { ...paper, unique_id: 'denied', doc_id: OTHER, is_content_accessible: false }], total_count: 2 }) : json({ text: 'A😀B', next_offset: 3, more: true }));
  await assert.rejects(service.content({ doc: DOC }), { status: 403 });
  await service.search({ q: 'Research' });
  await assert.rejects(service.content({ doc: OTHER }), { status: 403 });
  const content = await service.content({ doc: DOC, offset: 0 });
  assert.equal(content.nextOffset, 3);
  assert.equal(content.text.length, 4);
  assert.equal(calls[2].url.searchParams.get('offset'), '0');
  assert.equal(calls[2].url.searchParams.get('limit'), '4096');
  assert.equal((await service.content({ doc: DOC })).cached, true);
  assert.equal(calls.length, 3);
  for (const input of [{ doc: 'https://example.com' }, { doc: DOC, offset: -1 }, { doc: DOC, offset: 0.5 }, { doc: DOC, offset: '1e3' }]) await assert.rejects(service.content(input), { status: 400 });
});

test('only safe raster references from returned content can be proxied, with byte and MIME verification', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const { service, calls } = fixture(url => {
    if (url.pathname === '/meta-search') return json({ results: [paper], total_count: 1 });
    if (url.pathname === '/content') return json({ text: '![图](dt=2026/p/f1.png) ![bad](https://other/image.png) ![bad](../x.png) ![SVG](x.svg)', next_offset: 100, more: false });
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  await assert.rejects(service.resource('dt=2026/p/f1.png'), { status: 403 });
  await service.search({ q: 'Research' });
  const content = await service.content({ doc: DOC });
  assert.deepEqual(content.resources, [{ fileName: 'dt=2026/p/f1.png', alt: '图' }]);
  const resource = await service.resource('dt=2026/p/f1.png');
  assert.equal(resource.mimeType, 'image/png');
  assert.deepEqual(resource.bytes, png);
  assert.equal(calls.at(-1).url.searchParams.get('file_name'), 'dt=2026/p/f1.png');
  for (const name of ['https://other/x.png', '../x.png', '/root/x.png', 'a\\x.png', 'x.svg', 'x%2epng', 'a//x.png']) await assert.rejects(service.resource(name), { status: 400 });
  const evil = fixture(url => url.pathname === '/meta-search' ? json({ results: [paper], total_count: 1 }) : url.pathname === '/content' ? json({ text: '![](x.png)', next_offset: 10, more: false }) : new Response('<svg onload="alert(1)">', { headers: { 'content-type': 'image/png' } }));
  await evil.service.search({ q: 'Research' }); await evil.service.content({ doc: DOC });
  await assert.rejects(evil.service.resource('x.png'), { status: 502 });
});

test('timeouts, upstream failures and malformed responses are bounded and sanitized', async () => {
  for (const [status, expected] of [[401, 503], [403, 403], [404, 404], [429, 429], [500, 502]]) {
    const { service } = fixture(() => new Response('token=do-not-echo', { status }));
    await assert.rejects(service.search({ q: 'Research' }), error => error.status === expected && !error.message.includes('do-not-echo'));
  }
  const { service } = fixture((url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('secret upstream URL')))), { timeoutMs: 10 });
  await assert.rejects(service.search({ q: 'Research' }), error => error.status === 503 && /超时/.test(error.message) && !error.message.includes('secret'));
  for (const value of [{ hits: [] }, { results: [{}] }]) {
    const malformed = fixture(() => json(value));
    await assert.rejects(malformed.service.search({ q: 'Research' }), { status: 502 });
  }
});

test('duplicate searches share in-flight requests and cached searches expire', async () => {
  let time = 1000, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls } = fixture(async () => { await gate; return json({ results: [paper], total_count: 1 }); }, { now: () => time, ttlMs: 100 });
  const one = service.search({ q: 'Research' }), two = service.search({ q: 'Research' });
  release();
  await Promise.all([one, two]);
  assert.equal(calls.length, 2);
  time += 101;
  assert.equal((await service.search({ q: 'Research' })).cached, false);
  assert.equal(calls.length, 4);
  time += 30 * 60000;
  await assert.rejects(service.content({ doc: DOC }), { status: 403 });
});

test('catalog projection respects token field permissions and limits concurrent upstream calls', async () => {
  const limited = createSciverse({ token: 'fake', fetchImpl: async url => {
    assert.equal(url.pathname, '/meta-catalog');
    return json({ ...schema, fields: schema.fields.filter(field => field.name !== 'author') });
  } });
  await assert.rejects(limited.search({ author: 'Ada' }), { status: 403 });
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = fixture(async () => { started(); await gate; return json({ results: [], total_count: 0 }); }, { maxConcurrent: 1 });
  const first = service.search({ q: 'Research' });
  await ready;
  await assert.rejects(service.search({ q: 'Another query' }), { status: 429 });
  release(); await first;
  await service.search({ q: 'Another query' });
});
