import test from 'node:test';
import assert from 'node:assert/strict';
import { createScholarLookup, normalizeOrcid, rankScholarCandidates } from '../lib/scholars.mjs';

const specimen = { id: 'https://openalex.org/A5126602136', display_name: 'Test Researcher', orcid: 'https://orcid.org/0009-0008-5473-5367', works_count: 2, cited_by_count: 4, last_known_institutions: [{ display_name: 'Research Institution' }], topics: [] };

test('ORCID checksum and author identifiers are validated before external requests', async () => {
  assert.equal(normalizeOrcid('https://orcid.org/0009-0008-5473-5367'), '0009-0008-5473-5367');
  assert.equal(normalizeOrcid('0009-0008-5473-5368'), null);
  const lookup = createScholarLookup({ fetchImpl: () => { throw new Error('must not request'); } });
  await assert.rejects(lookup.author('https://localhost/private'), { status: 400 });
  await assert.rejects(lookup.search('0009-0008-5473-5368'), { status: 400 });
  await assert.rejects(lookup.search('a'), { status: 400 });
});

test('source, unverified identity and bounded cache preserve real response provenance', async () => {
  let calls = 0; let requested;
  const lookup = createScholarLookup({ apiKey: 'test-key-not-real', now: () => 1_000_000, fetchImpl: async (url, options) => {
    calls++; requested = String(url);
    assert.equal(new URL(url).host, 'api.openalex.org');
    assert.equal(options.headers.Authorization, 'Bearer test-key-not-real');
    assert.equal(options.redirect, 'error');
    return Response.json({ meta: { count: 1 }, results: [specimen] });
  } });
  const first = await lookup.search('Test Researcher');
  assert.equal(first.results[0].identityStatus, 'public-record-unverified');
  assert.equal(first.source, 'openalex');
  assert.equal(first.cached, false);
  first.results[0].name = 'client mutation';
  const second = await lookup.search('Test Researcher');
  assert.equal(second.cached, true);
  assert.equal(second.results[0].name, 'Test Researcher');
  assert.equal(calls, 1);
  assert(!requested.includes('test-key-not-real'));
});

test('upstream rate and format failures remain errors, never replaced by sample results', async () => {
  const rateLimited = createScholarLookup({ fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(rateLimited.search('name'), error => error.status === 503 && error.message.includes('额度'));
  const malformed = createScholarLookup({ fetchImpl: async () => Response.json({ error: 'bad' }) });
  await assert.rejects(malformed.search('name'), { status: 502 });
  const missing = createScholarLookup({ fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(missing.author('A123'), { status: 404 });
});

test('ORCID search sends an exact filter and never asserts account ownership', async () => {
  let requested;
  const lookup = createScholarLookup({ fetchImpl: async url => { requested = new URL(url); return Response.json({ results: [specimen] }); } });
  const result = await lookup.search('0009-0008-5473-5367');
  assert.equal(requested.searchParams.get('filter'), 'orcid:https://orcid.org/0009-0008-5473-5367');
  assert(!requested.searchParams.has('search'));
  assert.equal(result.results[0].identityStatus, 'public-record-unverified');
  assert.match(result.limitation, /不代表/);
});

test('Chinese name variants merge bounded public candidates and explicitly report partial failures', async () => {
  const queries = [];
  const lookup = createScholarLookup({ fetchImpl: async url => {
    const query = new URL(url).searchParams.get('search'); queries.push(query);
    if (query === 'Zhiyuan Lv') return new Response('', { status: 429 });
    return Response.json({ meta: { count: 999 }, results: [specimen, { ...specimen, id: 'https://openalex.org/A12345', display_name: 'Zhiyuan Lu' }] });
  } });
  const result = await lookup.search('吕志远');
  assert.deepEqual(new Set(queries), new Set(['吕志远', 'Zhiyuan Lv', 'Zhiyuan Lyu', 'Zhiyuan Lu']));
  assert.equal(result.results.length, 2);
  assert.equal(result.partial, true);
  assert.deepEqual(result.failedVariants, ['Zhiyuan Lv']);
  assert.equal(result.queries.length, 3);
  assert.equal(result.totalIsExact, false);
  assert(result.results.every(person => person.identityStatus === 'public-record-unverified'));
});

test('all variant requests failing stays an upstream error and never returns an empty success', async () => {
  const lookup = createScholarLookup({ fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(lookup.search('吕志远'), { status: 503 });
});

const hohai = { id: 'https://openalex.org/I163340411', display_name: 'Hohai University', display_name_alternatives: ['Hohai University', '河海大学'], display_name_acronyms: [] };
const wanjiang = { id: 'https://openalex.org/I4405280001', display_name: 'Wanjiang University of Technology', display_name_alternatives: ['河海大学文天学院', '皖江工学院'], display_name_acronyms: [] };
const noisy = { id: 'https://openalex.org/I10000000', display_name: 'Coastal Laboratory', display_name_alternatives: ['河口海岸实验室'], display_name_acronyms: [] };

test('institution names resolve upstream and filter the full author query; exact aliases beat partial former names', async () => {
  const calls = [];
  const lookup = createScholarLookup({ apiKey: 'server-only-key', fetchImpl: async (url, options) => {
    calls.push(new URL(url));
    assert.equal(options.headers.Authorization, 'Bearer server-only-key');
    if (url.pathname === '/institutions') return Response.json({ meta: { count: 3 }, results: [wanjiang, noisy, hohai] });
    assert.equal(url.pathname, '/authors');
    assert.equal(url.searchParams.get('search'), 'Li Wei');
    assert.equal(url.searchParams.get('filter'), 'last_known_institutions.id:I163340411');
    return Response.json({ meta: { count: 1 }, results: [{ ...specimen, id: 'https://openalex.org/A9999999' }] });
  } });
  const result = await lookup.search('Li Wei', { institution: '河海大学' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, '/institutions');
  assert.equal(calls[0].searchParams.get('search'), '河海大学');
  assert.equal(result.results[0].id, 'A9999999');
  assert.equal(result.institution.status, 'matched');
  assert.equal(result.institution.scope, 'last-known-institutions');
  assert.deepEqual(result.institution.matches.map(item => item.id), ['I163340411']);
  assert.equal(result.institution.ambiguous, false);
  assert(!JSON.stringify(result).includes('server-only-key'));
});

test('partial Chinese institution matches stay explicit and exclude unrelated fuzzy search noise', async () => {
  const lookup = createScholarLookup({ fetchImpl: async url => {
    if (url.pathname === '/institutions') return Response.json({ results: [noisy, hohai, wanjiang] });
    assert.equal(url.searchParams.get('filter'), 'last_known_institutions.id:I163340411|I4405280001');
    return Response.json({ results: [specimen] });
  } });
  const result = await lookup.search('Li Wei', { institution: '河海' });
  assert.equal(result.institution.ambiguous, true);
  assert.deepEqual(result.institution.matches.map(item => item.name), ['Hohai University', 'Wanjiang University of Technology']);
  assert(result.institution.matches.every(item => item.matchedAliases.some(alias => alias.includes('河海'))));
});

test('English partial names and official acronyms resolve without an invented institution catalog', async () => {
  for (const [query, institution] of [['Hohai', hohai], ['HHU', { ...hohai, id: 'https://openalex.org/I44260953', display_name: 'Heinrich Heine University Düsseldorf', display_name_alternatives: [], display_name_acronyms: ['HHU'] }]]) {
    const lookup = createScholarLookup({ fetchImpl: async url => {
      if (url.pathname === '/institutions') return Response.json({ results: [institution] });
      assert.equal(url.searchParams.get('filter'), 'last_known_institutions.id:' + institution.id.split('/').at(-1));
      return Response.json({ results: [specimen] });
    } });
    const result = await lookup.search('Li Wei', { institution: query });
    assert.equal(result.institution.matches[0].name, institution.display_name);
  }
});

test('empty institution preserves broad name search and filtered caches cannot poison unfiltered results', async () => {
  const calls = [];
  const lookup = createScholarLookup({ fetchImpl: async url => {
    calls.push(new URL(url));
    if (url.pathname === '/institutions') return Response.json({ results: [hohai] });
    const isFiltered = url.searchParams.has('filter');
    return Response.json({ results: [{ ...specimen, display_name: isFiltered ? 'Filtered Person' : 'Broad Person' }] });
  } });
  assert.equal((await lookup.search('Li Wei', { institution: '   ' })).results[0].name, 'Broad Person');
  assert.equal((await lookup.search('Li Wei', { institution: 'Hohai' })).results[0].name, 'Filtered Person');
  const broad = await lookup.search('Li Wei');
  assert.equal(broad.results[0].name, 'Broad Person');
  assert.equal(Object.hasOwn(broad, 'institution'), false);
  assert.equal(calls.filter(url => url.pathname === '/authors').length, 2);
});

test('unrecognized institution does not query authors or imply the researcher is absent', async () => {
  const lookup = createScholarLookup({ fetchImpl: async url => {
    assert.equal(url.pathname, '/institutions');
    return Response.json({ results: [noisy] });
  } });
  const result = await lookup.search('Li Wei', { institution: 'Unknown College' });
  assert.equal(result.institution.status, 'unresolved');
  assert.equal(result.institution.applied, false);
  assert.deepEqual(result.results, []);
  assert.match(result.institution.note, /不代表没有同名学者/);
});

test('unavailable institution lookup returns a sanitized explicit error, never unfiltered success', async () => {
  for (const fetchImpl of [async () => { throw new Error('upstream credential secret'); }, async () => Response.json({ results: [{ id: 'broken' }] })]) {
    const lookup = createScholarLookup({ fetchImpl });
    await assert.rejects(lookup.search('Li Wei', { institution: 'Hohai' }), error => {
      assert.equal(error.status, 503);
      assert.equal(error.institution.status, 'unavailable');
      assert.doesNotMatch(error.message, /credential|secret/);
      return true;
    });
  }
});

test('invalid institution input is rejected before upstream work, and unique author IDs take precedence', async () => {
  const lookup = createScholarLookup({ fetchImpl: async url => {
    assert.equal(url.pathname.startsWith('/authors'), true);
    assert.equal(url.searchParams.has('search'), false);
    return Response.json(url.pathname === '/authors' ? { results: [specimen] } : specimen);
  } });
  for (const institution of ['a', 'a'.repeat(161), 'Hohai\0University', '???', {}]) await assert.rejects(lookup.search('Li Wei', { institution }), { status: 400 });
  for (const query of ['A5126602136', '0009-0008-5473-5367']) {
    const result = await lookup.search(query, { institution: 'Some Other University' });
    assert.equal(result.results[0].id, 'A5126602136');
    assert.equal(result.institution.status, 'ignored');
    assert.equal(result.institution.reason, 'identifier-priority');
  }
});


test('candidate affiliation priority is stable within the same name relevance, without promoting fuzzy names', () => {
  const records = [
    { id: 'A1', name: '徐林森', institutions: [] },
    { id: 'A2', name: '徐林森', institutions: ['Hohai University'] },
    { id: 'A3', name: 'Linsen Xu', institutions: ['Unknown', '—'] },
    { id: 'A4', name: 'Linsen Xu', institutions: ['Research Institute'] },
    { id: 'A5', name: '徐林森', institutions: ['Other University'] },
    { id: 'A6', name: 'Unrelated Person', institutions: ['Best University'] },
  ];
  assert.deepEqual(rankScholarCandidates(records, '徐林森', ['Linsen Xu']).map(item => item.id), ['A2', 'A4', 'A5', 'A1', 'A3', 'A6']);
  assert.deepEqual(records.map(item => item.id), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
});

test('search puts affiliated same-name profiles before empty records even when empty profile has many publications', async () => {
  const lookup = createScholarLookup({ fetchImpl: async () => Response.json({ results: [
    { ...specimen, id: 'https://openalex.org/A1', display_name: 'Linsen Xu', works_count: 999, last_known_institutions: [] },
    { ...specimen, id: 'https://openalex.org/A2', display_name: 'Linsen Xu', works_count: 1 },
  ] }) });
  assert.deepEqual((await lookup.search('Linsen Xu')).results.map(item => item.id), ['A2', 'A1']);
});


test('a full pinyin alias with an institution outranks an unaffiliated Chinese record for 徐林森', async () => {
  const lookup = createScholarLookup({ fetchImpl: async () => Response.json({ results: [
    { ...specimen, id: 'https://openalex.org/A1', display_name: '徐林森', last_known_institutions: [] },
    { ...specimen, id: 'https://openalex.org/A2', display_name: 'Linsen Xu', last_known_institutions: [{ display_name: 'Hohai University' }] },
    { ...specimen, id: 'https://openalex.org/A3', display_name: 'Unrelated Person' },
  ] }) });
  assert.deepEqual((await lookup.search('徐林森')).results.map(item => item.id), ['A2', 'A1', 'A3']);
});
