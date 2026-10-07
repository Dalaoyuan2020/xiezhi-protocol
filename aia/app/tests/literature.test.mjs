import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiterature, mergeLiteratureResults, PROVIDERS } from '../lib/literature.mjs';

const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const title = 'A test of evidence', DOI = '10.1234/shared';
const openalex = { results: [{ id: 'https://openalex.org/W123', title, doi: `https://doi.org/${DOI}`, publication_year: 2024, authorships: [{ author: { display_name: 'Ada Lovelace' }, institutions: [{ display_name: 'University A' }] }], abstract_inverted_index: { OpenAlex: [0], abstract: [1] }, cited_by_count: 11, open_access: { is_oa: true }, best_oa_location: { pdf_url: 'https://example.org/paper.pdf' } }], meta: { count: 21 } };
const crossref = { message: { items: [{ DOI, title: [title], author: [{ given: 'Ada', family: 'Lovelace' }], published: { 'date-parts': [[2024, 1]] }, abstract: '<jats:p>Crossref abstract</jats:p>', URL: `https://doi.org/${DOI}`, funder: [{ name: 'Public Foundation' }], license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }] }], 'total-results': 11 } };
const semantic = { data: [{ paperId: 's2-1', title, authors: [{ name: 'Ada Lovelace' }], year: 2024, abstract: 'Preferred S2 abstract', externalIds: { DOI, PubMed: '12345' }, citationCount: 17, url: 'https://www.semanticscholar.org/paper/s2-1' }], total: 31 };
function fixture(options = {}, handler) {
  const calls = [];
  const service = createLiterature({ credentials: () => ({}), fetchImpl: async (url, init) => { calls.push({ url, init }); return handler ? handler(url, init) : response(url.hostname === 'api.openalex.org' ? openalex : url.hostname === 'api.crossref.org' ? crossref : semantic); }, ...options });
  return { service, calls };
}

test('default parallel federation merges identifiers and preferred fields without summing source totals', async () => {
  const { service, calls } = fixture();
  const result = await service.search({ q: 'evidence' });
  assert.equal(calls.length, 3);
  assert.equal(result.results.length, 1);
  assert.equal(result.total, 1);
  assert.equal(result.totalIsExact, false);
  assert.equal(result.hasMore, true);
  assert.equal(result.partial, true);
  assert.equal(result.sourceStatus.find(item => item.id === 'sciverse').status, 'unconfigured');
  const item = result.results[0];
  assert.equal(item.abstract, 'Preferred S2 abstract');
  assert.equal(item.citationCount, 17);
  assert.deepEqual(item.institutions, ['University A']);
  assert.deepEqual(item.funders, ['Public Foundation']);
  assert.equal(item.openAccess, true);
  assert.deepEqual(item.sources.map(item => item.id), ['openalex', 'crossref', 'semantic_scholar']);
  assert.equal(item.doi, DOI);
  assert.equal(item.pmid, '12345');
  assert.equal(item.canRead, false);
  assert.equal(item.pdfUrl, 'https://example.org/paper.pdf');
  for (const call of calls) { assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal); }
});

test('failed providers remain visible while successful results survive; all failures are not a fake empty list', async () => {
  const { service } = fixture({}, url => { if (url.hostname === 'api.crossref.org') return response(crossref); throw new Error('secret=https://private.invalid?api_key=do-not-echo'); });
  const result = await service.search({ q: 'evidence' });
  assert.equal(result.results.length, 1);
  assert.equal(result.sourceStatus.filter(item => item.status === 'error').length, 2);
  assert.doesNotMatch(JSON.stringify(result), /do-not-echo|private\.invalid/);
  await assert.rejects(service.search({ q: 'evidence', source: 'openalex' }), failure => failure.status === 503 && failure.sourceStatus[0].status === 'error' && !failure.message.includes('secret'));
});

test('credential replacement and disable toggles affect new requests without restart and never appear in health', async () => {
  let secrets = { OPENALEX_API_KEY: 'first-key', SCIVERSE_API_TOKEN: 'first-token' }, disabled = [];
  const adapters = [];
  const { service, calls } = fixture({ credentials: () => secrets, disabledSources: () => disabled,
    sciverseFactory: options => { adapters.push(options.token); return { catalog: async () => ({ fields: [] }), content: async () => ({ tokenUsed: adapters.at(-1) }), resource: async () => ({}) }; } });
  await service.search({ q: 'evidence', source: 'openalex' });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer first-key');
  assert.equal((await service.search({ q: 'evidence', source: 'openalex' })).cached, true);
  assert.equal(calls.length, 1);
  secrets = { ...secrets, OPENALEX_API_KEY: 'second-key', SCIVERSE_API_TOKEN: 'second-token' };
  await service.search({ q: 'evidence', source: 'openalex' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer second-key');
  assert.deepEqual(adapters, ['first-token', 'second-token']);
  assert.equal((await service.content({})).tokenUsed, 'second-token');
  const health = service.health();
  assert.equal(health.configured, true);
  assert.doesNotMatch(JSON.stringify(health), /first-key|second-key|first-token|second-token|envNames|requiredEnvNames/);
  assert.ok(health.providers.every(item => !Object.hasOwn(item, 'configured')));
  disabled = ['openalex', 'sciverse'];
  await assert.rejects(service.search({ q: 'evidence', source: 'openalex' }), failure => failure.sourceStatus[0].status === 'disabled');
  assert.throws(() => service.content({}), { status: 503 });
  assert.equal(calls.length, 2);
  const result = await service.search({ q: 'evidence' });
  assert.equal(result.sourceStatus.find(item => item.id === 'openalex').status, 'disabled');
  assert.ok(calls.slice(2).every(call => call.url.hostname !== 'api.openalex.org'));
});

test('structured source queries separate authors from topics and preserve exact DOI semantics', async () => {
  const { service, calls } = fixture();
  await service.search({ q: 'https://doi.org/10.1234/SHARED', author: 'Ada Lovelace', source: 'openalex' });
  assert.equal(calls[0].url.searchParams.get('search'), null);
  assert.match(calls[0].url.searchParams.get('filter'), /^doi:10\.1234\/shared,raw_author_name\.search:/);
  await service.search({ author: 'Ada Lovelace', source: 'crossref' });
  assert.equal(calls[1].url.searchParams.get('query.author'), 'Ada Lovelace');
  assert.equal(calls[1].url.searchParams.get('query.bibliographic'), null);
  await assert.rejects(service.search({ author: 'Ada Lovelace', source: 'semantic_scholar' }), failure => failure.sourceStatus[0].status === 'skipped');
  assert.equal(calls.length, 2);
});

test('semantic mode is isolated to Sciverse and preserves authorized document and chunk identifiers', async () => {
  const seen = [];
  const { service, calls } = fixture({ credentials: () => ({ SCIVERSE_API_TOKEN: 'fake-token' }), sciverseFactory: () => ({ search: async args => { seen.push(args); return { results: [{ id: 'chunk1', docId: 'a'.repeat(64), title, authors: ['Ada'], canRead: true, offset: 4096, snippet: 'Evidence', abstract: '', year: 2024 }], total: 1, hasMore: false }; } }) });
  const result = await service.search({ q: 'How did this happen?', source: 'all', mode: 'semantic' });
  assert.equal(result.source, 'sciverse');
  assert.equal(result.results[0].canRead, true);
  assert.equal(result.results[0].offset, 4096);
  assert.equal(result.results[0].sources[0].id, 'sciverse');
  assert.equal(calls.length, 0);
  assert.equal(seen[0].mode, 'semantic');
  await assert.rejects(service.search({ q: 'valid', source: 'crossref', mode: 'semantic' }), { status: 400 });
});

test('identifier precedence merges aliases but never combines conflicting DOIs on title alone', () => {
  const item = (id, extra = {}) => ({ id, title, year: 2024, authors: [], sources: [{ id, label: id }], source: id, ...extra });
  const results = mergeLiteratureResults([
    item('one', { doi: DOI, pmid: '12' }), item('two', { doi: DOI, pmid: '99' }),
    item('different', { doi: '10.1234/different' }), item('no-doi', { pmid: '12' }),
    { ...item('arxiv1', { arxivId: '2401.12345' }), title: 'Preprint one' },
    { ...item('arxiv2', { arxivId: '2401.12345' }), title: 'Preprint renamed' },
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(results[0].sources.map(source => source.id), ['one', 'two', 'no-doi']);
  assert.equal(results[1].doi, '10.1234/different');
  assert.deepEqual(results[2].sources.map(source => source.id), ['arxiv1', 'arxiv2']);
});

test('Europe PMC cursor pagination follows the actual next cursor, never silently repeats page one', async () => {
  const { service, calls } = fixture({}, url => response({ hitCount: 30, nextCursorMark: url.searchParams.get('cursorMark') === '*' ? 'cursor-two' : 'cursor-three', resultList: { result: [{ id: '12345', source: 'MED', title, pubYear: '2024', authorList: { author: [{ fullName: 'Ada' }] }, doi: DOI }] } }));
  await service.search({ q: 'malaria', source: 'europe_pmc' });
  await service.search({ q: 'malaria', source: 'europe_pmc', page: 2 });
  assert.equal(calls[0].url.searchParams.get('cursorMark'), '*');
  assert.equal(calls[1].url.searchParams.get('cursorMark'), 'cursor-two');
  await assert.rejects(service.search({ q: 'malaria', source: 'europe_pmc', page: 4 }), failure => failure.sourceStatus[0].status === 'skipped');
  assert.equal(calls.length, 2);
});

test('PubMed uses bounded two-step metadata lookup and keeps credentials out of results', async () => {
  const { service, calls } = fixture({ credentials: () => ({ NCBI_API_KEY: 'fake-ncbi', NCBI_EMAIL: 'research@example.org' }) }, url => response(url.pathname.endsWith('esearch.fcgi') ? { esearchresult: { idlist: ['12345'], count: '1' } } : { result: { uids: ['12345'], '12345': { uid: '12345', title, pubdate: '2024 Jan', authors: [{ name: 'Lovelace A' }], articleids: [{ idtype: 'doi', value: DOI }] } } }));
  const result = await service.search({ q: 'malaria', author: 'Lovelace', source: 'pubmed' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('api_key'), 'fake-ncbi');
  assert.equal(calls[1].url.searchParams.get('id'), '12345');
  assert.equal(result.results[0].pmid, '12345');
  assert.equal(result.results[0].doi, DOI);
  assert.equal(result.results[0].abstract, '');
  assert.doesNotMatch(JSON.stringify(result), /fake-ncbi|research@example/);
});

test('arXiv Atom extraction is bounded, decodes text and rejects DTDs and API error entries', async () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults>12</opensearch:totalResults><entry><id>http://arxiv.org/abs/2401.12345v2</id><title>Evidence &amp; Reasoning</title><summary>A &#x1f600; result</summary><published>2024-01-01</published><author><name>Ada</name></author><arxiv:doi>${DOI}</arxiv:doi></entry></feed>`;
  const { service, calls } = fixture({}, () => new Response(xml));
  const result = await service.search({ q: 'evidence', source: 'arxiv' });
  assert.equal(result.results[0].arxivId, '2401.12345');
  assert.equal(result.results[0].title, 'Evidence & Reasoning');
  assert.equal(result.results[0].abstract, 'A 😀 result');
  assert.equal(result.results[0].pdfUrl, 'https://arxiv.org/pdf/2401.12345');
  assert.equal(calls[0].url.protocol, 'https:');
  for (const body of ['<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml, '<feed><entry><id>http://arxiv.org/api/errors</id></entry></feed>', '<html>Error</html>']) {
    const invalid = fixture({}, () => new Response(body));
    await assert.rejects(invalid.service.search({ q: 'evidence', source: 'arxiv' }), { status: 503 });
  }
});

test('DataCite and keyed ADS normalize only their own fields and URLs', async () => {
  const { service, calls } = fixture({ credentials: () => ({ ADS_DEV_KEY: 'fake-ads' }) }, url => response(url.hostname === 'api.datacite.org' ? { data: [{ id: DOI, attributes: { titles: [{ title }], creators: [{ name: 'Ada' }], publicationYear: 2024, descriptions: [{ descriptionType: 'Abstract', description: 'Data summary' }], types: { resourceTypeGeneral: 'Dataset' }, url: 'javascript:alert(1)' } }], meta: { total: 1 } } : { response: { numFound: 1, docs: [{ bibcode: '2024Test...123A', title: [title], author: ['Ada'], year: '2024', doi: [DOI], identifier: ['arXiv:2401.12345'], abstract: 'Sky summary' }] } }));
  const data = await service.search({ q: 'evidence', source: 'datacite' });
  assert.equal(data.results[0].resourceType, 'Dataset');
  assert.equal(data.results[0].url, `https://doi.org/${DOI}`);
  assert.equal(calls[0].url.searchParams.get('fields[dois]'), 'doi,titles,creators,publicationYear,descriptions,url,types');
  assert.equal(calls[0].url.searchParams.get('page[size]'), '10');
  const ads = await service.search({ q: 'evidence', source: 'nasa_ads' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer fake-ads');
  assert.equal(ads.results[0].arxivId, '2401.12345');
  assert.equal(ads.results[0].canRead, false);
});

test('timeout, oversize, malformed data and invalid source requests do not become synthetic results', async () => {
  const { service } = fixture({ timeoutMs: 20 }, () => new Promise(() => {}));
  const started = Date.now();
  await assert.rejects(service.search({ q: 'valid', source: 'crossref' }), { status: 503 });
  assert.ok(Date.now() - started < 300);
  for (const handler of [() => response({ message: 'provider failed' }), () => new Response('{}', { headers: { 'content-length': '9999999' } }), () => response({ error: 'secret server detail' })]) {
    const invalid = fixture({}, handler);
    await assert.rejects(invalid.service.search({ q: 'valid', source: 'crossref' }), { status: 503 });
  }
  const invalid = fixture({}, () => assert.fail('must not fetch'));
  for (const params of [{}, { q: 'valid', source: 'https://evil.invalid' }, { q: 'valid', page: 0 }, { q: 'valid', discipline: 'arbitrary' }, { q: 'a' }, { q: 'x\u0000y' }]) await assert.rejects(invalid.service.search(params), { status: 400 });
  assert.equal(PROVIDERS.find(item => item.id === 'core').supported, false);
  await assert.rejects(invalid.service.search({ q: 'valid', source: 'core' }), failure => failure.sourceStatus[0].status === 'unsupported');
});

test('same requests coalesce and cache, and expired results requery', async () => {
  let timestamp = 1000, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls } = fixture({ now: () => timestamp, ttlMs: 100 }, async () => { await gate; return response(crossref); });
  const one = service.search({ q: 'valid', source: 'crossref' }), two = service.search({ q: 'valid', source: 'crossref' });
  release(); await Promise.all([one, two]);
  assert.equal(calls.length, 1);
  assert.equal((await service.search({ q: 'valid', source: 'crossref' })).cached, true);
  timestamp += 101;
  assert.equal((await service.search({ q: 'valid', source: 'crossref' })).cached, false);
  assert.equal(calls.length, 2);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('different concurrent queries wait in FIFO order and complete without a spurious busy error', async () => {
  const firstStarted = deferred(), secondStarted = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  const { service, calls } = fixture({ timeoutMs: 1000 }, async request => {
    const query = request.searchParams.get('query.bibliographic');
    if (query === 'first') { firstStarted.resolve(); await releaseFirst.promise; }
    if (query === 'second') { secondStarted.resolve(); await releaseSecond.promise; }
    return response(crossref);
  });
  const one = service.search({ q: 'first', source: 'crossref' });
  await firstStarted.promise;
  const two = service.search({ q: 'second', source: 'crossref' });
  const three = service.search({ q: 'third', source: 'crossref' });
  await tick(); assert.equal(calls.length, 1);
  releaseFirst.resolve(); await secondStarted.promise;
  assert.equal(calls.length, 2);
  releaseSecond.resolve();
  const results = await Promise.all([one, two, three]);
  assert.ok(results.every(result => result.results.length === 1));
  assert.deepEqual(calls.map(call => call.url.searchParams.get('query.bibliographic')), ['first', 'second', 'third']);
});

test('provider FIFO has four waiting slots, overflows as 429, and identical queries still coalesce', async () => {
  const started = deferred(), release = deferred();
  const { service, calls } = fixture({ timeoutMs: 1000 }, async () => { started.resolve(); await release.promise; return response(crossref); });
  const first = service.search({ q: 'first', source: 'crossref' });
  await started.promise;
  const queued = Array.from({ length: 4 }, (_, n) => service.search({ q: `queued-${n}`, source: 'crossref' }));
  const duplicate = service.search({ q: 'queued-0', source: 'crossref' });
  await assert.rejects(service.search({ q: 'overflow', source: 'crossref' }), failure => failure.status === 429 && failure.sourceStatus[0].error.includes('频率'));
  assert.equal(calls.length, 1);
  release.resolve(); await Promise.all([first, ...queued, duplicate]);
  assert.equal(calls.length, 5);
});

test('queued timeout removes only that waiter; a timed-out holder keeps ownership until its work settles', async () => {
  const started = deferred(), release = deferred();
  const { service, calls } = fixture({ timeoutMs: 70 }, async request => {
    if (request.searchParams.get('query.bibliographic') === 'holder') { started.resolve(); await release.promise; }
    return response(crossref);
  });
  // Simulate an upstream implementation that ignores AbortSignal, to verify
  // neither deadline nor an expired waiter can unlock another request's lane.
  const first = service.search({ q: 'holder', source: 'crossref' }).catch(failure => failure);
  await started.promise;
  const second = service.search({ q: 'expired-waiter', source: 'crossref' }).catch(failure => failure);
  assert.equal((await first).status, 503);
  assert.equal((await second).status, 503);
  assert.equal(calls.length, 1);
  const third = service.search({ q: 'after-timeout', source: 'crossref' });
  await tick(); assert.equal(calls.length, 1);
  release.resolve();
  assert.equal((await third).results.length, 1);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('query.bibliographic')), ['holder', 'after-timeout']);
  // A late successful response to the first request must not enter the cache.
  assert.equal((await service.search({ q: 'holder', source: 'crossref' })).cached, false);
});

test('queues survive credential changes and preserve provider request spacing', async () => {
  let keys = { S2_API_KEY: 'old-key' }, clock = 1000;
  const started = deferred(), release = deferred();
  const { service, calls } = fixture({ credentials: () => keys, now: () => clock, timeoutMs: 1500 }, async () => {
    if (calls.length === 1) { started.resolve(); await release.promise; }
    return response(semantic);
  });
  const first = service.search({ q: 'first', source: 'semantic_scholar' });
  await started.promise;
  keys = { S2_API_KEY: 'new-key' };
  const second = service.search({ q: 'second', source: 'semantic_scholar' });
  await tick(); assert.equal(calls.length, 1);
  // Advance injected rate clock so only a short part of the one-second spacing
  // remains. The shared lane and schedule must survive adapter replacement.
  clock = 1990;
  release.resolve(); await first;
  await tick(); assert.equal(calls.length, 1);
  await second;
  assert.deepEqual(calls.map(call => call.init.headers['x-api-key']), ['old-key', 'new-key']);
});

test('all actual providers returning rate limits preserve HTTP 429 despite an unconfigured optional provider', async () => {
  const { service } = fixture({}, () => new Response('{}', { status: 429 }));
  await assert.rejects(service.search({ q: 'valid' }), failure => failure.status === 429 && failure.sourceStatus.filter(source => source.status === 'error').length === 3);
});

const unpaywall = {
  doi: DOI, doi_url: `https://doi.org/${DOI}`, title, year: 2024, is_oa: true, oa_status: 'green',
  z_authors: [{ given: 'Ada', family: 'Lovelace' }],
  best_oa_location: { url: 'https://repository.example.org/paper', url_for_landing_page: 'https://repository.example.org/paper', url_for_pdf: null, license: 'cc-by', version: 'acceptedVersion', host_type: 'repository' },
  oa_locations: [{ url: 'https://publisher.example.org/article.pdf', url_for_pdf: 'https://publisher.example.org/article.pdf', url_for_landing_page: 'https://publisher.example.org/article', license: 'cc-by', version: 'publishedVersion', host_type: 'publisher' }],
};

test('Unpaywall DOI lookup uses the configured email and returns normalized OA locations without proxying PDFs', async () => {
  const contact = 'project@research.example.org';
  const { service, calls } = fixture({ credentials: () => ({ UNPAYWALL_EMAIL: contact }) }, () => response(unpaywall));
  const result = await service.search({ q: `https://doi.org/${DOI.toUpperCase()}`, source: 'unpaywall' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://api.unpaywall.org');
  assert.equal(decodeURIComponent(calls[0].url.pathname), '/v2/' + DOI);
  assert.equal(calls[0].url.searchParams.get('email'), contact);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(result.lookupStatus, 'open');
  assert.equal(result.sourceStatus[0].lookupStatus, 'open');
  assert.equal(result.hasMore, false);
  assert.equal(result.results[0].openAccess, true);
  assert.equal(result.results[0].openAccessSource, 'unpaywall');
  assert.equal(result.results[0].oaStatus, 'green');
  assert.equal(result.results[0].pdfUrl, 'https://publisher.example.org/article.pdf');
  assert.deepEqual(result.results[0].authors, ['Ada Lovelace']);
  assert.equal(result.results[0].oaLocations[0].version, 'acceptedVersion');
  assert.equal(result.results[0].oaLocations[1].hostType, 'publisher');
  assert.equal(result.results[0].canRead, false);
  assert.doesNotMatch(JSON.stringify(result), /project@research\.example\.org/);
  assert.equal((await service.search({ q: `https://doi.org/${DOI.toUpperCase()}`, source: 'unpaywall' })).cached, true);
  assert.equal(calls.length, 1);
});

test('Unpaywall distinguishes a known closed article, absent DOI and upstream failure', async () => {
  const options = { credentials: () => ({ UNPAYWALL_EMAIL: 'project@research.example.org' }) };
  const closed = fixture(options, () => response({ ...unpaywall, is_oa: false, oa_status: 'closed' }));
  const known = await closed.service.search({ q: DOI, source: 'unpaywall' });
  assert.equal(known.lookupStatus, 'closed');
  assert.equal(known.results.length, 1);
  assert.equal(known.results[0].openAccess, false);
  assert.equal(known.results[0].pdfUrl, null);
  assert.deepEqual(known.results[0].oaLocations, []);
  assert.match(known.note, /目前未发现开放获取位置/);
  const missing = fixture(options, () => new Response('{"error":true}', { status: 404 }));
  const absent = await missing.service.search({ q: DOI, source: 'unpaywall' });
  assert.equal(absent.lookupStatus, 'not_found');
  assert.equal(absent.results.length, 0);
  assert.equal(absent.sourceStatus[0].status, 'ok');
  assert.match(absent.note, /未收录.*不能据此判断/);
  for (const status of [403, 429, 500]) {
    const failed = fixture(options, () => new Response('{"error":"private-email@secret.example"}', { status }));
    await assert.rejects(failed.service.search({ q: DOI, source: 'unpaywall' }), failure => {
      assert.equal(failure.status, status === 429 ? 429 : 503);
      assert.equal(failure.sourceStatus[0].status, 'error');
      assert.doesNotMatch(JSON.stringify(failure), /private-email|secret\.example/);
      return true;
    });
  }
});

test('Unpaywall is enabled only for DOI lookup, with credentials and author conditions respected', async () => {
  const { service, calls } = fixture({ credentials: () => ({ UNPAYWALL_EMAIL: 'project@research.example.org' }) }, () => response(unpaywall));
  for (const params of [{ q: 'machine learning' }, { author: 'Ada Lovelace' }]) {
    await assert.rejects(service.search({ ...params, source: 'unpaywall' }), failure => failure.sourceStatus[0].status === 'skipped');
  }
  assert.equal(calls.length, 0);
  assert.equal((await service.search({ q: DOI, source: 'unpaywall', page: 2 })).hasMore, false);
  assert.equal(calls.length, 0);
  const mismatch = await service.search({ q: DOI, author: 'Different Author', source: 'unpaywall' });
  assert.equal(mismatch.results.length, 0);
  assert.match(mismatch.note, /作者条件.*不匹配/);
  const matched = await service.search({ q: DOI, author: 'lovelace', source: 'unpaywall' });
  assert.equal(matched.results.length, 1);
  const unconfigured = fixture({}, () => assert.fail('must not request without an email'));
  await assert.rejects(unconfigured.service.search({ q: DOI, source: 'unpaywall' }), failure => failure.sourceStatus[0].status === 'unconfigured');
  const disabled = fixture({ credentials: () => ({ UNPAYWALL_EMAIL: 'project@research.example.org' }), disabledSources: () => ['unpaywall'] }, () => assert.fail('must not request a disabled source'));
  await assert.rejects(disabled.service.search({ q: DOI, source: 'unpaywall' }), failure => failure.sourceStatus[0].status === 'disabled');
  assert.equal(PROVIDERS.find(item => item.id === 'unpaywall').supported, true);
});

test('DOI federation automatically includes Unpaywall and enriches the merged record; keyword searches do not call it', async () => {
  const { service, calls } = fixture({ credentials: () => ({ UNPAYWALL_EMAIL: 'project@research.example.org' }) }, url => {
    if (url.hostname === 'api.unpaywall.org') return response(unpaywall);
    if (url.hostname === 'api.openalex.org') return response(openalex);
    if (url.hostname === 'api.crossref.org') return response(crossref);
    return response(url.pathname.includes('/DOI:') ? semantic.data[0] : semantic);
  });
  const result = await service.search({ q: DOI });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].doi, DOI);
  assert.equal(result.results[0].sources.at(-1).id, 'unpaywall');
  assert.equal(result.results[0].pdfUrl, 'https://publisher.example.org/article.pdf');
  assert.equal(result.results[0].openAccessSource, 'unpaywall');
  assert.equal(result.results[0].oaLocations.length, 2);
  assert.equal(result.sourceStatus.find(item => item.id === 'unpaywall').lookupStatus, 'open');
  const previous = calls.filter(call => call.url.hostname === 'api.unpaywall.org').length;
  const keywords = await service.search({ q: 'machine learning' });
  assert.equal(calls.filter(call => call.url.hostname === 'api.unpaywall.org').length, previous);
  assert.equal(keywords.sourceStatus.some(item => item.id === 'unpaywall'), false);
});

test('Unpaywall rejects mismatched records and strips unsafe or embargoed location URLs', async () => {
  const options = { credentials: () => ({ UNPAYWALL_EMAIL: 'project@research.example.org' }) };
  for (const patch of [{ doi: '10.1234/other' }, { is_oa: 'true' }, { title: '' }]) {
    const invalid = fixture(options, () => response({ ...unpaywall, ...patch }));
    await assert.rejects(invalid.service.search({ q: DOI, source: 'unpaywall' }), { status: 503 });
  }
  const { service } = fixture(options, () => response({ ...unpaywall,
    best_oa_location: { url: 'javascript:alert(1)', url_for_pdf: 'file:///secret.pdf' },
    oa_locations: [{ url: 'https://user:password@private.example/file.pdf', url_for_pdf: 'data:text/html,unsafe' }, unpaywall.oa_locations[0], unpaywall.oa_locations[0]],
    oa_locations_embargoed: [{ url: 'https://embargoed.example/file.pdf', url_for_pdf: 'https://embargoed.example/file.pdf' }],
  }));
  const result = await service.search({ q: DOI, source: 'unpaywall' });
  assert.equal(result.results[0].oaLocations.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /javascript:|file:|data:text|password|embargoed\.example/);
});

test('DataCite sparse fields omit oversized unrelated metadata while retaining the response size guard', async () => {
  const { service, calls } = fixture({}, request => {
    const sparse = request.searchParams.get('fields[dois]');
    if (!sparse) return response({ data: [], ignoredXml: 'x'.repeat(3 * 1024 * 1024) });
    return response({ data: [{ id: DOI, attributes: { titles: [{ title }], creators: [{ name: 'Ada' }], publicationYear: 2024, descriptions: [{ descriptionType: 'Abstract', description: 'Only needed fields' }], types: { resourceTypeGeneral: 'Dataset' } } }], meta: { total: 1 } });
  });
  const result = await service.search({ q: 'research dataset', source: 'datacite' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].abstract, 'Only needed fields');
  assert.doesNotMatch(calls[0].url.searchParams.get('fields[dois]'), /xml|relatedIdentifiers|contributors|fundingReferences/);
  const oversized = fixture({}, () => response({ data: [], excess: 'x'.repeat(2 * 1024 * 1024) }));
  await assert.rejects(oversized.service.search({ q: 'research dataset', source: 'datacite' }), { status: 503 });
});
