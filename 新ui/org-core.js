(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScholarOrgCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const KINDS = Object.freeze({ submit: '投稿', close: '结案', review: '审稿', reproduce: '复现', claim: '认领', score: '评分', unknown: '其他行为' });
  const CLOSE_REASONS = Object.freeze({ REJECTED: '拒稿', WITHDRAWN: '撤稿', ACCEPTED: '录用' });
  const chronology = (a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence;
  function authorId(value) {
    return String(value || '').trim().replace(/^https:\/\/openalex\.org\//i, '').toUpperCase();
  }
  function fingerprint(value) {
    const hash = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
    return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
  }
  function parseQuery(value) {
    const text = String(value || '').trim();
    if (!text) return { error: '请输入学者 ID 或 64 位十六进制稿件指纹。' };
    const hash = fingerprint(text);
    if (hash) return { type: 'hash', value: hash };
    const id = authorId(text);
    if (/^[A-Z0-9][A-Z0-9:_-]{1,95}$/.test(id) && !/^0X/i.test(id)) return { type: 'author', value: id };
    return { error: '请使用学者 ID，或完整的 64 位十六进制指纹（可带 0x）。此演示不按姓名匹配。' };
  }
  function normalize(source) {
    if (!source || !Array.isArray(source.events) || !source.asOf) throw new Error('行为数据缺少快照时间或事件列表。');
    const asOfMs = Date.parse(source.asOf);
    if (!Number.isFinite(asOfMs)) throw new Error('快照时间无效。');
    const seen = new Set();
    let ignored = 0;
    const events = [];
    for (const item of source.events) {
      if (!item) { ignored++; continue; }
      const timeMs = Date.parse(item.time);
      const hash = fingerprint(item.content_hash);
      const author = authorId(item.author_id);
      const org = String(item.org || '').trim();
      if (!Number.isFinite(timeMs) || timeMs > asOfMs || !hash || !author || !org || !Object.hasOwn(KINDS, item.kind)) { ignored++; continue; }
      const key = JSON.stringify([timeMs, item.kind, hash, org.toLowerCase(), author]);
      if (seen.has(key)) { ignored++; continue; }
      seen.add(key);
      events.push({ id: 'event-' + events.length, time: new Date(timeMs).toISOString(), timeMs,
        kind: item.kind, content_hash: hash, org, org_name: org, author_id: author,
        subject: author, recorder: String(item.recorder || 'mock:' + org.toLowerCase()),
        trusted: item.trusted !== false, knownKind: true, sequence: events.length,
        close_reason: CLOSE_REASONS[item.close_reason] || (item.kind === 'close' ? '原因未注明' : ''),
        author_name: String(item.author_name || author), note: String(item.note || '') });
    }
    events.sort((a, b) => -chronology(a, b));
    return { source: 'mock', trustReady: true, asOf: new Date(asOfMs).toISOString(), asOfMs, events, ignored };
  }
  function normalizeChain(records, manifest, options = {}) {
    const asOfMs = Date.parse(options.asOf || new Date().toISOString());
    if (!Number.isFinite(asOfMs)) throw new Error('链上读取时间无效。');
    const trustReady = manifest?.kind === 'ready' && Array.isArray(manifest.journals) && manifest.journals.length > 0;
    const journals = trustReady ? manifest.journals : [];
    let ignored = 0;
    const events = [];
    (Array.isArray(records) ? records : []).forEach((row, index) => {
      const timeMs = Number(row.time) * 1000;
      const hash = fingerprint(row.content);
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > asOfMs || !hash) { ignored++; return; }
      const recorder = String(row.recorder || '').toLowerCase();
      const org = String(row.org || '').toLowerCase();
      const subject = String(row.subject || '').toLowerCase();
      const journal = /^0x[\da-f]{40}$/.test(recorder) && /^0x[\da-f]{64}$/.test(org)
        ? journals.find(j => String(j.address).toLowerCase() === recorder && String(j.org).toLowerCase() === org) : null;
      const kind = String(row.kind || '').toLowerCase();
      const known = row.knownKind !== false && Object.hasOwn(KINDS, kind) && kind !== 'unknown';
      const sequence = Number.isSafeInteger(row.sequence) ? row.sequence : index;
      events.push({ id: 'chain-event-' + index, time: new Date(timeMs).toISOString(), timeMs, sequence,
        kind: known ? kind : 'unknown', knownKind: known, content_hash: hash, org, org_name: journal?.name || '未认证机构',
        recorder, subject, author_id: subject, author_name: options.subject === subject && options.authorId ? options.authorId : '链上主体',
        trusted: Boolean(journal), close_reason: row.closeReasonLabel || CLOSE_REASONS[row.closeReason] || (kind === 'close' ? '未知结案原因' : ''),
        transactionHash: row.transactionHash || null, blockNumber: row.blockNumber,
        note: known ? '' : '未知行为保留展示，不计入投稿生命周期。' });
    });
    events.sort((a, b) => -chronology(a, b));
    return { source: 'chain', trustReady, asOf: new Date(asOfMs).toISOString(), asOfMs, events, ignored };
  }
  function openSubmissions(events) {
    const open = new Map();
    const closed = [];
    for (const event of events.slice().sort(chronology)) {
      if (!event.trusted || event.knownKind === false) continue;
      const key = [event.recorder, event.org, event.subject, event.content_hash].map(v => String(v).toLowerCase()).join('|');
      if (event.kind === 'submit') open.set(key, event);
      if (event.kind === 'close' && open.has(key)) {
        closed.push({ submission: open.get(key), closure: event });
        open.delete(key);
      }
    }
    return { open: [...open.values()], closed };
  }
  function repeatedManuscripts(open) {
    const groups = new Map();
    for (const event of open) {
      const group = groups.get(event.content_hash) || [];
      group.push(event);
      groups.set(event.content_hash, group);
    }
    const alerts = [];
    for (const [hash, group] of groups) {
      group.sort(chronology);
      const orgs = new Map(group.map(e => [e.org.toLowerCase(), e.org_name || e.org]));
      if (orgs.size >= 2) alerts.push({ type: 'multiple', hash, orgCount: orgs.size, orgs: [...orgs.values()],
        start: group[0].time, end: group[group.length - 1].time,
        evidenceIds: group.map(e => e.id), events: group });
    }
    return alerts;
  }
  function analyze(data, rawQuery) {
    const query = typeof rawQuery === 'string' ? parseQuery(rawQuery) : rawQuery;
    if (!query || query.error) return { query, error: query?.error || '查询无效。', events: [], alerts: [] };
    const events = data.events.filter(e => query.type === 'hash' ? e.content_hash === query.value : query.type === 'subject' ? e.subject === query.value : e.author_id === query.value);
    const authors = [...new Set(events.map(e => e.author_id))];
    const lifecycle = openSubmissions(events);
    const alerts = data.trustReady ? repeatedManuscripts(lifecycle.open) : [];
    const frequency = [];
    for (const author of authors) {
      const recent = data.events.filter(e => e.author_id === author && e.trusted && e.knownKind !== false && e.kind === 'submit' && e.timeMs >= data.asOfMs - 7 * DAY && e.timeMs <= data.asOfMs);
      // Count distinct manuscript fingerprints, so resubmitting one file cannot become ten papers.
      const manuscripts = [...new Set(recent.map(e => e.content_hash))];
      frequency.push({ author, count: manuscripts.length });
      if (data.trustReady && manuscripts.length >= 10) alerts.push({ type: 'frequency', author, count: manuscripts.length,
        start: new Date(data.asOfMs - 7 * DAY).toISOString(), end: data.asOf,
        evidenceIds: recent.map(e => e.id), events: recent });
    }
    const trustedCount = events.filter(e => e.trusted).length;
    const trustedSubmissions = events.filter(e => e.trusted && e.kind === 'submit').length;
    const assessment = { status: !data.trustReady || !trustedSubmissions ? 'unknown' : alerts.length ? 'risk' : 'clear',
      trustedCount, untrustedCount: events.length - trustedCount, openCount: lifecycle.open.length,
      closedCount: lifecycle.closed.length, reason: !data.trustReady ? '可信期刊名单未就绪' : !trustedSubmissions ? '暂无可信投稿记录' : '' };
    return { source: data.source, query, events, authors, alerts, frequency, lifecycle, assessment,
      stats: { events: events.length, submissions: events.filter(e => e.kind === 'submit').length,
        manuscripts: new Set(events.map(e => e.content_hash)).size, orgs: new Set(events.map(e => e.org.toLowerCase())).size } };
  }
  return Object.freeze({ DAY, KINDS, parseQuery, fingerprint, normalize, normalizeChain, openSubmissions, analyze });
}));
