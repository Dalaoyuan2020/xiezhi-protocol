import { nameVariants } from '@aia/research-core/names';
import { pinyin } from 'pinyin-pro';

const API = 'https://api.openalex.org';
const AUTHOR_ID = /^A\d{1,20}$/;
const INSTITUTION_ID = /^I\d{1,20}$/;

function problem(status, message) {
  return Object.assign(new Error(message), { status, statusCode: status });
}

export function normalizeOrcid(value) {
  const id = String(value || '').trim().replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '').replace(/\/$/, '').toUpperCase();
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id)) return null;
  const digits = id.replaceAll('-', '');
  let total = 0;
  for (const digit of digits.slice(0, 15)) total = (total + Number(digit)) * 2;
  const check = (12 - total % 11) % 11;
  if ((check === 10 ? 'X' : String(check)) !== digits.at(-1)) return null;
  return id;
}

function authorId(value) {
  const id = String(value || '').replace(/^https:\/\/openalex\.org\//, '');
  if (!AUTHOR_ID.test(id)) throw problem(400, 'OpenAlex 作者编号应为 A 开头的数字编号。');
  return id;
}

const finiteCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const names = values => [...new Set((Array.isArray(values) ? values : []).map(item => item?.display_name).filter(value => typeof value === 'string' && value.trim()).map(value => value.slice(0, 250)))].slice(0, 12);
const strings = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 250)))].slice(0, 30);
const nameKey = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[\s\p{P}\p{S}]+/gu, '');

export function normalizeInstitutionQuery(value = '') {
  if (typeof value !== 'string') throw problem(400, '学术单位须为文字。');
  const normalized = value.normalize('NFKC').trim();
  if (normalized && (normalized.length < 2 || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized) || !nameKey(normalized))) throw problem(400, '学术单位可留空，或填写 2–160 个字符的全称、简称。');
  return normalized;
}

function normalizeInstitution(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').replace(/^https:\/\/openalex\.org\//, '');
  if (!INSTITUTION_ID.test(id) || typeof item.display_name !== 'string' || !item.display_name.trim()) return null;
  return { id, name: item.display_name.slice(0, 250), aliases: strings(item.display_name_alternatives), acronyms: strings(item.display_name_acronyms), sourceUrl: `https://openalex.org/${id}` };
}

function normalizeAuthor(item) {
  if (!item || typeof item !== 'object') return null;
  let id;
  try { id = authorId(item.id); } catch { return null; }
  const orcid = normalizeOrcid(item.orcid);
  return {
    id, name: String(item.display_name || id).slice(0, 250),
    orcid: orcid ? `https://orcid.org/${orcid}` : null,
    institutions: names(item.last_known_institutions), topics: names(item.topics),
    works: finiteCount(item.works_count), citedBy: finiteCount(item.cited_by_count),
    sourceUrl: `https://openalex.org/${id}`,
    identityStatus: 'public-record-unverified',
  };
}

/** Stable ordering: keep identity/name relevance, then prefer usable affiliations. */
export function rankScholarCandidates(candidates, query, variants = []) {
  // Full Chinese names and their full transliterations are equivalent search aliases.
  // Affiliation quality ranks inside this group, so an empty Chinese record does not hide a useful pinyin record.
  const exactKeys = new Set([String(query || ''), ...variants].flatMap(value => [String(value), String(value).trim().split(/\s+/).reverse().join(' ')]).map(nameKey));
  const relevance = person => exactKeys.has(nameKey(String(person.name || ''))) ? 0 : 1;
  const affiliated = person => (person.institutions || []).some(value => typeof value === 'string' && value.trim() && !/^(unknown|n\/a|null|none|未收录|未知|单位未知|机构未知|暂无|[-—–]+)$/i.test(value.trim()));
  return candidates.map((person, position) => ({ person, position }))
    .sort((a, b) => relevance(a.person) - relevance(b.person) || Number(affiliated(b.person)) - Number(affiliated(a.person)) || a.position - b.position)
    .map(item => item.person);
}

/** Real public records only; failures never substitute a local scholar snapshot. */
export function createScholarLookup({ fetchImpl = globalThis.fetch, apiKey = process.env.OPENALEX_API_KEY, now = () => Date.now(), ttlMs = 300_000 } = {}) {
  const cache = new Map();
  const pending = new Map();

  async function request(route, params, key, single = false, normalize = normalizeAuthor) {
    const previous = cache.get(key);
    if (previous && now() - previous.storedAt < ttlMs) return { ...structuredClone(previous.data), cached: true };
    if (pending.has(key)) return structuredClone(await pending.get(key));
    const operation = (async () => {
      const url = new URL(route, API);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
      const headers = { Accept: 'application/json', 'User-Agent': 'AIA-Research/0.1 (scholar-identity-lookup)' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      let response;
      try { response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
      catch { throw problem(503, '暂时无法连接 OpenAlex。请稍后重试，或先填写自己的公开资料；不会用演示档案替代查询。'); }
      if (response.status === 429) throw problem(503, 'OpenAlex 查询额度或速率暂时受限，请稍后重试；服务端可配置 OPENALEX_API_KEY 提高额度。');
      if ([401, 403].includes(response.status)) throw problem(503, 'OpenAlex 暂不允许此请求。请检查服务端 API 配置；没有返回替代档案。');
      if (response.status === 404 && single) throw problem(404, '没有找到这个 OpenAlex 作者档案。');
      if (!response.ok) throw problem(502, 'OpenAlex 查询失败，请稍后重试。');
      let body;
      try { body = await response.json(); } catch { throw problem(502, 'OpenAlex 返回的内容无法解析。'); }
      if (!single && !Array.isArray(body.results)) throw problem(502, 'OpenAlex 返回了不完整的作者列表。');
      const results = (single ? [body] : body.results).map(normalize).filter(Boolean);
      if (normalize === normalizeInstitution && body.results.length && !results.length) throw problem(502, 'OpenAlex 返回的单位信息不完整。');
      if (single && results.length !== 1) throw problem(502, 'OpenAlex 返回的作者信息不完整。');
      const data = {
        source: 'openalex', fetchedAt: new Date(now()).toISOString(), cached: false,
        total: single ? results.length : finiteCount(body.meta?.count) ?? results.length,
        results,
        limitation: '公开学术档案仅用于辨认和关联；不代表已完成 ORCID 授权、本人身份或论文归属认证。',
      };
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { storedAt: now(), data });
      return data;
    })();
    pending.set(key, operation);
    try { return structuredClone(await operation); } finally { pending.delete(key); }
  }

  async function author(id) {
    const normalized = authorId(id);
    return request(`/authors/${normalized}`, {}, `author:${normalized}`, true);
  }

  async function resolveInstitution(query) {
    let response;
    try {
      response = await request('/institutions', { search: query, per_page: 25, select: 'id,display_name,display_name_alternatives,display_name_acronyms' }, `institution:${query.toLowerCase()}`, false, normalizeInstitution);
    } catch {
      throw Object.assign(problem(503, '暂时无法识别学术单位，请稍后重试，或清除单位条件继续按姓名查找。'), { institution: { query, status: 'unavailable', matches: [], applied: false } });
    }
    // The API's fuzzy search can match unrelated characters or institution
    // fragments. Keep evidence in its official name/aliases/acronyms, prioritizing
    // an exact alias (河海大学) over former names (河海大学文天学院).
    const key = nameKey(query);
    const ranked = response.results.map(institution => {
      const aliases = [institution.name, ...institution.aliases, ...institution.acronyms];
      const matchedAliases = aliases.filter(name => nameKey(name).includes(key));
      return { ...institution, matchedAliases, exact: matchedAliases.some(name => nameKey(name) === key) };
    }).filter(institution => institution.matchedAliases.length);
    const exact = ranked.filter(institution => institution.exact);
    const matches = (exact.length ? exact : ranked).slice(0, 5).map(({ exact: ignored, ...institution }) => institution);
    return { query, status: matches.length ? 'matched' : 'unresolved', matches, applied: matches.length > 0,
      scope: 'last-known-institutions', ambiguous: matches.length > 1,
      limited: response.total > response.results.length || (exact.length || ranked.length) > 5,
      fetchedAt: response.fetchedAt, cached: response.cached,
      note: matches.length ? '按 OpenAlex 最近记录的单位筛选；单位记录可能滞后，不代表已验证任职或本人身份。' : '未识别出这个学术单位，不代表没有同名学者。可换用单位全称、英文名或清除单位条件。' };
  }

  async function search(query, options = {}) {
    const value = String(query || '').normalize('NFKC').trim();
    if (value.length < 2 || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw problem(400, '请输入 2–160 个字符的姓名、ORCID 或 OpenAlex 作者编号。');
    const institutionQuery = normalizeInstitutionQuery(options.institution);
    const exactIdentity = data => institutionQuery ? { ...data, institution: { query: institutionQuery, status: 'ignored', matches: [], applied: false, reason: 'identifier-priority', note: '已按唯一编号定位档案，未应用单位筛选。' } } : data;
    if (AUTHOR_ID.test(value) || /^https:\/\/openalex\.org\/A\d+$/.test(value)) return exactIdentity(await author(value));
    const orcid = normalizeOrcid(value);
    if (!orcid && (/orcid\.org/i.test(value) || /^\d{4}-\d{4}-\d{4}-/.test(value))) throw problem(400, 'ORCID 格式或校验位有误，请核对完整编号。');
    const parameters = {
      per_page: 20,
      select: 'id,display_name,orcid,works_count,cited_by_count,last_known_institutions,topics',
    };
    if (orcid) return exactIdentity(await request('/authors', { ...parameters, filter: `orcid:https://orcid.org/${orcid}` }, `orcid:${orcid}`));
    const institution = institutionQuery ? await resolveInstitution(institutionQuery) : null;
    if (institution?.status === 'unresolved') return { source: 'openalex', fetchedAt: institution.fetchedAt, cached: institution.cached,
      total: 0, totalIsExact: false, results: [], variants: [], partial: false, failedVariants: [], queries: [], institution, limitation: institution.note };
    const filter = institution ? `last_known_institutions.id:${institution.matches.map(item => item.id).sort().join('|')}` : null;
    const variants = [...new Map([value, ...nameVariants(value, pinyin)].map(v => [v.toLowerCase(), v])).values()].slice(0, 4);
    const responses = await Promise.allSettled(variants.map(search => request('/authors', { ...parameters, search, ...(filter ? { filter } : {}) }, `search:${search.toLowerCase()}:${filter || ''}`)));
    const completed = responses.flatMap((entry, i) => entry.status === 'fulfilled' ? [{ query: variants[i], data: entry.value }] : []);
    if (!completed.length) throw responses[0].reason;
    const results = rankScholarCandidates([...new Map(completed.flatMap(entry => entry.data.results).map(person => [person.id, person])).values()], value, variants).slice(0, 60);
    const failedVariants = responses.flatMap((entry, i) => entry.status === 'rejected' ? [variants[i]] : []);
    return { ...completed[0].data, results, total: variants.length === 1 ? completed[0].data.total : results.length,
      totalIsExact: false, variants, partial: failedVariants.length > 0, failedVariants,
      cached: completed.every(entry => entry.data.cached) && (!institution || institution.cached),
      fetchedAt: [...completed.map(entry => entry.data.fetchedAt), ...(institution ? [institution.fetchedAt] : [])].sort()[0],
      queries: completed.map(entry => ({ query: entry.query, fetchedAt: entry.data.fetchedAt, cached: entry.data.cached })),
      ...(institution ? { institution } : {}),
    };
  }

  return Object.freeze({ search, author });
}
