"""灋廌学术分 v2 可行性抽样验证：随机抽 OpenAlex 学者，看分数分布、档位占比、与 h 指数的关系、可复算性"""
import json, math, random, statistics, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
import checkup as C

def sample(n, seed, flt):
    d = C.get(f"/authors?sample={n}&seed={seed}&filter={flt}&per-page={n}")
    return [a["id"].split("/")[-1] for a in d["results"]]

def safe(aid):
    try: return C.checkup_v2(aid)
    except Exception as e: return {"openalex": aid, "error": str(e)[:80]}

def spearman(x, y):
    rx = {v: i for i, v in enumerate(sorted(range(len(x)), key=lambda i: x[i]))}
    ry = {v: i for i, v in enumerate(sorted(range(len(y)), key=lambda i: y[i]))}
    n = len(x); d2 = sum((rx[i] - ry[i]) ** 2 for i in range(n))
    return 1 - 6 * d2 / (n * (n * n - 1))

ids = sample(40, 7, "works_count:>2") + sample(20, 11, "works_count:>50,has_orcid:true")
with ThreadPoolExecutor(6) as ex: cards = list(ex.map(safe, ids))
ok = [c for c in cards if "score" in c]
scores = [c["score"] for c in ok]; h = [c["h_index"] for c in ok]
tiers = {}
for c in ok: tiers[c["tier"]["name"]] = tiers.get(c["tier"]["name"], 0) + 1
again = safe(ok[0]["openalex"])
print(json.dumps({
  "抽样": len(ids), "成功": len(ok), "失败": len(cards) - len(ok),
  "分数 最低/中位/最高": [min(scores), statistics.median(scores), max(scores)],
  "标准差": round(statistics.pstdev(scores), 1),
  "档位分布": tiers,
  "与 h 指数的 Spearman 相关": round(spearman(scores, h), 2),
  "可复算（同一人重算一次分数相同）": again["score"] == ok[0]["score"],
  "撤稿>0 的人数": sum(1 for c in ok if c["adjustments"]["撤稿平衡系数"] < 1),
}, ensure_ascii=False, indent=1))
json.dump(ok, open("sample_validation_result.json", "w"), ensure_ascii=False)
for c in sorted(ok, key=lambda c: -c["score"])[:5] + sorted(ok, key=lambda c: c["score"])[:5]:
    print(c["score"], c["tier"]["name"], c["works"], "篇 h", c["h_index"], c["name"])
