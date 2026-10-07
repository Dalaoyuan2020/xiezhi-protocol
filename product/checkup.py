"""学者「可核查度」体检卡原型：只用 OpenAlex 公开数据。用法: python3 checkup.py <OpenAlex作者ID或ORCID>"""
import json, sys, statistics, urllib.request, collections

API = "https://api.openalex.org"
MAIL = "mailto=lvzhiyuan2026@gmail.com"


def get(path):
    sep = "&" if "?" in path else "?"
    with urllib.request.urlopen(f"{API}{path}{sep}{MAIL}", timeout=30) as r:
        return json.load(r)


def works_of(author_id, limit=400):
    out, cursor = [], "*"
    while cursor and len(out) < limit:
        d = get(f"/works?filter=author.id:{author_id}&per-page=200&cursor={cursor}")
        out += d["results"]
        cursor = d["meta"].get("next_cursor")
    return out


def checkup(author_ref):
    a = get(f"/authors/{author_ref}")
    aid = a["id"].split("/")[-1]
    ws = works_of(aid)
    n = len(ws)
    # 1 身份清晰度：ORCID 10 + 研究领域一致性 10
    fields = [((w.get("primary_topic") or {}).get("field") or {}).get("display_name") for w in ws]
    fields = [f for f in fields if f]
    top_field, top_cnt = collections.Counter(fields).most_common(1)[0] if fields else ("-", 0)
    coherence = top_cnt / len(fields) if fields else 0
    s_id = (10 if a.get("orcid") else 0) + round(10 * coherence)
    # 2 撤稿
    retracted = [w["title"] for w in ws if w.get("is_retracted")]
    s_ret = max(0, 20 - 10 * len(retracted))
    # 3 开放程度
    oa = sum(1 for w in ws if w["open_access"]["is_oa"]) / n if n else 0
    s_oa = round(20 * oa)
    # 4 同领域影响力：FWCI 中位数，1.0 = 世界平均
    fw = [w["fwci"] for w in ws if w.get("fwci") is not None]
    med_fwci = statistics.median(fw) if fw else None
    s_imp = round(min(20, 10 * med_fwci)) if med_fwci is not None else 0
    # 5 产出节奏：单年最多篇数
    per_year = collections.Counter(w["publication_year"] for w in ws)
    peak_year, peak = per_year.most_common(1)[0] if per_year else (None, 0)
    s_pace = 20 if peak <= 15 else 12 if peak <= 30 else 6 if peak <= 60 else 0
    total = s_id + s_ret + s_oa + s_imp + s_pace
    conf = "低（论文少于 10 篇，仅供参考）" if n < 10 else "中" if n < 30 else "高"
    return {
        "name": a["display_name"], "openalex": aid, "orcid": a.get("orcid"),
        "institutions": [i["display_name"] for i in (a.get("last_known_institutions") or [])],
        "works": n, "cited_by": a["cited_by_count"], "h_index": a["summary_stats"]["h_index"],
        "i10_index": a["summary_stats"]["i10_index"],
        "score": total, "confidence": conf,
        "dims": {
            "身份清晰度": f"{s_id}/20（ORCID {'有' if a.get('orcid') else '无'}；主领域 {top_field} 占 {coherence:.0%}）",
            "撤稿与更正": f"{s_ret}/20（撤稿 {len(retracted)} 篇）",
            "开放程度": f"{s_oa}/20（开放获取 {oa:.0%}）",
            "同领域影响力": f"{s_imp}/20（FWCI 中位数 {med_fwci if med_fwci is None else round(med_fwci, 2)}，1.0=世界平均）",
            "产出节奏": f"{s_pace}/20（单年最多 {peak} 篇，{peak_year}）",
        },
    }


# ---------------------------------------------------------------------------
# v1 规则（2026-10-07 晚）：修 v0 的两个硬伤
#   1) v0 是「没有坏事就满分」：只有 2 篇论文、零引用也能拿 70 分
#   2) v0 撤稿只扣 20 分：撤稿 219 篇的学者仍有 53 分
# v1 做法：
#   · 证据量收缩：论文越少，越向「证据不足」的中间值 50 收缩（权重 w = n / (n + 10)）
#   · 诚信红线：撤稿率直接乘在总分上，撤稿率达到 10% 总分归零
#   · 认可度用领域归一化引用（FWCI）的对数，没有引用就是 0，而不是满分
# 各项都在 0–1 之间，最后乘 100。

PRIOR, K = 0.5, 10
WEIGHTS = {"身份": 0.25, "认可": 0.35, "开放": 0.15, "节奏": 0.25}


def count(filter_):
    return get(f"/works?filter={filter_}&per-page=1")["meta"]["count"]


def orcid_employers(orcid):
    try:
        req = urllib.request.Request(f"https://pub.orcid.org/v3.0/{orcid}/record", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            rec = json.load(r)
        groups = rec["activities-summary"]["employments"]["affiliation-group"]
        return [g["summaries"][0]["employment-summary"]["organization"]["name"] for g in groups]
    except Exception:
        return None


def checkup_v1(author_ref):
    import math
    a = get(f"/authors/{author_ref}")
    aid = a["id"].split("/")[-1]
    ws = works_of(aid)
    n_total = a["works_count"]
    n = len(ws)
    # 身份：ORCID 0.4 + ORCID 官方雇主与档案单位一致 0.3 + 研究领域一致性 0.3
    orcid = a["orcid"].split("/")[-1] if a.get("orcid") else None
    insts = [i["display_name"].lower() for i in (a.get("last_known_institutions") or [])]
    emps = orcid_employers(orcid) if orcid else None
    match = bool(emps) and any(e.lower() in i or i in e.lower() for e in emps for i in insts)
    fields = [((w.get("primary_topic") or {}).get("field") or {}).get("display_name") for w in ws]
    fields = [f for f in fields if f]
    top_field, top_cnt = collections.Counter(fields).most_common(1)[0] if fields else ("-", 0)
    coherence = top_cnt / len(fields) if fields else 0
    f_id = (0.4 if orcid else 0) + (0.3 if match else 0) + 0.3 * coherence
    # 认可：FWCI 中位数（1.0 = 世界平均）→ 0.5 + 0.25·log2(FWCI)，截到 0–1；无引用记 0
    fw = [w["fwci"] for w in ws if w.get("fwci") is not None]
    med = statistics.median(fw) if fw else None
    f_rec = 0.0 if not med else max(0.0, min(1.0, 0.5 + 0.25 * math.log2(med)))
    # 开放：开放获取比例
    f_oa = sum(1 for w in ws if w["open_access"]["is_oa"]) / n if n else 0
    # 节奏：单年最多篇数 ≤20 正常；20–50 线性降到 0.3；>50 记 0
    per_year = collections.Counter(w["publication_year"] for w in ws)
    peak_year, peak = per_year.most_common(1)[0] if per_year else (None, 0)
    f_pace = 1.0 if peak <= 20 else 0.3 + 0.7 * (50 - peak) / 30 if peak <= 50 else 0.0
    raw = WEIGHTS["身份"] * f_id + WEIGHTS["认可"] * f_rec + WEIGHTS["开放"] * f_oa + WEIGHTS["节奏"] * f_pace
    # 证据量收缩
    w = n_total / (n_total + K)
    shrunk = PRIOR * (1 - w) + raw * w
    # 诚信红线：撤稿率（用全量计数，不受分页影响）
    retracted = count(f"author.id:{aid},is_retracted:true")
    rate = retracted / n_total if n_total else 0
    integrity = max(0.0, 1 - 10 * rate)
    score = round(100 * shrunk * integrity)
    conf = "低（论文少于 10 篇，分数向中间值 50 收缩）" if n_total < 10 else "中" if n_total < 30 else "高"
    return {
        "rule": "checkup-v1", "name": a["display_name"], "openalex": aid, "orcid": a.get("orcid"),
        "institutions": [i["display_name"] for i in (a.get("last_known_institutions") or [])],
        "works": n_total, "cited_by": a["cited_by_count"], "h_index": a["summary_stats"]["h_index"],
        "i10_index": a["summary_stats"]["i10_index"], "score": score, "confidence": conf,
        "factors": {"身份": round(f_id, 2), "认可": round(f_rec, 2), "开放": round(f_oa, 2), "节奏": round(f_pace, 2),
                    "证据权重": round(w, 2), "诚信系数": round(integrity, 2)},
        "dims": {
            "身份清晰度": f"{round(f_id*100)}/100（ORCID {'有' if orcid else '无'}；ORCID 官方雇主{'与档案一致' if match else '未能对上' if orcid else '—'}；主领域 {top_field} 占 {coherence:.0%}）",
            "同行认可": f"{round(f_rec*100)}/100（FWCI 中位数 {med if med is None else round(med, 2)}，1.0 = 世界平均；无引用记 0）",
            "开放程度": f"{round(f_oa*100)}/100（开放获取 {f_oa:.0%}）",
            "产出节奏": f"{round(f_pace*100)}/100（单年最多 {peak} 篇，{peak_year}）",
            "证据量": f"共 {n_total} 篇 → 证据权重 {w:.2f}（其余部分按中间值 50 计）",
            "诚信红线": f"撤稿 {retracted} 篇，撤稿率 {rate:.1%} → 总分乘以 {integrity:.2f}",
        },
    }


# ---------------------------------------------------------------------------
# v2「灋廌学术分」（2026-10-07 晚，致远定）：350–950 分、五个维度
#   学术身份、学术履历、学术习惯、学术履约、合作网络
# 第一次进入只用公开数据：履约与合作网络还没有记录，记中性 0.5，之后由链上行为更新。
# 撤稿不是一票否决，而是「平衡分」：按撤稿率扣减，最多扣 70%，留出靠履约修复的空间。
# 链上只存 0–100 的整数 chain_value，展示分 = 350 + 6 × chain_value（可复算）。

V2_WEIGHTS = {"学术身份": 0.20, "学术履历": 0.30, "学术习惯": 0.20, "学术履约": 0.20, "合作网络": 0.10}
V2_TIERS = [(830, "极好", "审稿专家，带新审稿人"), (750, "优秀", "期刊优先审稿，可接审稿"), (680, "良好", "投稿免费"),
            (600, "中等 · 证据不足", "新人默认档，做任务提升"), (500, "一般", "投稿需少量积分"), (350, "待提升", "投稿需消耗积分")]


def checkup_v2(author_ref, fulfil=0.5, network=0.5):
    import math
    a = get(f"/authors/{author_ref}")
    aid = a["id"].split("/")[-1]
    ws = works_of(aid)
    n_total = a["works_count"]
    n = len(ws)
    # 学术身份：ORCID 0.4 + ORCID 官方雇主与档案单位一致 0.3 + 研究领域一致性 0.3
    orcid = a["orcid"].split("/")[-1] if a.get("orcid") else None
    insts = [i["display_name"].lower() for i in (a.get("last_known_institutions") or [])]
    emps = orcid_employers(orcid) if orcid else None
    match = bool(emps) and any(e.lower() in i or i in e.lower() for e in emps for i in insts)
    fields = [((w.get("primary_topic") or {}).get("field") or {}).get("display_name") for w in ws]
    fields = [f for f in fields if f]
    top_field, top_cnt = collections.Counter(fields).most_common(1)[0] if fields else ("-", 0)
    coherence = top_cnt / len(fields) if fields else 0
    d_id = (0.4 if orcid else 0) + (0.3 if match else 0) + 0.3 * coherence
    # 学术履历：同行认可（FWCI 中位数对数，无引用记 0）0.6 + 成果积累（对数，50 篇封顶）0.4
    fw = [w["fwci"] for w in ws if w.get("fwci") is not None]
    med = statistics.median(fw) if fw else None
    recog = 0.0 if not med else max(0.0, min(1.0, 0.5 + 0.25 * math.log2(med)))
    volume = min(1.0, math.log(1 + n_total) / math.log(51))
    d_rec = 0.6 * recog + 0.4 * volume
    # 学术习惯：开放获取 0.5 + 产出节奏 0.5（单年 ≤20 篇正常，20–50 线性降到 0.3，>50 记 0）
    oa = sum(1 for w in ws if w["open_access"]["is_oa"]) / n if n else 0
    per_year = collections.Counter(w["publication_year"] for w in ws)
    peak_year, peak = per_year.most_common(1)[0] if per_year else (None, 0)
    pace = 1.0 if peak <= 20 else 0.3 + 0.7 * (50 - peak) / 30 if peak <= 50 else 0.0
    d_hab = 0.5 * oa + 0.5 * pace
    dims = {"学术身份": d_id, "学术履历": d_rec, "学术习惯": d_hab, "学术履约": fulfil, "合作网络": network}
    # 证据量收缩只作用于公开数据部分（规则 v1.2）：链上履约是实打实的行为证据，不因论文少而打折
    pub_keys = ("学术身份", "学术履历", "学术习惯", "合作网络")
    pub_w = sum(V2_WEIGHTS[k] for k in pub_keys)
    raw_pub = sum(V2_WEIGHTS[k] * dims[k] for k in pub_keys) / pub_w
    w = n_total / (n_total + K)
    shrunk = pub_w * (0.5 * (1 - w) + raw_pub * w) + V2_WEIGHTS["学术履约"] * fulfil
    # 撤稿平衡分：按撤稿率扣减，最多扣 70%
    retracted = count(f"author.id:{aid},is_retracted:true")
    rate = retracted / n_total if n_total else 0
    balance = 1 - min(0.7, 3 * rate)
    final = shrunk * balance
    chain_value = round(100 * final)
    score = 350 + 6 * chain_value
    tier = next((t for t in V2_TIERS if score >= t[0]), V2_TIERS[-1])
    conf = "低（论文少于 10 篇，分数向中性收缩）" if n_total < 10 else "中" if n_total < 30 else "高"
    pct = lambda v: f"{round(v * 100)}/100"
    return {
        "rule": "checkup-v2", "name": a["display_name"], "openalex": aid, "orcid": a.get("orcid"),
        "institutions": [i["display_name"] for i in (a.get("last_known_institutions") or [])],
        "works": n_total, "cited_by": a["cited_by_count"], "h_index": a["summary_stats"]["h_index"],
        "score": score, "score_range": [350, 950], "chain_value": chain_value,
        "tier": {"name": tier[1], "benefit": tier[2], "min": tier[0]}, "confidence": conf,
        "dimensions": {k: round(v, 2) for k, v in dims.items()},
        "adjustments": {"证据权重": round(w, 2), "撤稿平衡系数": round(balance, 2)},
        "dims": {
            "学术身份": f"{pct(d_id)}（ORCID {'有' if orcid else '无'}；ORCID 官方雇主{'与档案一致' if match else '未能对上' if orcid else '—'}；主领域 {top_field} 占 {coherence:.0%}）",
            "学术履历": f"{pct(d_rec)}（FWCI 中位数 {med if med is None else round(med, 2)}，无引用记 0；共 {n_total} 篇）",
            "学术习惯": f"{pct(d_hab)}（开放获取 {oa:.0%}；单年最多 {peak} 篇，{peak_year}）",
            "学术履约": f"{pct(fulfil)}（首次进入暂无链上履约记录，记中性；之后由投稿结案、审稿与复现交付更新）",
            "合作网络": f"{pct(network)}（路线图：看合作者本身的可信度；暂记中性）",
            "证据量": f"共 {n_total} 篇 → 证据权重 {w:.2f}",
            "撤稿平衡": f"撤稿 {retracted} 篇，撤稿率 {rate:.1%} → 乘以 {balance:.2f}（最多扣 70%，不是一票否决）",
        },
    }


if __name__ == "__main__":
    args = [x for x in sys.argv[1:] if not x.startswith("--")]
    fn = checkup_v2 if "--v2" in sys.argv else checkup_v1 if "--rule=v1" in sys.argv or "--v1" in sys.argv else checkup
    print(json.dumps(fn(args[0]), ensure_ascii=False, indent=2))
