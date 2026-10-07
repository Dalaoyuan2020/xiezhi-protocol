import { createHash } from 'node:crypto';
import { createSciverse } from './sciverse.mjs';

// Env names are a fixed administration allowlist, never an arbitrary proxy URL.
export const PROVIDERS = Object.freeze([
  { id: 'sciverse', label: 'Sciverse', envNames: ['SCIVERSE_API_TOKEN'], requiredEnvNames: ['SCIVERSE_API_TOKEN'], modes: ['metadata', 'semantic'], discipline: 'general', supported: true },
  { id: 'openalex', label: 'OpenAlex', envNames: ['OPENALEX_API_KEY'], requiredEnvNames: [], modes: ['metadata'], discipline: 'general', supported: true },
  { id: 'crossref', label: 'Crossref', envNames: ['CROSSREF_MAILTO'], requiredEnvNames: [], modes: ['metadata'], discipline: 'general', supported: true },
  { id: 'semantic_scholar', label: 'Semantic Scholar', envNames: ['S2_API_KEY'], requiredEnvNames: [], modes: ['metadata'], discipline: 'general', supported: true },
  { id: 'europe_pmc', label: 'Europe PMC', envNames: [], requiredEnvNames: [], modes: ['metadata'], discipline: 'biomedical', supported: true },
  { id: 'pubmed', label: 'PubMed', envNames: ['NCBI_API_KEY', 'NCBI_EMAIL'], requiredEnvNames: [], modes: ['metadata'], discipline: 'biomedical', supported: true },
  { id: 'arxiv', label: 'arXiv', envNames: [], requiredEnvNames: [], modes: ['metadata'], discipline: 'stem', supported: true },
  { id: 'datacite', label: 'DataCite', envNames: [], requiredEnvNames: [], modes: ['metadata'], discipline: 'data', supported: true },
  { id: 'nasa_ads', label: 'NASA ADS', envNames: ['ADS_DEV_KEY'], requiredEnvNames: ['ADS_DEV_KEY'], modes: ['metadata'], discipline: 'astronomy', supported: true },
  { id: 'core', label: 'CORE', envNames: ['CORE_API_KEY'], requiredEnvNames: ['CORE_API_KEY'], modes: [], discipline: 'general', supported: false },
  { id: 'openaire', label: 'OpenAIRE', envNames: ['OPENAIRE_TOKEN'], requiredEnvNames: [], modes: [], discipline: 'general', supported: false },
  { id: 'unpaywall', label: 'Unpaywall', envNames: ['UNPAYWALL_EMAIL'], requiredEnvNames: ['UNPAYWALL_EMAIL'], modes: ['metadata'], discipline: 'general', supported: true },
  { id: 'springer', label: 'Springer Nature', envNames: ['SPRINGER_API_KEY'], requiredEnvNames: ['SPRINGER_API_KEY'], modes: [], discipline: 'general', supported: false },
  { id: 'epo', label: 'EPO OPS', envNames: ['EPO_OPS_KEY', 'EPO_OPS_SECRET'], requiredEnvNames: ['EPO_OPS_KEY', 'EPO_OPS_SECRET'], modes: [], discipline: 'patents', supported: false },
  { id: 'lens', label: 'The Lens', envNames: ['LENS_API_TOKEN'], requiredEnvNames: ['LENS_API_TOKEN'], modes: [], discipline: 'general', supported: false },
]);
const BY_ID = new Map(PROVIDERS.map(item => [item.id, item]));
const ENV_NAMES = [...new Set(PROVIDERS.flatMap(item => item.envNames))];
const PAGE_SIZE = 10;
const error = (status, message) => Object.assign(new Error(message), { status });
const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const valueText = (value, max = 12000) => typeof value === 'string' ? value.slice(0, max) : '';
const quoted = value => `"${value.replace(/[\\"]/g, ' ').trim()}"`;
const label = id => BY_ID.get(id)?.label || id;
function url(value) {
  try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.href.length <= 2048 ? parsed.href : null; } catch { return null; }
}
function doi(value) {
  const normalized = valueText(value, 300).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim().toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(normalized) ? normalized : null;
}
function arxivId(value) {
  const normalized = valueText(value, 200).replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/^arxiv:/i, '').replace(/\.pdf$/i, '').replace(/v\d+$/, '');
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(normalized) ? normalized : null;
}
function plain(value) {
  return valueText(value).replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const code = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }).replace(/\s+/g, ' ').trim();
}
function paper(source, input) {
  const title = plain(input.title);
  if (!title || !input.id) return null;
  const normalizedDoi = doi(input.doi), year = Number(input.year);
  const authors = Array.isArray(input.authors) ? [...new Set(input.authors.map(item => plain(item)).filter(Boolean))].slice(0, 100) : [];
  const target = url(input.url) || (normalizedDoi ? `https://doi.org/${normalizedDoi}` : null);
  return { ...input, id: valueText(String(input.id), 500), title, authors, source,
    sources: [{ id: source, label: label(source), url: target }], docId: input.docId || null,
    doi: normalizedDoi, pmid: /^\d{1,12}$/.test(String(input.pmid || '')) ? String(input.pmid) : null, arxivId: arxivId(input.arxivId),
    year: Number.isInteger(year) && year >= 1000 && year <= 2200 ? year : null, url: target, abstract: plain(input.abstract), snippet: valueText(input.snippet),
    canRead: source === 'sciverse' && input.canRead === true, pdfUrl: url(input.pdfUrl),
    citationCount: input.citationCount == null ? null : number(input.citationCount),
  };
}
function abstractFromIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return '';
  const words = [];
  for (const [word, positions] of Object.entries(index).slice(0, 5000)) if (Array.isArray(positions)) for (const position of positions.slice(0, 500)) if (Number.isInteger(position) && position >= 0 && position < 5000) words[position] = word;
  return words.join(' ');
}
function titleKey(item) { return item.year ? `title:${item.title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}:${item.year}` : null; }
function identityKeys(item) { return [item.doi && `doi:${item.doi}`, item.pmid && `pmid:${item.pmid}`, item.arxivId && `arxiv:${item.arxivId}`, titleKey(item)].filter(Boolean); }
function compatible(a, b) {
  if (a.doi && b.doi) return a.doi === b.doi;
  if (a.pmid && b.pmid) return a.pmid === b.pmid;
  if (a.arxivId && b.arxivId) return a.arxivId === b.arxivId;
  return true;
}
export function mergeLiteratureResults(items) {
  const merged = [], index = new Map();
  for (const item of items) {
    const keys = identityKeys(item);
    const target = keys.map(key => index.get(key)).find(existing => existing && compatible(existing, item));
    if (!target) { merged.push(item); for (const key of keys) if (!index.has(key)) index.set(key, item); continue; }
    for (const key of ['doi', 'pmid', 'arxivId', 'year', 'url', 'pdfUrl', 'abstract']) if (!target[key] && item[key]) target[key] = item[key];
    if (!target.authors.length && item.authors.length) target.authors = item.authors;
    if (item.source === 'semantic_scholar') { if (item.abstract) { target.abstract = item.abstract; target.abstractSource = item.source; } if (item.citationCount != null) { target.citationCount = item.citationCount; target.citationCountSource = item.source; } }
    if (item.source === 'openalex') { target.institutions = item.institutions || []; target.openAccess = item.openAccess; if (item.pdfUrl) target.pdfUrl = item.pdfUrl; }
    if (item.source === 'crossref') { target.licenses = item.licenses || []; target.funders = item.funders || []; }
    if (item.source === 'unpaywall') {
      target.openAccess = item.openAccess; target.openAccessSource = 'unpaywall';
      target.oaStatus = item.oaStatus; target.oaLocations = item.oaLocations;
      // Keep an independently reported PDF if Unpaywall found no current OA location.
      // Its absence is not evidence that another provider's location is invalid.
      if (item.pdfUrl) target.pdfUrl = item.pdfUrl;
    }
    if (item.canRead) { target.canRead = true; target.docId = item.docId; }
    for (const provenance of item.sources) if (!target.sources.some(existing => existing.id === provenance.id)) target.sources.push(provenance);
    for (const key of identityKeys(target)) if (!index.has(key)) index.set(key, target);
  }
  return merged;
}

export function createLiterature({ credentials = () => process.env, disabledSources = () => [], fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = 300000, timeoutMs = 8000, sciverseFactory = createSciverse } = {}) {
  let state;
  const lanes = new Map(), nextRequest = new Map();
  const maximumWaiting = 4;
  function acquire(source, signal) {
    if (signal.aborted) return Promise.reject(error(503, '数据源响应超时。'));
    let lane = lanes.get(source);
    if (!lane) {
      lane = { waiting: [] };
      lanes.set(source, lane);
      return Promise.resolve(releaseFor(source, lane));
    }
    if (lane.waiting.length >= maximumWaiting) return Promise.reject(error(429, '数据源等待队列已满，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, abort: null };
      waiter.abort = () => {
        const index = lane.waiting.indexOf(waiter);
        if (index !== -1) lane.waiting.splice(index, 1);
        reject(error(503, '数据源响应超时。'));
      };
      lane.waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  function releaseFor(source, lane) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (lane.waiting.length) {
        const next = lane.waiting.shift();
        next.signal.removeEventListener('abort', next.abort);
        if (next.signal.aborted) { next.reject(error(503, '数据源响应超时。')); continue; }
        next.resolve(releaseFor(source, lane));
        return;
      }
      if (lanes.get(source) === lane) lanes.delete(source);
    };
  }
  function current() {
    const provided = credentials() || {};
    const secrets = Object.fromEntries(ENV_NAMES.map(name => [name, typeof provided[name] === 'string' ? provided[name].trim() : '']));
    const disabled = [...new Set(disabledSources().filter(id => BY_ID.has(id)))].sort();
    const signature = createHash('sha256').update(JSON.stringify({ secrets, disabled })).digest('hex');
    if (!state || signature !== state.signature) state = { signature, secrets, disabled, cache: new Map(), pending: new Map(), cursors: new Map(),
      sciverse: sciverseFactory({ token: secrets.SCIVERSE_API_TOKEN, fetchImpl, now, ttlMs, timeoutMs: Math.max(1, Math.floor(timeoutMs / 2) - 10), semanticTimeoutMs: timeoutMs }) };
    return state;
  }
  function publicProviders() { return PROVIDERS.map(({ id, label, modes, discipline, supported }) => ({ id, label, modes: [...modes], discipline, supported })); }
  function health() { const context = current(); return { configured: PROVIDERS.some(item => item.supported && !context.disabled.includes(item.id) && item.requiredEnvNames.every(key => context.secrets[key])), source: 'multiple', mode: 'read-only', tools: ['list_catalog', 'search_papers', 'semantic_search', 'read_content', 'get_resource'], providers: publicProviders() }; }
  function unavailable(context, id) {
    const provider = BY_ID.get(id);
    if (context.disabled.includes(id)) return 'disabled';
    if (!provider.supported) return 'unsupported';
    if (!provider.requiredEnvNames.every(key => context.secrets[key])) return 'unconfigured';
    return null;
  }
  async function fetchData(base, params, { signal, headers = {}, atom = false, allowNotFound = false } = {}) {
    const target = new URL(base);
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== '') target.searchParams.set(key, String(value));
    const response = await fetchImpl(target, { signal, redirect: 'error', headers: { Accept: atom ? 'application/atom+xml' : 'application/json', 'User-Agent': 'AIA-Literature/1.0', ...headers } });
    if (allowNotFound && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw error(response.status === 429 ? 429 : [401, 403].includes(response.status) ? 403 : 502, '数据源暂时不可用。'); }
    const maximum = 2 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw error(502, '数据源响应过大。'); }
    const reader = response.body?.getReader();
    if (!reader) throw error(502, '数据源响应不完整。');
    let size = 0; const chunks = [];
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maximum) { await reader.cancel(); throw error(502, '数据源响应过大。'); } chunks.push(Buffer.from(part.value)); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (atom) return text;
    try { const data = JSON.parse(text); if (data?.error || data?.errors) throw error(502, '数据源返回错误。'); return data; } catch { throw error(502, '数据源返回格式异常。'); }
  }
  function list(value) { if (!Array.isArray(value)) throw error(502, '数据源返回的列表不完整。'); return value.slice(0, PAGE_SIZE); }
  function rows(source, items, count, page, note = '') {
    const results = items.map(item => paper(source, item)).filter(Boolean);
    if (items.length && !results.length) throw error(502, '数据源返回的文献不完整。');
    return { results, total: number(count), hasMore: page < 100 && number(count) > page * PAGE_SIZE, note };
  }
  async function providerSearch(context, source, { q, author, page, mode }, signal) {
    const keys = context.secrets, exactDoi = doi(q), offset = (page - 1) * PAGE_SIZE;
    if (source === 'sciverse') {
      const result = await context.sciverse.search({ q, author, page, mode });
      return { ...result, results: result.results.map(item => paper(source, item)).filter(Boolean) };
    }
    if (source === 'openalex') {
      const filters = [exactDoi && `doi:${exactDoi}`, author && `raw_author_name.search:${quoted(author.replace(/[,:|]/g, ' '))}`].filter(Boolean);
      const data = await fetchData('https://api.openalex.org/works', { page, per_page: PAGE_SIZE, ...(!exactDoi && q ? { search: q } : {}), ...(filters.length ? { filter: filters.join(',') } : {}) }, { signal, headers: keys.OPENALEX_API_KEY ? { Authorization: `Bearer ${keys.OPENALEX_API_KEY}` } : {} });
      return rows(source, list(data.results).map(item => ({ id: item.id, title: item.title || item.display_name, authors: item.authorships?.map(entry => entry.author?.display_name), year: item.publication_year, doi: item.doi, pmid: item.ids?.pmid?.split('/').at(-1), abstract: abstractFromIndex(item.abstract_inverted_index), url: item.primary_location?.landing_page_url || item.id, pdfUrl: item.best_oa_location?.pdf_url, citationCount: item.cited_by_count, openAccess: item.open_access?.is_oa === true, institutions: [...new Set(item.authorships?.flatMap(entry => entry.institutions?.map(institution => institution.display_name) || []) || [])].slice(0, 30) })), data.meta?.count, page);
    }
    if (source === 'crossref') {
      const data = await fetchData('https://api.crossref.org/works', { rows: PAGE_SIZE, offset, ...(exactDoi ? { filter: `doi:${exactDoi}` } : q ? { 'query.bibliographic': q } : {}), ...(author ? { 'query.author': author } : {}), ...(keys.CROSSREF_MAILTO ? { mailto: keys.CROSSREF_MAILTO } : {}) }, { signal });
      return rows(source, list(data.message?.items).map(item => ({ id: item.DOI, title: item.title?.[0], authors: item.author?.map(author => author.name || [author.given, author.family].filter(Boolean).join(' ')), year: (item.published || item.issued)?.['date-parts']?.[0]?.[0], doi: item.DOI, url: item.URL, abstract: item.abstract, citationCount: item['is-referenced-by-count'], licenses: (item.license || []).map(license => url(license.URL)).filter(Boolean).slice(0, 10), funders: (item.funder || []).map(funder => plain(funder.name)).slice(0, 20) })), data.message?.['total-results'], page);
    }
    if (source === 'semantic_scholar') {
      if (!q) throw Object.assign(error(400, '该源仅支持论文主题查询，作者条件需配合主题。'), { sourceStatus: 'skipped' });
      const fields = 'title,authors,year,abstract,url,externalIds,openAccessPdf,citationCount';
      const data = await fetchData(exactDoi ? `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(exactDoi)}` : 'https://api.semanticscholar.org/graph/v1/paper/search', { fields, ...(!exactDoi ? { query: q, offset, limit: PAGE_SIZE } : {}) }, { signal, headers: keys.S2_API_KEY ? { 'x-api-key': keys.S2_API_KEY } : {} });
      const items = exactDoi ? (page === 1 ? [data] : []) : list(data.data);
      const normalized = rows(source, items.map(item => ({ id: item.paperId, title: item.title, authors: item.authors?.map(author => author.name), year: item.year, abstract: item.abstract, doi: item.externalIds?.DOI, pmid: item.externalIds?.PubMed, arxivId: item.externalIds?.ArXiv, url: item.url, pdfUrl: item.openAccessPdf?.url, citationCount: item.citationCount })), exactDoi ? 1 : data.total, page);
      if (author) { const wanted = author.normalize('NFKC').toLowerCase().split(/[\s,]+/).filter(Boolean); normalized.results = normalized.results.filter(item => item.authors.some(name => wanted.every(token => name.toLowerCase().includes(token)))); normalized.total = normalized.results.length; normalized.totalIsExact = false; normalized.note = 'Semantic Scholar 作者条件在本页候选上核对，不能代表作者完整成果列表。'; }
      return normalized;
    }
    if (source === 'europe_pmc') {
      const query = [exactDoi ? `DOI:${quoted(exactDoi)}` : q ? `(${q})` : '', author ? `AUTH_FULL:${quoted(author)}` : ''].filter(Boolean).join(' AND ');
      const key = JSON.stringify({ q, author }), cursor = page === 1 ? '*' : context.cursors.get(`${key}:${page}`);
      if (!cursor) throw Object.assign(error(400, '请按顺序读取 Europe PMC 的下一页。'), { sourceStatus: 'skipped' });
      const data = await fetchData('https://www.ebi.ac.uk/europepmc/webservices/rest/search', { query, pageSize: PAGE_SIZE, cursorMark: cursor, resultType: 'core', format: 'json' }, { signal });
      if (data.nextCursorMark && data.nextCursorMark !== cursor) { if (context.cursors.size >= 200) context.cursors.delete(context.cursors.keys().next().value); context.cursors.set(`${key}:${page + 1}`, data.nextCursorMark); }
      const result = rows(source, list(data.resultList?.result).map(item => ({ id: `${item.source}:${item.id}`, title: item.title, authors: item.authorList?.author?.map(author => author.fullName || [author.firstName, author.lastName].filter(Boolean).join(' ')), year: item.pubYear || item.journalInfo?.yearOfPublication, doi: item.doi, pmid: item.pmid || (item.source === 'MED' ? item.id : null), abstract: item.abstractText, url: `https://europepmc.org/article/${encodeURIComponent(item.source)}/${encodeURIComponent(item.id)}`, pdfUrl: item.fullTextUrlList?.fullTextUrl?.find(link => link.documentStyle === 'pdf' && link.availability === 'Open access')?.url, citationCount: item.citedByCount, openAccess: item.isOpenAccess === 'Y' })), data.hitCount, page);
      result.hasMore &&= Boolean(data.nextCursorMark && data.nextCursorMark !== cursor); return result;
    }
    if (source === 'pubmed') {
      const term = [exactDoi ? `${quoted(exactDoi)}[DOI]` : q ? `(${q})` : '', author ? `${quoted(author)}[Author]` : ''].filter(Boolean).join(' AND ');
      const params = { db: 'pubmed', retmode: 'json', tool: 'aia-literature', ...(keys.NCBI_API_KEY ? { api_key: keys.NCBI_API_KEY } : {}), ...(keys.NCBI_EMAIL ? { email: keys.NCBI_EMAIL } : {}) };
      const data = await fetchData('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', { ...params, term, retstart: offset, retmax: PAGE_SIZE, sort: 'relevance' }, { signal });
      const ids = list(data.esearchresult?.idlist).filter(id => /^\d+$/.test(id));
      if (!ids.length) return rows(source, [], data.esearchresult?.count, page);
      await pause(keys.NCBI_API_KEY ? 110 : 350, signal);
      const details = await fetchData('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', { ...params, id: ids.join(',') }, { signal });
      if (!details.result || !Array.isArray(details.result.uids)) throw error(502, 'PubMed 返回的文献不完整。');
      return rows(source, ids.map(id => details.result[id]).filter(Boolean).map(item => ({ id: item.uid, title: item.title, authors: item.authors?.map(author => author.name), year: parseInt(item.pubdate, 10), pmid: item.uid, doi: item.articleids?.find(id => id.idtype === 'doi')?.value, url: `https://pubmed.ncbi.nlm.nih.gov/${item.uid}/` })), data.esearchresult.count, page, 'PubMed 当前返回书目摘要信息；论文摘要和全文以原始来源为准。');
    }
    if (source === 'datacite') {
      const query = [exactDoi ? `doi:${quoted(exactDoi)}` : q ? `(${q})` : '', author ? `creators.name:${quoted(author)}` : ''].filter(Boolean).join(' AND ');
      const data = await fetchData('https://api.datacite.org/dois', { query, 'page[number]': page, 'page[size]': PAGE_SIZE,
        'fields[dois]': 'doi,titles,creators,publicationYear,descriptions,url,types' }, { signal });
      return rows(source, list(data.data).map(record => { const item = record.attributes || {}; return { id: record.id, title: item.titles?.[0]?.title, authors: item.creators?.map(author => author.name || [author.givenName, author.familyName].filter(Boolean).join(' ')), year: item.publicationYear, doi: item.doi || record.id, abstract: item.descriptions?.find(description => description.descriptionType === 'Abstract')?.description, url: item.url, resourceType: item.types?.resourceTypeGeneral }; }), data.meta?.total, page, 'DataCite 包含数据集、软件和其他研究成果，并非全部是期刊论文。');
    }
    if (source === 'unpaywall') {
      if (!exactDoi) throw Object.assign(error(400, 'Unpaywall 仅按 DOI 查开放获取位置，请输入完整 DOI。'), { sourceStatus: 'skipped' });
      if (page !== 1) return { ...rows(source, [], 0, page, 'Unpaywall 按单个 DOI 查询，结果仅在第一页。'), lookupStatus: 'no_more' };
      const data = await fetchData(`https://api.unpaywall.org/v2/${encodeURIComponent(exactDoi)}`,
        { email: keys.UNPAYWALL_EMAIL }, { signal, allowNotFound: true });
      if (data === null) return { ...rows(source, [], 0, page, 'Unpaywall 未收录此 DOI，不能据此判断论文是否开放获取。'), lookupStatus: 'not_found' };
      if (doi(data.doi) !== exactDoi || typeof data.is_oa !== 'boolean') throw error(502, 'Unpaywall 返回的 DOI 或开放获取状态不完整。');
      const locations = data.is_oa ? [data.best_oa_location, ...(Array.isArray(data.oa_locations) ? data.oa_locations.slice(0, 30) : [])]
        .filter(location => location && typeof location === 'object').map(location => ({
          url: url(location.url) || url(location.url_for_landing_page) || url(location.url_for_pdf),
          pdfUrl: url(location.url_for_pdf), landingPageUrl: url(location.url_for_landing_page),
          license: plain(location.license).slice(0, 120) || null,
          version: ['submittedVersion', 'acceptedVersion', 'publishedVersion'].includes(location.version) ? location.version : null,
          hostType: ['publisher', 'repository'].includes(location.host_type) ? location.host_type : null,
        })).filter(location => location.url) : [];
      const oaLocations = [...new Map(locations.map(location => [location.url, location])).values()].slice(0, 20);
      const authors = (Array.isArray(data.z_authors) ? data.z_authors : []).slice(0, 100)
        .filter(item => item && typeof item === 'object').map(item => plain(item.name || [item.given, item.family].filter(Boolean).join(' '))).filter(Boolean);
      const wanted = author.normalize('NFKC').toLowerCase().split(/[\s,]+/).filter(Boolean);
      const matchesAuthor = !wanted.length || authors.some(name => wanted.every(token => name.normalize('NFKC').toLowerCase().includes(token)));
      const items = matchesAuthor ? [{ id: exactDoi, doi: exactDoi, title: data.title, year: data.year, authors,
        url: url(data.doi_url) || `https://doi.org/${exactDoi}`, pdfUrl: oaLocations.find(location => location.pdfUrl)?.pdfUrl || null,
        openAccess: data.is_oa, openAccessSource: 'unpaywall',
        oaStatus: data.is_oa ? ['green', 'gold', 'hybrid', 'bronze'].includes(data.oa_status) ? data.oa_status : 'open' : 'closed', oaLocations,
      }] : [];
      const note = !matchesAuthor ? 'Unpaywall 查到该 DOI，但作者条件与其书目记录不匹配；请核对作者写法。'
        : data.is_oa ? 'Unpaywall 提供开放获取位置；PDF 链接指向出版方或机构库，使用范围以其许可为准。'
          : 'Unpaywall 已收录该 DOI，但目前未发现开放获取位置；这不表示论文不存在，也不代表其质量。';
      return { ...rows(source, items, items.length, page, note), lookupStatus: data.is_oa ? 'open' : 'closed' };
    }
    if (source === 'nasa_ads') {
      const query = [exactDoi ? `doi:${quoted(exactDoi)}` : q ? `(${q})` : '', author ? `author:${quoted(author)}` : ''].filter(Boolean).join(' AND ');
      const data = await fetchData('https://api.adsabs.harvard.edu/v1/search/query', { q: query, rows: PAGE_SIZE, start: offset, fl: 'bibcode,title,author,year,doi,abstract,citation_count,identifier' }, { signal, headers: { Authorization: `Bearer ${keys.ADS_DEV_KEY}` } });
      return rows(source, list(data.response?.docs).map(item => ({ id: item.bibcode, title: item.title?.[0], authors: item.author, year: item.year, doi: item.doi?.[0], arxivId: item.identifier?.find(value => arxivId(value)), abstract: item.abstract, citationCount: item.citation_count, url: `https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(item.bibcode)}/abstract` })), data.response?.numFound, page);
    }
    if (source === 'arxiv') {
      const query = [q ? `${exactDoi ? 'doi' : 'all'}:${quoted(exactDoi || q)}` : '', author ? `au:${quoted(author)}` : ''].filter(Boolean).join(' AND ');
      const xml = await fetchData('https://export.arxiv.org/api/query', { search_query: query, start: offset, max_results: PAGE_SIZE, sortBy: 'relevance' }, { signal, atom: true });
      // Extract only the fixed Atom fields. DTDs/entities are never processed.
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<feed(?:\s|>)/.test(xml) || !/<\/feed>/.test(xml)) throw error(502, 'arXiv 返回格式异常。');
      const element = (xml, tag) => plain(xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1]);
      const entries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].slice(0, PAGE_SIZE);
      if (entries.some(entry => /api\/errors/.test(element(entry[1], 'id')))) throw error(502, 'arXiv 暂时无法完成查询。');
      return rows(source, entries.map(([, item]) => { const id = arxivId(element(item, 'id')); return { id, arxivId: id, title: element(item, 'title'), authors: [...item.matchAll(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/g)].map(([, author]) => element(author, 'name')), year: parseInt(element(item, 'published'), 10), abstract: element(item, 'summary'), doi: element(item, 'arxiv:doi'), url: id ? `https://arxiv.org/abs/${id}` : null, pdfUrl: id ? `https://arxiv.org/pdf/${id}` : null, openAccess: true }; }), element(xml, 'opensearch:totalResults'), page, 'arXiv 返回预印本；是否经过同行评审请查看正式发表信息。');
    }
    throw error(400, '此数据源尚未接入。');
  }
  async function pause(ms, signal) { if (ms <= 0) return; await new Promise((resolve, reject) => { const finish = () => { signal.removeEventListener('abort', abort); resolve(); }; const timer = setTimeout(finish, ms); const abort = () => { clearTimeout(timer); reject(error(503, '数据源响应超时。')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }); }
  async function queryOne(context, source, params) {
    const notAvailable = unavailable(context, source);
    if (notAvailable) throw Object.assign(error(503, '该数据源暂不可用。'), { sourceStatus: notAvailable });
    const cacheKey = JSON.stringify({ source, ...params });
    const existing = context.cache.get(cacheKey);
    if (existing && now() - existing.at < ttlMs) return { ...structuredClone(existing.result), cached: true };
    if (context.pending.has(cacheKey)) return structuredClone(await context.pending.get(cacheKey));
    const operation = (async () => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      const deadline = new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(error(503, '数据源响应超时。')), { once: true }));
      // Queueing and provider rate spacing share this request's deadline. The
      // lock is released only by its holder after upstream work settles, even
      // if an uncooperative fetch outlives the client's timeout.
      const request = (async () => {
        let release;
        try {
          release = await acquire(source, controller.signal);
          await pause(Math.max(0, (nextRequest.get(source) || 0) - now()), controller.signal);
          if (controller.signal.aborted) throw error(503, '数据源响应超时。');
          const interval = source === 'arxiv' ? 3000 : source === 'semantic_scholar' ? 1000 : source === 'pubmed' ? 350 : 0;
          nextRequest.set(source, now() + interval);
          const raw = await providerSearch(context, source, params, controller.signal);
          if (controller.signal.aborted) throw error(503, '数据源响应超时。');
          const result = { ...raw, fetchedAt: new Date(now()).toISOString(), cached: false };
          if (context.cache.size >= 120) context.cache.delete(context.cache.keys().next().value);
          context.cache.set(cacheKey, { at: now(), result });
          return result;
        } finally {
          if (release) {
            // PubMed has two requests; space the next search after its summary.
            if (source === 'pubmed') nextRequest.set(source, now() + (context.secrets.NCBI_API_KEY ? 110 : 350));
            release();
          }
        }
      })();
      try {
        return await Promise.race([request, deadline]);
      } finally { clearTimeout(timer); }
    })();
    context.pending.set(cacheKey, operation);
    try { return structuredClone(await operation); } finally { context.pending.delete(cacheKey); }
  }
  async function search({ q = '', author = '', mode = 'metadata', page = 1, source, discipline = 'general' } = {}) {
    q = String(q).normalize('NFKC').trim(); author = String(author).normalize('NFKC').trim(); source ||= mode === 'semantic' ? 'sciverse' : 'all';
    if (!['metadata', 'semantic'].includes(mode) || !['general', 'biomedical', 'stem', 'astronomy', 'data'].includes(discipline) || (source !== 'all' && !BY_ID.has(source)) || !/^\d+$/.test(String(page)) || Number(page) < 1 || Number(page) > 100) throw error(400, '检索模式、来源或页码无效。');
    if ((!q && !author) || (q && (q.length < 2 || q.length > 400)) || (author && (author.length < 2 || author.length > 160)) || /[\u0000-\u001f\u007f]/.test(q + author)) throw error(400, '请输入有效的论文主题或作者姓名。');
    page = Number(page);
    if (mode === 'semantic' && (!q || page !== 1 || !['sciverse', 'all'].includes(source))) throw error(400, '语义检索仅支持 Sciverse 的第一组段落。');
    if (mode === 'semantic') source = 'sciverse';
    const context = current();
    let selected = source === 'all' ? ['sciverse', 'openalex', 'crossref', 'semantic_scholar', ...(discipline === 'biomedical' ? ['europe_pmc', 'pubmed'] : []), ...(['stem', 'astronomy'].includes(discipline) ? ['arxiv'] : []), ...(discipline === 'astronomy' ? ['nasa_ads'] : []), ...(discipline === 'data' ? ['datacite'] : []), ...(doi(q) ? ['unpaywall'] : [])] : [source];
    const outcomes = await Promise.allSettled(selected.map(id => queryOne(context, id, { q, author, mode, page })));
    const sourceStatus = outcomes.map((outcome, index) => ({ id: selected[index], label: label(selected[index]), status: outcome.status === 'fulfilled' ? 'ok' : outcome.reason?.sourceStatus || 'error', count: outcome.status === 'fulfilled' ? outcome.value.results.length : 0, ...(outcome.status === 'fulfilled' ? { total: outcome.value.total, cached: outcome.value.cached, ...(outcome.value.lookupStatus ? { lookupStatus: outcome.value.lookupStatus } : {}) } : { error: outcome.reason?.status === 429 ? '查询频率受限，请稍后重试。' : outcome.reason?.sourceStatus === 'skipped' ? '该条件暂不支持，或需从第一页顺序查询。' : '此来源暂不可用，未返回替代数据。' }) }));
    const completed = outcomes.flatMap((outcome, index) => outcome.status === 'fulfilled' ? [{ id: selected[index], data: outcome.value }] : []);
    if (!completed.length) {
      const failures = outcomes.filter(outcome => outcome.status === 'rejected' && !outcome.reason?.sourceStatus);
      const allLimited = failures.length > 0 && failures.every(outcome => outcome.reason?.status === 429);
      throw Object.assign(error(allLimited ? 429 : 503, allLimited ? '数据源查询繁忙或频率受限，请稍后重试。' : '本次选择的数据源均未完成查询，请稍后重试或换一个来源。'), { sourceStatus });
    }
    // Keep per-source relevance order while interleaving providers, then merge
    // only compatible identifiers. A sum of provider totals is never unique.
    const interleaved = [];
    for (let n = 0; n < PAGE_SIZE; n++) for (const entry of completed) if (entry.data.results[n]) interleaved.push(entry.data.results[n]);
    const results = mode === 'semantic' ? completed[0].data.results : mergeLiteratureResults(interleaved);
    return { source, mode, page, pageSize: source === 'all' ? results.length : PAGE_SIZE, discipline, fetchedAt: new Date(now()).toISOString(), cached: completed.every(entry => entry.data.cached), results,
      ...(source === 'unpaywall' ? { lookupStatus: completed[0].data.lookupStatus } : {}),
      total: source === 'all' ? results.length : completed[0].data.total, totalIsExact: source !== 'all' && completed[0].data.totalIsExact !== false, hasMore: completed.some(entry => entry.data.hasMore), partial: completed.length !== selected.length, sourceStatus,
      note: [source === 'all' ? '本页合并多个来源并去重；数量不是全库唯一论文总数。不同来源的覆盖范围和排序不同。' : '', '姓名匹配可能包含同名者，请核对论文归属。', ...completed.map(entry => entry.data.note || '')].filter(Boolean).join(' ') };
  }
  function sciverseReader() { const context = current(); if (unavailable(context, 'sciverse')) throw error(503, '原文数据源暂不可用。'); return context.sciverse; }
  async function catalog() { const context = current(); if (unavailable(context, 'sciverse')) return { source: 'multiple', providers: publicProviders(), fields: [], defaultFields: [], filterOperators: [], note: '字段目录仅展示已接入来源；Sciverse 字段暂不可用。' }; return { ...await context.sciverse.catalog(), providers: publicProviders() }; }
  return { health, search, catalog, content: params => sciverseReader().content(params), resource: file => sciverseReader().resource(file) };
}
