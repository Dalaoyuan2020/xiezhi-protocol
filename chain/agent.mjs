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

async function getJSON(url, { timeoutMs = 15000, headers = {} } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} 返回 ${res.status}`);
  return res.json();
}
const oa = (path) => getJSON(`${OPENALEX}${path}${path.includes("?") ? "&" : "?"}${MAIL}`);
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
  for (const o of ordered.slice(0, 6)) {
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
    step(2, `找到 ${candidates.length} 位同名学者`, { candidates: candidates.slice(0, 12) });
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

  // 5 查异常：疑似错挂
  if (!candidates.length) candidates = (await findCandidates(target.name)).candidates;
  const hits = await misattributed(target, candidates);
  step(5, hits.length ? `发现 ${hits.length} 篇疑似错挂论文` : "未发现疑似错挂", { misattributed: hits });

  // 6 打分（与 product/checkup.py 同一套公开规则）
  const card = runCheckup(target.id, { rule: "v2" });
  step(6, `灋廌学术分 ${card.score}（${card.tier.name}）`, { card });

  // 7 上链
  if (!opts.anchor) return step(7, "未上链（演示模式）", { chain: null });
  const dep = deployment();
  if (!dep || !opts.privateKey) return step(7, "未上链：缺少部署信息或平台钱包", { chain: null });
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(opts.privateKey, provider);
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
