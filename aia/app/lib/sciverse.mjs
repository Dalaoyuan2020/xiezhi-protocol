// Read-only adapter for the canonical Sciverse Agent Tools HTTP protocol.
// Fixed origin + bounded requests keep the shared server credential off the web.
const API = 'https://api.sciverse.space';
const TOOLS = ['list_catalog', 'search_papers', 'semantic_search', 'read_content', 'get_resource'];
const PAGE_SIZE = 10;
const DOC = /^[a-f0-9]{64}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const problem = (status, message) => Object.assign(new Error(message), { status });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 10000) => typeof value === 'string' ? value.slice(0, max) : '';
const copy = value => structuredClone(value);

function input(value, label, max, optional = false) {
  const result = String(value ?? '').normalize('NFKC').trim();
  if ((!optional && result.length < 2) || (result && result.length < 2) || result.length > max || CONTROL.test(result)) throw problem(400, `${label}需为 2–${max} 个字符。`);
  return result;
}
function resourceName(value) {
  return typeof value === 'string' && value.length <= 768 && /^[\w=+./-]+\.(?:png|jpe?g|gif|webp)$/i.test(value) && !value.startsWith('/') && !value.includes('..') && !value.includes('//');
}
function rasterMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function createSciverse({ token = process.env.SCIVERSE_API_TOKEN, fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = 300000, timeoutMs = 15000, semanticTimeoutMs = 25000, maxConcurrent = 3 } = {}) {
  const cache = new Map(), pending = new Map(), documents = new Map(), resources = new Map();
  let active = 0;
  const configured = Boolean(token);
  const health = () => ({ configured, source: 'sciverse', tools: [...TOOLS], mode: 'read-only' });
  function remember(map, key, maximum) {
    map.delete(key);
    if (map.size >= maximum) map.delete(map.keys().next().value);
    map.set(key, now());
  }
  function permitted(map, key) { return map.has(key) && now() - map.get(key) < 30 * 60000; }
  async function cached(key, operation) {
    const item = cache.get(key);
    if (item && now() - item.at < ttlMs) return { ...copy(item.value), cached: true };
    if (pending.has(key)) return copy(await pending.get(key));
    const promise = (async () => {
      const value = { ...await operation(), source: 'sciverse', fetchedAt: new Date(now()).toISOString(), cached: false };
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), value });
      return value;
    })();
    pending.set(key, promise);
    try { return copy(await promise); } finally { pending.delete(key); }
  }
  async function request(route, { payload, params, binary = false, timeout = timeoutMs } = {}) {
    if (!configured) throw problem(503, '文献检索尚未配置服务端凭据。');
    if (active >= maxConcurrent) throw problem(429, '文献检索繁忙，请稍后重试。');
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const url = new URL(route, API);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
    try {
      const response = await fetchImpl(url, {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: binary ? 'image/png,image/jpeg,image/webp,image/gif' : 'application/json', 'Content-Type': 'application/json', 'X-Sciverse-Source': 'aia-server' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = [403, 404, 429].includes(response.status) ? response.status : response.status === 401 ? 503 : 502;
        throw problem(status, { 403: '当前凭据无权读取此文献材料。', 404: '未找到该文献材料。', 429: '文献数据源查询额度或频率受限，请稍后重试。', 503: '文献数据源鉴权失败，请检查服务端配置。', 502: '文献数据源暂时无法完成请求。' }[status]);
      }
      const limit = binary ? 8 * 1024 * 1024 : 2 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw problem(502, '文献材料超过单次读取限制。'); }
      const reader = response.body?.getReader();
      if (!reader) throw problem(502, '文献数据源返回空响应。');
      let size = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw problem(502, '文献材料超过单次读取限制。'); }
        chunks.push(Buffer.from(value));
      }
      const bytes = Buffer.concat(chunks);
      if (binary) {
        const mimeType = rasterMime(bytes);
        const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!mimeType || mimeType !== declared) throw problem(502, '图表返回格式不受支持。');
        return { bytes, mimeType };
      }
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { throw problem(502, '文献数据源返回格式异常。'); }
      // The service can return a business failure envelope with HTTP 200. Do
      // not turn its empty results into a successful "nothing found" answer.
      if (data && typeof data === 'object' && ((Object.hasOwn(data, 'code') && data.code !== 'SUCCESS') || (Object.hasOwn(data, 'biz_code') && data.biz_code !== 0))) throw problem(502, '文献数据源暂时无法完成请求。');
      return data;
    } catch (error) {
      if (error.status) throw error;
      throw problem(503, controller.signal.aborted ? '文献数据源响应超时，请稍后重试。' : '暂时无法连接文献数据源，请稍后重试。');
    } finally { clearTimeout(timer); active--; }
  }
  async function catalog() {
    return cached('catalog', async () => {
      const data = await request('/meta-catalog', { params: { collection: 'papers', include_sample_values: false } });
      if (!Array.isArray(data?.fields) || !Array.isArray(data?.default_fields) || !Array.isArray(data?.filter_operators)) throw problem(502, '文献字段目录不完整。');
      return {
        fields: data.fields.slice(0, 500).filter(item => typeof item?.name === 'string').map(item => ({ name: text(item.name, 160), type: text(item.type, 100), filterable: item.filterable === true, searchable: item.searchable === true, sortable: item.sortable === true, description: text(item.description, 2000), operators: Array.isArray(item.operators) ? item.operators.filter(value => typeof value === 'string' && /^(?:FILTER_OP_)?[A-Z_]{1,40}$/.test(value)).slice(0, 50) : [] })),
        defaultFields: data.default_fields.filter(item => typeof item === 'string'),
        filterOperators: data.filter_operators.filter(item => typeof item === 'string'),
      };
    });
  }
  function normalizePaper(item, semantic) {
    if (!item || typeof item.title !== 'string' || (semantic ? !DOC.test(item.doc_id) : typeof item.unique_id !== 'string')) return null;
    const docId = DOC.test(item.doc_id) ? item.doc_id : null;
    const canRead = Boolean(docId && (semantic ? item.is_content_accessible !== false : item.is_content_accessible === true));
    const doi = typeof item.doi === 'string' && /^10\.\d{4,9}\/\S{1,240}$/i.test(item.doi) ? item.doi : null;
    // Metadata returns objects; the live semantic service returns name strings.
    const authors = Array.isArray(item.author) ? [...new Set(item.author.map(author => text(typeof author === 'string' ? author : author?.name, 200)).filter(Boolean))].slice(0, 100) : [];
    return {
      id: text(semantic ? item.chunk_id || item.doc_id : item.unique_id, 500), docId,
      title: text(item.title, 2000), authors, year: integer(item.publication_published_year) ? item.publication_published_year : null,
      doi, url: doi ? `https://doi.org/${encodeURI(doi).replaceAll('#', '%23').replaceAll('?', '%3F')}` : null,
      abstract: text(item.abstract, 12000), snippet: semantic ? text(item.chunk, 12000) : '', canRead,
      ...(semantic && integer(item.offset) ? { offset: item.offset } : {}),
    };
  }
  async function search({ q = '', author = '', mode = 'metadata', page = 1 } = {}) {
    q = input(q, '检索内容', 400, true);
    author = input(author, '作者姓名', 160, true);
    if (!['metadata', 'semantic'].includes(mode) || !/^\d+$/.test(String(page)) || Number(page) < 1 || Number(page) > 100) throw problem(400, '检索模式或页码无效。');
    page = Number(page);
    if ((!q && !author) || (mode === 'semantic' && (!q || page !== 1))) throw problem(400, mode === 'semantic' ? '语义检索需要问题描述，且只返回一组相关段落。' : '请输入论文主题、DOI 或作者姓名。');
    const result = await cached(`search:${JSON.stringify({ q, author, mode, page })}`, async () => {
      const schema = await catalog();
      const fields = new Map(schema.fields.map(item => [item.name, item]));
      if (author && !fields.get('author')?.filterable) throw problem(403, '当前凭据未开放作者筛选字段。');
      let data;
      if (mode === 'semantic') {
        data = await request('/agentic-search', { payload: { query: q, top_k: 8, retrieval: 'hybrid', ...(author ? { filters: { author: [author] } } : {}) }, timeout: semanticTimeoutMs });
      } else {
        const filters = author ? [{ field: 'author', operator: 'FILTER_OP_MATCH', value: author }] : [];
        const doi = q.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
        const exactDoi = /^10\.\d{4,9}\/\S+$/i.test(doi);
        if (exactDoi) {
          if (!fields.get('doi')?.filterable) throw problem(403, '当前凭据未开放 DOI 筛选字段。');
          filters.push({ field: 'doi', operator: 'FILTER_OP_EQ', value: doi });
        }
        const projection = ['unique_id', 'doc_id', 'title', 'author', 'abstract', 'publication_published_year', 'doi'].filter(name => fields.has(name));
        data = await request('/meta-search', { payload: { collection: 'papers', page, page_size: PAGE_SIZE,
          ...(q && !exactDoi ? { query: q } : {}), ...(filters.length ? { filters } : {}), ...(projection.length ? { fields: projection } : {}),
          ...(!q && fields.get('publication_published_year')?.sortable ? { sort: [{ field: 'publication_published_year', order: 'SORT_ORDER_DESC' }] } : {}) } });
      }
      const items = mode === 'semantic' ? data?.hits : data?.results;
      if (!Array.isArray(items)) throw problem(502, '文献检索返回格式异常。');
      const results = items.slice(0, mode === 'semantic' ? 8 : PAGE_SIZE).map(item => normalizePaper(item, mode === 'semantic')).filter(Boolean);
      if (items.length && !results.length) throw problem(502, '文献检索返回的记录不完整。');
      const total = mode === 'metadata' && integer(data.total_count) ? data.total_count : results.length;
      return { mode, total, page, pageSize: mode === 'metadata' ? PAGE_SIZE : 8, hasMore: mode === 'metadata' && results.length > 0 && page < 100 && total > page * PAGE_SIZE, results,
        note: mode === 'semantic' ? (author ? '作者条件是数据源的近似过滤；缺少作者信息的段落也可能返回，不能据此确认论文归属。' : '语义结果是相关原文段落；检索相关度不代表论文质量或学者信誉。') : '作者名匹配可能包含同名者；请结合论文内容核对归属。' };
    });
    for (const item of result.results) if (item.canRead) remember(documents, item.docId, 1000);
    return result;
  }
  async function content({ doc, offset = 0 } = {}) {
    if (!DOC.test(String(doc || '')) || !/^\d+$/.test(String(offset)) || !integer(Number(offset)) || Number(offset) > 10000000) throw problem(400, '文献编号或原文位置无效。');
    if (!permitted(documents, doc)) throw problem(403, '请先检索并选择有权读取原文的文献。');
    offset = Number(offset);
    const result = await cached(`content:${doc}:${offset}`, async () => {
      const data = await request('/content', { params: { doc_id: doc, offset, limit: 4096 } });
      if (typeof data?.text !== 'string' || typeof data?.more !== 'boolean' || !integer(data.next_offset) || data.next_offset < offset || (data.more && data.next_offset <= offset)) throw problem(502, '原文切片返回格式异常。');
      const images = [...data.text.matchAll(/!\[([^\]\r\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].filter(match => resourceName(match[2])).slice(0, 30);
      return { docId: doc, text: data.text, offset, nextOffset: data.next_offset, hasMore: data.more, resources: [...new Map(images.map(match => [match[2], { fileName: match[2], alt: text(match[1], 300) }])).values()] };
    });
    for (const item of result.resources) remember(resources, item.fileName, 2000);
    return result;
  }
  async function resource(fileName) {
    if (!resourceName(fileName)) throw problem(400, '图表文件名无效。');
    if (!permitted(resources, fileName)) throw problem(403, '请先读取包含该图表的原文切片。');
    return request('/resource', { params: { file_name: fileName }, binary: true });
  }
  return { health, catalog, search, content, resource };
}
