// 灋廌覈鑒 · 后台 Agent：输入一个名字或 ORCID → 实时检索 → 认人 → 拉成果 → 查异常 → 打分 → 上链
// 每一步通过 emit(step) 推给调用方（HTTP 服务用 SSE 转给前端）。
import { ethers } from "ethers";
import { pinyin } from "pinyin-pro";
import { nameVariants as sharedNameVariants } from "../research-core/lib/names.mjs";
import { artifact, RPC, CHAIN_ID, EXPLORER, NETWORK, deployment } from "./config.mjs";
import { runCheckup, toChainArgs, kindOf, orgOf, contentOfBytes } from "./lib.mjs";

const OPENALEX = "https://api.openalex.org";
const MAIL = "mailto=lvzhiyuan2026@gmail.com";
const ORCID_RE = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/i;
const OPENALEX_RE = /\b(A\d{6,})\b/i;

// 公开数据源有限流（OpenAlex 偶发 429）：10 分钟内存缓存 + 429/5xx 退避重试，最多 5 次
const CACHE = new Map();
const CACHE_DIR = new URL("./.cache/", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createHash } = await import("node:crypto");
const fs = await import("node:fs");
const TTL = 24 * 3600 * 1000;   // 查过的数据缓存 24 小时：演示时重复查同一人不耗 OpenAlex 额度
// 缓存键去掉 api_key：加不加 OPENALEX_API_KEY，查过的数据都能复用
const ck = (url) => url.replace(/&api_key=[^&]*/, "");
function diskGet(url) {
  try {
    const f = new URL(createHash("sha1").update(ck(url)).digest("hex") + ".json", CACHE_DIR);
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs < TTL) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {}
  return undefined;
}
function diskPut(url, v) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(new URL(createHash("sha1").update(ck(url)).digest("hex") + ".json", CACHE_DIR), JSON.stringify(v)); } catch {}
}
async function getJSON(url, { timeoutMs = Number(process.env.XIEZHI_HTTP_TIMEOUT_MS || 15000), headers = {} } = {}) {
  const hit = CACHE.get(url);
  if (hit && Date.now() - hit.t < 600000) return hit.v;
  const disk = diskGet(url);
  if (disk !== undefined) { CACHE.set(url, { t: Date.now(), v: disk }); return disk; }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) { const v = await res.json(); CACHE.set(url, { t: Date.now(), v }); diskPut(url, v); return v; }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 800 * 2 ** attempt);
      continue;
    }
    throw new Error(`${new URL(url).host} 返回 ${res.status}`);
  }
}
// OpenAlex 2026 起按天计额：带 API key（环境变量 OPENALEX_API_KEY）额度约为不带的 10 倍
const OA_KEY = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : "";
const oa = (path) => getJSON(`${OPENALEX}${path}${path.includes("?") ? "&" : "?"}${MAIL}${OA_KEY}`);
const shortId = (id) => String(id).split("/").pop();

// 中文名 → 拼音拼写变体：吕志远 → Zhiyuan Lyu / Zhiyuan Lv / Zhiyuan Lu
export function nameVariants(input) {
  return sharedNameVariants(input, pinyin);
}

function candidateCard(a) {
  return {
    id: shortId(a.id), name: a.display_name, orcid: a.orcid ? shortId(a.orcid) : null,
    works: a.works_count, cited_by: a.cited_by_count, h_index: a.summary_stats?.h_index ?? null,
    institutions: (a.last_known_institutions || []).map((i) => i.display_name),
    institution_ids: (a.last_known_institutions || []).map((i) => shortId(i.id)),
    topics: (a.topics || []).slice(0, 2).map((t) => t.display_name),
  };
}

export async function findCandidates(query) {
  const variants = nameVariants(query);
  const seen = new Map();
  for (const v of variants) {
    const d = await oa(`/authors?search=${encodeURIComponent(v)}&per-page=25`);
    for (const a of d.results) if (!seen.has(a.id)) seen.set(a.id, candidateCard(a));
  }
  // 只保留名字真正对得上的人（OpenAlex 的模糊检索会把 Zhouguang Lu 之类也带出来），再按论文数排序
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const wanted = new Set(variants.map(norm));
  const swapped = new Set(variants.map((v) => norm(v.split(" ").reverse().join(" "))));
  const list = [...seen.values()].filter((c) => wanted.has(norm(c.name)) || swapped.has(norm(c.name)));
  return { variants, candidates: (list.length ? list : [...seen.values()]).sort((x, y) => y.works - x.works) };
}

// 同名的其他档案里，有没有论文的作者单位落在本人单位 → 疑似错挂
async function misattributed(target, others) {
  const mine = new Set(target.institution_ids);
  const hits = [];
  // 先查和本人同单位的同名档案（最可能错挂），再查论文最多的几个
  const shared = (o) => o.institution_ids.some((i) => mine.has(i));
  const ordered = [...others.filter(shared), ...others.filter((o) => !shared(o))];
  for (const o of [...others.filter(shared), ...others.filter((o) => !shared(o)).slice(0, 2)].slice(0, 4)) {
    if (o.id === target.id) continue;
    const d = await oa(`/works?filter=author.id:${o.id}&per-page=50`);
    for (const w of d.results) {
      const au = w.authorships.find((x) => shortId(x.author?.id || "") === o.id);
      const inst = (au?.institutions || []).map((i) => shortId(i.id));
      if (inst.some((i) => mine.has(i)))
        hits.push({ title: w.title, year: w.publication_year, doi: w.doi, in_profile: o.id, in_profile_name: o.name, in_profile_orcid: o.orcid });
    }
  }
  return hits;
}

// 多库交叉核对：ORCID（本人填写）与 Crossref（DOI 登记机构）按 ORCID 查论文，与 OpenAlex 档案比对
const normDoi = (d) => (d ? String(d).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "") : null);
async function crossCheck(orcid, oaWorks) {
  const out = { sources: [], orcidWorks: 0, crossrefWorks: 0, missingInProfile: [], notInOrcid: [] };
  if (!orcid) return { ...out, note: "该档案没有 ORCID，无法交叉核对" };
  const oaDois = new Set(oaWorks.map((w) => normDoi(w.doi)).filter(Boolean));
  const ext = new Map();
  try {
    const r = await getJSON(`https://pub.orcid.org/v3.0/${orcid}/works`, { headers: { Accept: "application/json" } });
    for (const g of r.group || []) {
      const ws = g["work-summary"]?.[0]; const ids = ws?.["external-ids"]?.["external-id"] || [];
      const doi = normDoi(ids.find((x) => x["external-id-type"] === "doi")?.["external-id-value"]);
      out.orcidWorks++; if (doi) ext.set(doi, { title: ws?.title?.title?.value, source: "ORCID" });
    }
    out.sources.push("ORCID");
  } catch (e) { out.sources.push("ORCID（查询失败）"); }
  try {
    const r = await getJSON(`https://api.crossref.org/works?filter=orcid:${orcid}&rows=100&select=DOI,title&mailto=lvzhiyuan2026@gmail.com`);
    for (const it of r.message?.items || []) { out.crossrefWorks++; const d = normDoi(it.DOI); if (d && !ext.has(d)) ext.set(d, { title: it.title?.[0], source: "Crossref" }); }
    out.sources.push("Crossref");
  } catch (e) { out.sources.push("Crossref（查询失败）"); }
  out.extDois = [...ext.keys()];
  for (const [doi, w] of ext) if (!oaDois.has(doi)) out.missingInProfile.push({ doi, ...w });
  if (out.orcidWorks) for (const w of oaWorks) { const d = normDoi(w.doi); if (d && !ext.has(d)) out.notInOrcid.push({ doi: d, title: w.title }); }
  return out;
}

// 交叉验证：综合「同单位、ORCID 是否冲突、本人 ORCID/Crossref 是否登记了这篇」三类证据，给出判定与置信度
function judge(target, hits, cross) {
  const ext = new Set(cross.extDois || []);
  const byProfile = new Map();
  for (const h of hits) {
    const d = normDoi(h.doi); const evidence = ["同单位署名"];
    if (d && ext.has(d)) evidence.push("本人 ORCID / Crossref 登记了这篇");
    let kind, conf;
    if (target.orcid && h.in_profile_orcid && target.orcid !== h.in_profile_orcid) {
      kind = "错挂到他人名下"; evidence.push("该档案属于另一个 ORCID"); conf = evidence.length >= 3 ? "高" : "中";
    } else {
      kind = "疑似同一人被拆成两个档案"; evidence.push(h.in_profile_orcid ? "另一档案关联了 ORCID，本档案没有" : "两个档案都没有可区分的 ORCID"); conf = d && ext.has(d) ? "高" : "中";
    }
    Object.assign(h, { kind, confidence: conf, evidence });
    const g = byProfile.get(h.in_profile) || { profile: h.in_profile, name: h.in_profile_name, orcid: h.in_profile_orcid, kind, papers: 0, confidence: conf };
    g.papers++; if (conf === "高") g.confidence = "高"; byProfile.set(h.in_profile, g);
  }
  return [...byProfile.values()];
}

// 最近核验结果（30 分钟）：认领、发验证码直接复用，不再重复查 OpenAlex
const SESSIONS = new Map();
const recent = (id) => { const r = SESSIONS.get(id); return r && Date.now() - r.at < 30 * 60 * 1000 ? r : null; };

// 主流程。opts.pick：用户选中的 OpenAlex 作者 ID；opts.anchor：是否上链；opts.privateKey：平台钱包
export async function run(query, emit, opts = {}) {
  const step = (n, title, data = {}) => emit({ step: n, title, ...data });
  const q = String(query || "").trim();
  if (!q) throw new Error("请输入 ORCID、中文名或拼音");

  // 1 理解输入
  let target = null, candidates = [];
  const orcid = q.match(ORCID_RE)?.[1];
  const direct = opts.pick || q.match(OPENALEX_RE)?.[1];
  if (orcid) {
    step(1, "识别为 ORCID", { detail: orcid });
    step(2, "按 ORCID 直接定位学者", { detail: "OpenAlex 作者库" });
    target = candidateCard(await oa(`/authors/orcid:${orcid}`));
  } else if (direct) {
    step(1, "识别为学者编号", { detail: direct });
    step(2, "直接定位学者", { detail: "OpenAlex 作者库" });
    target = candidateCard(await oa(`/authors/${direct}`));
    if (opts.query) candidates = (await findCandidates(opts.query)).candidates;
  } else {
    const variants = nameVariants(q);
    step(1, /[一-鿿]/.test(q) ? "识别为中文姓名" : "识别为拼音 / 英文姓名", { detail: `检索拼写：${variants.join(" / ")}` });
    ({ candidates } = await findCandidates(q));
    step(2, `找到 ${candidates.length} 位同名学者`, { variants, candidates: candidates.slice(0, 80) });
    if (candidates.length === 0) throw new Error("没有找到这个名字的学者");
    if (candidates.length > 1) return emit({ step: 2, need_pick: true, title: "同名学者较多，请先选出本人" });
    target = candidates[0];
  }

  // 3 认人：ORCID 官方记录核对
  let orcidCheck = null;
  if (target.orcid) {
    try {
      const r = await getJSON(`https://pub.orcid.org/v3.0/${target.orcid}/record`, { headers: { Accept: "application/json" } });
      const emp = (r["activities-summary"]?.employments?.["affiliation-group"] || []).map((g) => g.summaries[0]["employment-summary"].organization.name);
      const match = emp.some((e) => target.institutions.some((i) => i.toLowerCase().includes(e.toLowerCase()) || e.toLowerCase().includes(i.toLowerCase())));
      orcidCheck = { orcid: target.orcid, employers: emp, match };
    } catch (e) { orcidCheck = { orcid: target.orcid, error: e.message }; }
  }
  step(3, "核对身份", { target, orcid: orcidCheck,
    detail: !target.orcid ? "该档案未关联 ORCID" : orcidCheck?.error ? `ORCID 查询失败：${orcidCheck.error}` : `ORCID 官方雇主：${orcidCheck.employers.join("、") || "未填写"}${orcidCheck.match ? " ✓ 与档案单位一致" : ""}` });

  // 4 拉成果
  const works = (await oa(`/works?filter=author.id:${target.id}&per-page=50&sort=publication_year:desc`)).results;
  step(4, `拉取到 ${works.length} 篇论文`, { works: works.slice(0, 8).map((w) => ({ title: w.title, year: w.publication_year, venue: w.primary_location?.source?.display_name || null, oa: w.open_access?.is_oa, retracted: w.is_retracted })) });

  // 5 查异常：疑似错挂（同名档案比对）+ 多库交叉核对（ORCID、Crossref）
  if (!candidates.length) candidates = (await findCandidates(target.name)).candidates;
  const hits = await misattributed(target, candidates);
  const cross = await crossCheck(target.orcid, works);
  const profiles = judge(target, hits, cross);
  const headline = profiles.length ? profiles.map((g) => `${g.kind}：${g.name} ${g.profile}（${g.papers} 篇，置信度${g.confidence}）`).join("；") : "未发现错挂或档案拆分";
  step(5, hits.length ? `发现 ${hits.length} 篇疑似问题论文 · ${headline}` : "未发现错挂或档案拆分", { misattributed: hits, profiles, cross,
    detail: `交叉核对 ${cross.sources.join("、") || "—"}：ORCID 登记 ${cross.orcidWorks} 篇，Crossref ${cross.crossrefWorks} 篇；档案缺 ${cross.missingInProfile.length} 篇，ORCID 未登记 ${cross.notInOrcid.length} 篇` });

  // 6 打分（与 product/checkup.py 同一套公开规则）
  const card = runCheckup(target.id, { rule: "v2" });
  SESSIONS.set(target.id, { target, hits, card, at: Date.now() });
  step(6, `灋廌学术分 ${card.score}（${card.tier.name}）`, { card });

  // 7 上链
  if (!opts.anchor) return step(7, "体检完成 · 本人认领后才盖章上链", { chain: null });
  const dep = deployment();
  if (!dep || !opts.privateKey) return step(7, "未上链：缺少部署信息或平台钱包", { chain: null });
  const provider = new ethers.JsonRpcProvider(RPC);
  // NonceManager：同一钱包连发多笔（评分 + 积分）时本地记 nonce，本地链秒出块也不会撞号
  const wallet = new ethers.NonceManager(new ethers.Wallet(opts.privateKey, provider));
  const reg = new ethers.Contract(dep.address, artifact().abi, wallet);
  const args = toChainArgs(card, "checkup-v2");
  step(7, "签名并广播交易…", { network: NETWORK, chainId: Number(CHAIN_ID), contract: dep.address });
  const tx = await reg.submitScore(...args);
  const rc = await tx.wait();
  const chain = { network: NETWORK, chainId: Number(CHAIN_ID), contract: dep.address, tx: tx.hash, block: rc.blockNumber,
    txUrl: `${EXPLORER}/tx/${tx.hash}`, subject: args[0], snapshot: args[2], rule: "checkup-v2", score: card.score, chain_value: card.chain_value, tier: card.tier };

  // 个人上链 = 盖红章：第一次上链的人领新手保护积分（积分账本已部署时）
  let points = null;
  try {
    const { pointsDeployment, ledger, apply, balance } = await import("./points.mjs");
    if (pointsDeployment()) {
      const c = ledger(wallet);
      const first = (await balance(c, target.id)) === 0;
      const award = first ? await apply(c, target.id, "NEWCOMER", args[2]) : null;
      points = { balance: await balance(c, target.id), award };
    }
  } catch (e) { points = { error: e.shortMessage || e.message }; }
  step(7, "红章已盖 ✓ 个人已上链", { sealed: true, seal: "灋廌覈鑒", chain, points,
    meaning: "红章 = 这份公开档案的体检结果已登记上链，任何人可复算核对；不等于身份已经本人授权核验" });
}

// 稿件盖章：算指纹 → 结构预检 → 平台登记上链（不等于审稿通过）
export async function stamp({ bytes, filename = "manuscript", authorId = null }, emit, opts = {}) {
  const step = (n, title, data = {}) => emit({ step: n, title, ...data });
  const fingerprint = contentOfBytes(bytes);
  step(1, "计算稿件指纹", { detail: fingerprint, filename, size: bytes.length });
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const checks = [
    { item: "标题", ok: /^\s*#\s+\S/m.test(text) || /title/i.test(text.slice(0, 2000)) },
    { item: "摘要", ok: /abstract|摘要/i.test(text) },
    { item: "参考文献", ok: /references|参考文献/i.test(text) },
    { item: "DOI 至少 1 个", ok: /10\.\d{4,9}\/\S+/.test(text) },
  ];
  const passed = checks.every((c) => c.ok);
  step(2, passed ? "结构预检通过" : "结构预检有缺项", { checks, passed });
  if (!passed) return step(3, "未盖章：请补齐缺项后重新提交", { sealed: false });
  if (!opts.anchor) return step(3, "预检通过（演示模式，未上链）", { sealed: false, fingerprint });
  const dep = deployment();
  if (!dep || !opts.privateKey) return step(3, "未上链：缺少部署信息或平台钱包", { sealed: false });
  const wallet = new ethers.Wallet(opts.privateKey, new ethers.JsonRpcProvider(RPC));
  const reg = new ethers.Contract(dep.address, artifact().abi, wallet);
  const subject = ethers.keccak256(ethers.toUtf8Bytes(`openalex:${authorId || "UNKNOWN"}`));
  step(3, "签名并广播交易…", { network: NETWORK });
  const tx = await reg.record(subject, kindOf("SUBMIT"), fingerprint, orgOf("灋廌覈鑒 存证"), ethers.ZeroHash, 0);
  const rc = await tx.wait();
  step(3, "红章已盖 ✓ 指纹已上链", { sealed: true, fingerprint,
    chain: { network: NETWORK, contract: dep.address, tx: tx.hash, block: rc.blockNumber, txUrl: `${EXPLORER}/tx/${tx.hash}` },
    meaning: "红章 = 稿件指纹已登记上链 + 结构预检通过；不等于论文为真或审稿通过" });
}

// ---------------- 本人认领：逐篇确认 → 邮箱验证 → 生成认领凭证 → 上链盖章 ----------------
// 邮箱验证码。当前为「演示模式」：不真发邮件，验证码打印在服务端日志（XIEZHI_DEMO_CODES=1 时也显示在页面上）。
// 正式版接邮件服务后，只需把 deliver() 换成真发信，其余流程不变。
const CODES = new Map();   // key = authorId|email → { code, exp, tries, domainMatch }
const emailOk = (e) => /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i.test(e || "");
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };
const deliver = (email, code) => console.log(`[演示模式] 发往 ${email} 的验证码：${code}`);

export async function sendCode({ authorId, email }) {
  if (!emailOk(email)) throw Object.assign(new Error("邮箱格式不对"), { status: 400 });
  const target = recent(authorId)?.target || candidateCard(await oa(`/authors/${authorId}`));
  // 单位邮箱核对：邮箱域名 = 档案单位官网域名或其子域（例如 hhu.edu.cn ↔ 河海大学）。只认这一个方向，x@edu.cn 不算
  const instDomains = [];
  for (const id of target.institution_ids.slice(0, 3)) {
    try { const d = domainOf((await oa(`/institutions/${id}`)).homepage_url); if (d) instDomains.push(d); } catch {}
  }
  const ed = email.split("@")[1].toLowerCase();
  const domainMatch = instDomains.some((d) => ed === d || ed.endsWith("." + d));
  const code = String(Math.floor(100000 + Math.random() * 900000));
  CODES.set(`${authorId}|${email.toLowerCase()}`, { code, exp: Date.now() + 10 * 60 * 1000, tries: 0, domainMatch });
  deliver(email, code);
  return { sent: false, demo: true, demoCode: process.env.XIEZHI_DEMO_CODES === "1" ? code : undefined, domainMatch, institutionDomains: instDomains,
    note: "演示模式：没有真发邮件，验证码显示在这里（正式版发到你的邮箱，10 分钟内有效）" };
}

// 通过返回 { domainMatch }，不通过返回 null
function verifyCode(authorId, email, code) {
  const k = `${authorId}|${String(email || "").toLowerCase()}`; const r = CODES.get(k);
  if (!r || Date.now() > r.exp) return null;
  if (++r.tries > 5) { CODES.delete(k); return null; }
  if (r.code !== String(code)) return null;
  CODES.delete(k); return { domainMatch: r.domainMatch };
}

// decisions: { claimed: [论文键], rejected: [论文键] }，论文键 = DOI 或标题
export async function claim({ authorId, orcid = null, email = null, code = null, decisions = {} }, emit, opts = {}) {
  const step = (n, title, data = {}) => emit({ step: n, title, ...data });
  // 先核对 ORCID（不消耗验证码），再核对验证码
  const cached = recent(authorId);
  const target = cached?.target || candidateCard(await oa(`/authors/${authorId}`));
  if (orcid && target.orcid && target.orcid.toUpperCase() !== String(orcid).toUpperCase())
    return step(1, "认领被拒：填写的 ORCID 与该档案不一致", { refused: true, target });
  const v = opts.skipVerify ? { domainMatch: false } : verifyCode(authorId, email, code);
  if (!v) return step(1, "认领被拒：邮箱验证码不正确或已过期", { refused: true });
  step(1, v.domainMatch ? "邮箱验证通过 · 单位邮箱与档案单位一致" : "邮箱验证通过 · 非单位邮箱，凭证标记「待复核」",
    { email: email ? email.replace(/(^.).*(@.*$)/, "$1***$2") : null, institutional: v.domainMatch });
  const hits = cached?.hits || (await misattributed(target, (await findCandidates(target.name)).candidates));
  const key = (h) => normDoi(h.doi) || h.title;
  const claimedSet = new Set(decisions.claimed || []), rejectedSet = new Set(decisions.rejected || []);
  const claimed = hits.filter((h) => claimedSet.has(key(h))), rejected = hits.filter((h) => rejectedSet.has(key(h)));
  step(2, `逐篇确认：认领 ${claimed.length} 篇，排除 ${rejected.length} 篇，待定 ${hits.length - claimed.length - rejected.length} 篇`);
  const card = cached?.card || runCheckup(target.id, { rule: "v2" });
  step(3, `灋廌学术分 ${card.score}（${card.tier.name}）`, { card });
  // 认领凭证：链上只放它的指纹，邮箱只放哈希
  const certificate = {
    type: "灋廌覈鑒 · 学术档案认领凭证", version: 1, profile: target.id, name: target.name, orcid: orcid || target.orcid || null,
    email_hash: email ? ethers.keccak256(ethers.toUtf8Bytes(email.trim().toLowerCase())) : null,
    verification: { method: "email", institutional_email: v.domainMatch, status: v.domainMatch ? "本人认领" : "待复核" },
    claimed: claimed.map((h) => ({ title: h.title, doi: normDoi(h.doi), from_profile: h.in_profile, verdict: h.kind || "疑似错挂", confidence: h.confidence || "中" })),
    rejected: rejected.map((h) => ({ title: h.title, doi: normDoi(h.doi), from_profile: h.in_profile })),
    score: card.score, tier: card.tier.name, rule: "checkup-v2", network: NETWORK, issued_at: new Date().toISOString(),
  };
  const certHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(certificate)));
  step(4, "已生成认领凭证", { certificate, certHash });
  if (!opts.anchor) return step(5, "演示模式：凭证已生成，未上链（服务端未开启上链写入）", { sealed: false, certificate, certHash });
  const dep = deployment();
  if (!dep || !opts.privateKey) return step(5, "未上链：缺少部署信息或平台钱包", { sealed: false, certificate, certHash });
  const wallet = new ethers.NonceManager(new ethers.Wallet(opts.privateKey, new ethers.JsonRpcProvider(RPC)));
  const reg = new ethers.Contract(dep.address, artifact().abi, wallet);
  const chainName = NETWORK === "local" ? "本地模拟链" : NETWORK === "testnet" ? "BOT 测试网" : "BOT 主网";
  step(5, `签名并写入${chainName}：评分记录…`);
  const args = toChainArgs(card, "checkup-v2");
  const t1 = await reg.submitScore(...args); const r1 = await t1.wait();
  step(5, `签名并写入${chainName}：认领凭证…`);
  const t2 = await reg.record(args[0], kindOf("CLAIM"), certHash, ethers.ZeroHash, ethers.ZeroHash, 0); const r2 = await t2.wait();
  const link = (h) => (EXPLORER ? `${EXPLORER}/tx/${h}` : null);
  const txs = [
    { label: "评分上链", tx: t1.hash, block: r1.blockNumber, txUrl: link(t1.hash) },
    { label: "认领凭证上链", tx: t2.hash, block: r2.blockNumber, txUrl: link(t2.hash) },
  ];
  let points = null;
  try {
    const P = await import("./points.mjs");
    if (P.pointsDeployment()) {
      const c = P.ledger(wallet); const awards = [];
      if (target.works > 0 && (await P.balance(c, target.id)) === 0) awards.push(await P.apply(c, target.id, "NEWCOMER", certHash));
      // 认领错挂 +5：只发给交叉验证「高」置信的论文，且须单位邮箱；其余等复核通过再发（防自说自话刷分）
      const fix = v.domainMatch ? claimed.filter((h) => h.confidence === "高").slice(0, 3) : [];
      for (const h of fix) awards.push(await P.apply(c, target.id, "CLAIM_FIX", ethers.keccak256(ethers.toUtf8Bytes(key(h)))));
      points = { balance: await P.balance(c, target.id), awards, pending: claimed.length - fix.length };
    }
  } catch (e) { points = { error: e.shortMessage || e.message }; }
  step(6, v.domainMatch ? `红章已盖 ✓ 认领凭证已写入${chainName}` : `已写入${chainName} · 待复核（非单位邮箱，盖灰章）`, { sealed: true, seal: "灋廌覈鑒", sealColor: v.domainMatch ? "red" : "grey",
    contract: dep.address, chain: chainName, network: NETWORK, certificate, certHash, card, txs, points,
    meaning: "红章 = 认领凭证与评分的指纹已登记上链，任何人可复算核对；邮箱只存哈希，不存原文" });
}
