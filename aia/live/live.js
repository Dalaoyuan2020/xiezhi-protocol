// Same-origin public reader on the main app; compatible with the independent Agent host.
const $ = (id) => document.getElementById(id);
let current = null; // 当前学者 { id, name, ... }
let lastQuery = "";
const uiBase = location.pathname.startsWith('/workbench/') ? '/workbench/' : '/ui/';

// Keep the public search context without allowing a return link off this site.
function configureReturnSearch() {
  const parameters = new URLSearchParams(location.search);
  const network = parameters.get('network');
  const withNetwork = url => {
    if (['mainnet', 'testnet'].includes(network)) url.searchParams.set('network', network);
    return url.pathname + url.search;
  };
  document.querySelectorAll('.top nav a[href]').forEach(link => {
    link.href = withNetwork(new URL(link.getAttribute('href'), location.origin));
  });
  const workbench = document.body.classList.contains('wb-page');
  if (workbench) {
    document.querySelectorAll('#wb-sidebar-slot a[href]').forEach(link => {
      const file = link.getAttribute('href');
      if (window.XiezhiPages?.pages.some(page => page.file === file)) link.href = withNetwork(new URL(uiBase + file, location.origin));
    });
    const heading = document.querySelector('.wb-topbar-title strong');
    if (heading) heading.textContent = '读者 · 实时核验';
  }
  let destination = new URL(uiBase + 'index.html', location.origin);
  const returnTo = parameters.get('returnTo');
  if (returnTo && returnTo.length <= 4096 && !/[\u0000-\u001f\u007f\\]/.test(returnTo)) {
    try {
      const requested = new URL(returnTo, location.origin);
      if (requested.origin === location.origin && !requested.username && !requested.password && ['/ui/', '/ui/index.html', '/workbench/', '/workbench/index.html', '/classic/', '/classic/index.html'].includes(requested.pathname)) {
        if (requested.pathname.startsWith('/classic/')) requested.pathname = requested.pathname.replace('/classic/', '/ui/');
        destination = requested;
      }
    } catch (_) { /* Invalid destinations return to the same-origin search page. */ }
  }
  const returnLink = $('return-search');
  if (returnLink) {
    returnLink.href = withNetwork(destination);
    if (workbench && destination.pathname.startsWith('/workbench/')) {
      const reader = window.XiezhiReader?.create();
      // Restore a verified same-tab selection only; direct links keep their safe return URL.
      if (reader?.detailContext()) reader.bindBack(returnLink);
    }
  }
}

let apiBase = '/scholar-api';
let activeStream = null;
let readOnly = true;
let ready = false;
let scholarRainTimer = null;

function cancelScholarRain() {
  clearTimeout(scholarRainTimer);
  scholarRainTimer = null;
  try { window.Zhidian?.clearRain?.(); } catch (_) { /* An optional visual never blocks a search. */ }
}

function playScholarRain(score) {
  cancelScholarRain();
  try {
    Promise.resolve(window.Zhidian?.rain(score >= 830 ? 70 : score >= 750 ? 50 : 36, '彩蛋 · 高分学者驾到，廌点雨！')).catch(() => {});
  } catch (_) { /* Keep the report usable if the optional celebration is unavailable. */ }
}

async function connect() {
  const params = new URLSearchParams(location.search);
  const demo = ['claim-xu', 'xulinsen'].includes(params.get('demo'));
  window.ClaimFlow.progress(0);
  if (await window.ClaimFlow.restore({ claimId: params.get('claim'), demo, query: params.get('q') })) { ready = true; return; }
  if (demo) {
    ready = true;
    $('net').textContent = '模拟认领案例 · 与真实公开档案分开';
    await window.ClaimFlow.startDemo();
    return;
  }
  try {
    let response = await fetch(`${apiBase}/health`);
    if (response.status === 404) { apiBase = '/api'; response = await fetch(`${apiBase}/health`); }
    if (!response.ok) throw new Error('Service unavailable');
    const h = await response.json();
    readOnly = apiBase === '/scholar-api' || !h.anchoringEnabled;
    window.__anchor = !readOnly;
    $("net").textContent = readOnly ? '公开数据核验 · 可继续认领论文' : (h.network === "local" ? `本地模拟链 · ${h.chainId} · 模拟上链已开启` : `BOT Chain ${h.network === "mainnet" ? "主网" : "测试网"} · ${h.chainId} · 上链已开启`);
    ready = true;
    const q = new URLSearchParams(location.search).get('q')?.slice(0, 200);
    if (q) { $("q").value = q; run(q); }
  } catch {
    $("net").textContent = '核验服务未连接，请刷新重试';
  }
}

function show(id, on = true) { $(id).classList.toggle("hidden", !on); }
function li(text, cls) { const e = document.createElement("li"); if (cls) e.className = cls; e.innerHTML = text; $("log").appendChild(e); }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function run(q, pick) {
  if (!window.ClaimFlow.canLeave()) { $('net').textContent = '钱包操作尚未结束，请先在钱包中确认或取消，再切换学者。'; return; }
  if (!ready) { $("net").textContent = '正在连接核验服务，请稍后重试'; return; }
  cancelScholarRain();
  activeStream?.close();
  window.ClaimFlow.reset();
  window.ClaimFlow.progress(pick ? 1 : 0, pick ? '已选定档案，正在生成体检报告。' : '正在搜索同名候选，稍后请核对机构与研究方向。');
  const pageUrl = new URL(location.href);
  pageUrl.searchParams.delete('demo');
  pageUrl.searchParams.delete('claim');
  pageUrl.searchParams.set('q', q);
  history.replaceState(null, '', pageUrl.pathname + pageUrl.search);
  $('net').textContent = '正在核验真实公开记录…';
  cancelCandidateFilter();
  window.__mis = [];
  allCands = []; candidateNameVariants = [];
  $("cfilter").value = '';
  lastQuery = q; current = null;
  $("log").innerHTML = ""; ["pick", "result", "claimbox"].forEach((x) => show(x, false)); show("steps");
  $("f").querySelector("button").disabled = true;
  const url = `${apiBase}/run?q=${encodeURIComponent(q)}` + (pick ? `&pick=${encodeURIComponent(pick)}` : "");
  const es = new EventSource(url);
  activeStream = es;
  let messages = Promise.resolve(), transportFinished = false;
  function failStream(message) {
    if (activeStream !== es) return;
    // Invalidate queued visual steps as well as the transport. A closed SSE
    // connection alone does not cancel the promise chain below.
    activeStream = null;
    cancelScholarRain();
    transportFinished = true;
    es.close();
    current = null;
    window.ClaimFlow.reset();
    ["pick", "result", "claimbox"].forEach(id => show(id, false));
    li(message, 'warn');
    $('net').textContent = '核验未完成 · 请重试';
    window.ClaimFlow.progress(current ? 1 : 0, '这次核验未完成，点击搜索箭头可以重试；未生成存证结果。');
    $('f').querySelector('button').disabled = false;
  }
  es.onmessage = (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch { failStream('核验结果暂时无法读取，请重试。'); return; }
    // End the transport immediately; queued visual steps can then finish without a false disconnect warning.
    if (e.done || e.error || e.need_pick) { transportFinished = true; es.close(); }
    messages = messages.then(async () => {
    if (activeStream !== es) return;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => setTimeout(resolve, e.card ? 360 : 180));
    if (activeStream !== es) return;
    if (e.error) { failStream("⚠ " + esc(e.error)); return; }
    if (e.done) { es.close(); $("f").querySelector("button").disabled = false; return; }
    if (e.need_pick) { window.ClaimFlow.progress(0, '同名候选已找到，请核对机构并选择需要体检的档案。'); show("pick"); $("f").querySelector("button").disabled = false; return; }
    if (Array.isArray(e.variants)) candidateNameVariants = e.variants;
    if (e.candidates) { renderCands(e.candidates); }
    if (e.target) { current = e.target; window.ClaimFlow.progress(1, `正在为 ${e.target.name || '所选学者'} 生成体检报告。`); }
    const warn = e.step === 5 && e.misattributed && e.misattributed.length;
    if (e.step) li(`<b>第 ${e.step} 步</b>　${esc(e.title)}${e.detail ? "　<span class='muted'>" + esc(e.detail) + "</span>" : ""}`, warn ? "warn" : "");
    if (e.step === 4 && e.works) e.works.slice(0, 3).forEach((w) => li(`　· ${esc(w.year)} ${esc(w.title)}`));
    if (e.misattributed) window.__mis = e.misattributed;
    if (e.cross) {
      (e.cross.missingInProfile || []).slice(0, 3).forEach((w) => li(`　· ${esc(w.source)} 登记、但档案里没有：${esc(w.title || w.doi)}`, "warn"));
      (e.cross.notInOrcid || []).slice(0, 3).forEach((w) => li(`　· 档案里有、但本人 ORCID 未登记：${esc(w.title || w.doi)}`));
    }
    if (e.card) renderCard(e.card);
    }).catch(() => { failStream('核验结果暂时无法读取，请重试。'); });
  };
  es.onerror = () => { if (activeStream !== es || transportFinished) return; failStream('核验连接中断，请重试；未完成的步骤不会生成结论。'); };
}

let allCands = [];
let candidateNameVariants = [];
let candidateFilterTimer;
let candidateFilterController;
let candidateFilterVersion = 0;
const ZH_INST = /China|Chinese|Hohai|Tsinghua|Peking|Fudan|Zhejiang|Shanghai|Nanjing|Wuhan|Sun Yat|Sichuan|Shandong|Harbin|Xi'an|Beijing|Hong Kong|Academy of Sciences/i;
function cancelCandidateFilter() {
  candidateFilterVersion++;
  clearTimeout(candidateFilterTimer);
  candidateFilterController?.abort();
  candidateFilterController = null;
  $("cands").setAttribute('aria-busy', 'false');
}
function candidateHomeLink(filter = '') {
  const url = new URL(uiBase, location.origin);
  url.searchParams.set('q', lastQuery);
  if (filter) url.searchParams.set('institution', filter);
  const network = new URLSearchParams(location.search).get('network');
  if (['mainnet', 'testnet'].includes(network)) url.searchParams.set('network', network);
  $("candidate-filter-home").href = url.pathname + url.search;
}
function drawCandidates(list, count) {
  $("ccount").textContent = count;
  $("cands").innerHTML = list.map((c) => `<button type="button" class="cand" data-id="${esc(c.id)}"><span class="n">${esc(c.name)}</span>
    <span class="m">${esc((c.institutions || []).join(" / ") || "单位未知")}</span>
    <span class="m">${esc((c.topics || []).join("、"))}</span>
    <span class="m">${c.works} 篇 · h ${c.h_index ?? "-"}${c.orcid ? " · ORCID ✓" : ""}</span></button>`).join("");
  $('cands').querySelectorAll('.cand').forEach((el, index) => {
    el.style.setProperty('--candidate-delay', `${Math.min(index, 8) * 70}ms`);
    el.onclick = () => run(lastQuery, el.dataset.id);
  });
}
function filterNotice(message, label, filter = '') {
  drawCandidates([], `共 ${allCands.length} 位同名候选 · ${label}`);
  $("candidate-filter-message").textContent = message;
  $("candidate-filter-empty").hidden = false;
  candidateHomeLink(filter);
}
async function resolveCandidateInstitution(filter, list, version, query) {
  if (version !== candidateFilterVersion) return;
  const controller = new AbortController();
  candidateFilterController = controller;
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const parameters = new URLSearchParams({ q: query, institution: filter });
    const response = await fetch('/scholar-api/search?' + parameters, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Institution lookup unavailable');
    const data = await response.json();
    if (version !== candidateFilterVersion) return;
    if (data.source !== 'openalex' || !Array.isArray(data.results)) throw new Error('Incomplete institution response');
    if (data.institution?.status === 'unresolved') {
      $("candidate-filter-status").textContent = '单位名称尚未匹配；这不表示学者档案不存在。';
      filterNotice('可换用单位全称、英文名，或清除筛选查看原有候选。首页也可以继续按姓名与单位检索。', '单位尚未匹配', filter);
      return;
    }
    if (data.institution?.status !== 'matched') throw new Error('Institution not resolved');
    const ids = new Set(data.results.map(candidate => candidate.id));
    const matches = list.filter(candidate => ids.has(candidate.id));
    const units = (data.institution.matches || []).map(unit => unit.name).filter(Boolean).slice(0, 3).join(' / ');
    $("candidate-filter-status").textContent = `已识别单位：${units || filter}。按公开单位记录核对，记录可能滞后。${data.partial ? '部分检索未完成，当前结果可能不全。' : ''}`;
    if (matches.length) {
      drawCandidates(matches, `共 ${allCands.length} 位同名候选，单位匹配 ${matches.length} 位${data.partial ? '（部分结果）' : ''}`);
      $("candidate-filter-empty").hidden = true;
    } else {
      filterNotice('单位已识别，但本页候选暂未匹配。可清除筛选查看原有候选，或到首页继续查询；这不代表该学者没有档案。', data.partial ? '单位核对结果不完整' : '本页暂未匹配', filter);
    }
  } catch (_) {
    if (version !== candidateFilterVersion) return;
    $("candidate-filter-status").textContent = '单位识别暂未完成，原有候选仍然保留。';
    filterNotice('请稍后重试、换用档案显示的英文单位名，或清除筛选查看全部候选。也可到首页继续查询。', '单位识别未完成', filter);
  } finally {
    clearTimeout(timer);
    if (version === candidateFilterVersion) {
      candidateFilterController = null;
      $("cands").setAttribute('aria-busy', 'false');
    }
  }
}
function filterCandidates() {
  cancelCandidateFilter();
  let list = [...allCands];
  // Preserve exact name matches, then show usable affiliations before missing ones.
  const zh = /[一-鿿]/.test(lastQuery);
  const key = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const known = candidate => (candidate.institutions || []).some(value => value && !/^(unknown|n\/a|null|none|未收录|未知|单位未知|机构未知|暂无|[-—–]+)$/i.test(value.trim()));
  const exactNames = new Set([lastQuery, ...candidateNameVariants].flatMap(name => [name, String(name).trim().split(/\s+/).reverse().join(' ')]).map(key));
  list.sort((a, b) => Number(exactNames.has(key(b.name))) - Number(exactNames.has(key(a.name))) || Number(known(b)) - Number(known(a)) || (zh ? Number(ZH_INST.test((b.institutions || []).join(' '))) - Number(ZH_INST.test((a.institutions || []).join(' '))) : 0));
  const f = ($("cfilter").value || "").normalize('NFKC').trim();
  $("candidate-filter-clear").hidden = !f;
  $("candidate-filter-empty").hidden = true;
  $("candidate-filter-status").textContent = '';
  const matching = f ? list.filter(c => [c.name, ...(c.institutions || []), ...(c.topics || [])].join(' ').normalize('NFKC').toLowerCase().includes(f.toLowerCase())) : list;
  if (!f || matching.length) {
    drawCandidates(matching, `共 ${allCands.length} 位同名学者${f ? `，筛选后 ${matching.length} 位` : ''}（请核对身份后选择）`);
    return;
  }
  if (!/[一-鿿]/.test(f)) {
    filterNotice('当前单位或方向写法未匹配本页候选。可换个关键词，或清除筛选；这不表示学者档案不存在。', '当前筛选未匹配');
    return;
  }
  if (Array.from(f).length < 2) {
    filterNotice('请输入至少两个字的单位名称，或直接使用档案显示的英文名称。', '等待补充单位');
    return;
  }
  if (apiBase !== '/scholar-api') {
    $("candidate-filter-status").textContent = '当前核验页暂不支持中文单位识别。';
    filterNotice('可使用档案显示的英文单位名或清除筛选。前往首页，可继续使用中英文单位查询。', '中文单位待识别', f);
    return;
  }
  drawCandidates([], `共 ${allCands.length} 位同名候选 · 正在识别单位`);
  $("candidate-filter-status").textContent = `正在识别“${f}”对应的学术单位…`;
  $("cands").setAttribute('aria-busy', 'true');
  const version = candidateFilterVersion;
  const query = lastQuery;
  candidateFilterTimer = setTimeout(() => resolveCandidateInstitution(f, list, version, query), 350);
}
function renderCands(list) {
  allCands = list;
  filterCandidates();
}

function renderCard(c) {
  cancelScholarRain();
  const dims = c.dimensions || {};
  const mis = window.__mis || [];
  $("result").innerHTML = `<h2>${esc(c.name)} 的学术体检</h2>
    <div class="score"><div><div class="big">${c.score}</div><div class="tier">${esc(c.tier.name)}</div><div class="muted">${esc(c.tier.benefit)}</div></div>
    <div class="dims">${Object.entries(dims).map(([k, v]) => `<div class="dim"><div class="t"><span>${esc(k)}</span><span>${Math.round(v * 100)}</span></div><div class="bar"><i style="width:${v * 100}%"></i></div></div>`).join("")}</div></div>
    ${mis.length ? `<div class="mis"><b>⚠ 交叉验证发现 ${mis.length} 篇疑似问题论文</b>${mis.slice(0, 6).map((m) => `<div>· ${esc(m.year)} ${esc(m.title)}<br><span class="muted">${esc(m.kind || "疑似错挂")} · 现在 ${esc(m.in_profile_name)} ${esc(m.in_profile)} 名下 · 置信度 ${esc(m.confidence || "中")} · 证据：${esc((m.evidence || []).join("、"))}</span></div>`).join("")}${mis.length > 6 ? `<div class="muted">……共 ${mis.length} 篇</div>` : ""}</div>` : ""}
    <div class="note">${esc(c.confidence)} · 共 ${c.works} 篇 · h 指数 ${c.h_index} · 规则 ${esc(c.rule)}（350–950）· 学术分 ≠ 人品分</div>`;
  show("result"); show("claimbox");
  const paperLink = document.createElement('a');
  const paperUrl = new URL(uiBase + 'papers.html', location.origin);
  paperUrl.searchParams.set('author', c.name);
  const selectedNetwork = new URLSearchParams(location.search).get('network');
  if (['mainnet', 'testnet'].includes(selectedNetwork)) paperUrl.searchParams.set('network', selectedNetwork);
  paperLink.href = paperUrl.pathname + paperUrl.search;
  paperLink.textContent = '检索相关论文与原文片段 →';
  paperLink.className = 'literature-link';
  $("result").append(paperLink);
  current = Object.assign(current || {}, { id: c.openalex, name: c.name });
  $("net").textContent = "公开记录核验完成 · 可继续认领论文";
  window.ClaimFlow.offer({ id: current.id, name: current.name, score: c.score });
  // A celebration changes no points. New searches and failed streams cancel it.
  if (c.score >= 700 && window.Zhidian?.rain) {
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'literature-link';
    replay.textContent = '再看一次廌点雨';
    replay.title = '纯庆祝动画，不额外发放廌点';
    Object.assign(replay.style, { background: 'transparent', border: '0', borderRadius: '4px', color: 'inherit', padding: '0', marginLeft: '16px', textDecoration: 'underline', textUnderlineOffset: '4px' });
    replay.addEventListener('click', () => playScholarRain(c.score));
    $('result').append(replay);
    scholarRainTimer = setTimeout(() => playScholarRain(c.score), 300);
  }
}

$("cfilter").oninput = filterCandidates;
$("candidate-filter-clear").onclick = () => { $("cfilter").value = ''; filterCandidates(); $("cfilter").focus(); };
$("f").onsubmit = (ev) => { ev.preventDefault(); const q = $("q").value.trim(); if (q) run(q); };
document.querySelectorAll(".try a[data-q]").forEach((a) => a.onclick = event => { event.preventDefault(); $("q").value = a.dataset.q; run(a.dataset.q); });
configureReturnSearch();
function describeLocalClaimNetwork() {
  document.querySelectorAll('.sc-network-notice').forEach(banner => banner.remove());
  const slot = $('network-notice');
  if (slot) {
    const banner = document.createElement('aside');
    banner.className = 'cf-network-notice'; banner.setAttribute('aria-label', '此页的存证网络');
    banner.textContent = '公开查询不写链 · 真实认领可由钱包存证到 BOT Chain 主网 · 模拟案例仅用本地链';
    slot.replaceChildren(banner);
  }
  const switcher = $('sc-network-choice');
  if (switcher) switcher.hidden = true;
}
if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', describeLocalClaimNetwork, { once: true });
else describeLocalClaimNetwork();
connect();
