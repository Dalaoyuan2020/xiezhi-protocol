(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScholarSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SCORED = new Set(['A5126602136', 'A5009290031', 'A5100700361', 'SYNTHETIC']);
  function normalize(value) {
    return String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  }
  function orcid(value) {
    const raw = normalize(value).replace(/^https?:\/\/(www\.)?orcid\.org\//, '').replace(/\/$/, '');
    const compact = raw.replace(/[\s-]/g, '');
    if (!/^\d{15}[\dx]$/.test(compact)) return null;
    return compact.match(/.{4}/g).join('-').toUpperCase();
  }
  function candidateUrl(item) {
    if (!item || !/^(A\d+|SYNTHETIC)$/.test(item.id)) return null;
    return 'checkup.html?case=' + encodeURIComponent(item.id) + (SCORED.has(item.id) ? '' : '&candidate=1');
  }
  function search(query, candidates) {
    const q = normalize(query);
    if (!q) return { items: [], direct: null };
    const identifier = orcid(q);
    if (identifier) {
      const item = candidates.find(candidate => orcid(candidate.orcid) === identifier);
      return { items: item ? [item] : [], direct: item ? candidateUrl(item) : null };
    }
    // The Chinese spelling is supplied by the demo participant, not inferred for other authors.
    const nameGroup = ['吕志远', '呂志遠', 'zhiyuan lyu', 'zhiyuan lv', 'lyu', 'lv', 'lü'].includes(q);
    const items = candidates.filter(candidate => {
      if (nameGroup) return /zhiyuan.*(lyu|lv)|(lyu|lv).*zhiyuan/i.test(candidate.name);
      const haystack = normalize([candidate.name, candidate.id, ...(candidate.aliases || []),
        ...(candidate.institutions || []), ...(candidate.displayInstitutions || [])].join(' '));
      return q.split(' ').every(word => haystack.includes(word));
    });
    return { items, direct: null };
  }
  function caseCandidates(data) {
    return (data.cases || []).filter(item => SCORED.has(item.openalex)).map(item => ({
      id: item.openalex, name: item.name, institutions: item.institutions || [], topics: [],
      displayInstitutions: item.institutions || [], displayTopics: [], works: item.works,
      orcid: item.orcid, snapshotDate: data.generated, hasScore: true,
      aliases: item.openalex === 'A5100700361' ? ['何恺明', '何凯明'] : item.openalex === 'SYNTHETIC' ? ['虚构', '灌水号'] : [],
      provenance: item.openalex === 'SYNTHETIC' ? '虚构演示案例' : '仓库 OpenAlex 评分快照',
      note: item.openalex === 'SYNTHETIC' ? '完全虚构的演示数据，不对应真实人物或机构。' : '公开数据快照，不代表身份认证；机构字段可能需要核对。',
      sourceUrl: item.openalex === 'SYNTHETIC' ? null : 'https://api.openalex.org/authors/' + item.openalex
    }));
  }
  return Object.freeze({ normalize, orcid, candidateUrl, search, caseCandidates });
});
