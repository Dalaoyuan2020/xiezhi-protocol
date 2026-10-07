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


if __name__ == "__main__":
    print(json.dumps(checkup(sys.argv[1]), ensure_ascii=False, indent=2))
