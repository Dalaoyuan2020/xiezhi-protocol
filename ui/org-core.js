(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScholarOrgCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const KINDS = Object.freeze({ submit: '投稿', review: '审稿', reproduce: '复现', claim: '认领' });
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
      const timeMs = Date.parse(item.time);
      const hash = fingerprint(item.content_hash);
      const author = authorId(item.author_id);
      const org = String(item.org || '').trim();
      if (!Number.isFinite(timeMs) || timeMs > asOfMs || !hash || !author || !org || !Object.hasOwn(KINDS, item.kind)) { ignored++; continue; }
      const key = JSON.stringify([timeMs, item.kind, hash, org.toLowerCase(), author]);
      if (seen.has(key)) { ignored++; continue; }
      seen.add(key);
      events.push({ id: 'event-' + events.length, time: new Date(timeMs).toISOString(), timeMs,
        kind: item.kind, content_hash: hash, org, author_id: author,
        author_name: String(item.author_name || author), note: String(item.note || '') });
    }
    events.sort((a, b) => b.timeMs - a.timeMs || a.id.localeCompare(b.id));
    return { asOf: new Date(asOfMs).toISOString(), asOfMs, events, ignored };
  }
  function repeatedManuscripts(events) {
    const groups = new Map();
    for (const event of events) {
      if (event.kind !== 'submit') continue;
      const group = groups.get(event.content_hash) || [];
      group.push(event);
      groups.set(event.content_hash, group);
    }
    const alerts = [];
    for (const [hash, group] of groups) {
      group.sort((a, b) => a.timeMs - b.timeMs);
      let left = 0;
      let best = null;
      const orgCounts = new Map();
      for (let right = 0; right < group.length; right++) {
        const key = group[right].org.toLowerCase();
        orgCounts.set(key, (orgCounts.get(key) || 0) + 1);
        while (group[right].timeMs - group[left].timeMs > 30 * DAY) {
          const removed = group[left++].org.toLowerCase();
          const count = orgCounts.get(removed) - 1;
          if (count) orgCounts.set(removed, count); else orgCounts.delete(removed);
        }
        if (orgCounts.size >= 2 && (!best || orgCounts.size >= best.orgCount)) {
          best = { orgCount: orgCounts.size, events: group.slice(left, right + 1) };
        }
      }
      if (best) alerts.push({ type: 'multiple', hash, orgCount: best.orgCount,
        orgs: [...new Set(best.events.map(e => e.org))],
        start: best.events[0].time, end: best.events[best.events.length - 1].time,
        evidenceIds: best.events.map(e => e.id), events: best.events });
    }
    return alerts;
  }
  function analyze(data, rawQuery) {
    const query = typeof rawQuery === 'string' ? parseQuery(rawQuery) : rawQuery;
    if (!query || query.error) return { query, error: query?.error || '查询无效。', events: [], alerts: [] };
    const events = data.events.filter(e => query.type === 'hash' ? e.content_hash === query.value : e.author_id === query.value);
    const authors = [...new Set(events.map(e => e.author_id))];
    const alerts = repeatedManuscripts(events);
    const frequency = [];
    for (const author of authors) {
      const recent = data.events.filter(e => e.author_id === author && e.kind === 'submit' && e.timeMs >= data.asOfMs - 7 * DAY && e.timeMs <= data.asOfMs);
      // Count distinct manuscript fingerprints, so resubmitting one file cannot become ten papers.
      const manuscripts = [...new Set(recent.map(e => e.content_hash))];
      frequency.push({ author, count: manuscripts.length });
      if (manuscripts.length >= 10) alerts.push({ type: 'frequency', author, count: manuscripts.length,
        start: new Date(data.asOfMs - 7 * DAY).toISOString(), end: data.asOf,
        evidenceIds: recent.map(e => e.id), events: recent });
    }
    return { query, events, authors, alerts, frequency,
      stats: { events: events.length, submissions: events.filter(e => e.kind === 'submit').length,
        manuscripts: new Set(events.map(e => e.content_hash)).size, orgs: new Set(events.map(e => e.org.toLowerCase())).size } };
  }
  return Object.freeze({ DAY, KINDS, parseQuery, fingerprint, normalize, analyze });
}));
