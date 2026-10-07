"""灋廌学术分 · 一键验收（2026-10-07 晚）

用法：python3 aia/product/acceptance.py          （约 3–5 分钟，需要联网；不花 Gas、不写链）
每一项都有事先写死的「通过标准」，输出 PASS / FAIL。任何人都能重跑，不需要相信写脚本的人。

验收分 4 组：
  一、公式与代码一致（规格书 ↔ 代码 ↔ 链上）
  二、效度：对照组 + 随机抽样与 h 指数的关系
  三、稳定与单调：可复算、扰动后方向正确
  四、防作弊：积分不变量 + 12 个月模拟
另有「五、人工盲评」需要致远本人填写，脚本只给出表格。
"""
import json, math, os, random, statistics, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import checkup as C
import points_model as PM

results = []


def check(group, name, ok, detail):
    results.append((group, name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  [{group}] {name}  —  {detail}", flush=True)


def spec_score(card):
    """按 SCORING_SPEC.md 第 3 节的公式，只用卡片里公开的维度值独立重算一遍"""
    d, adj = card["dimensions"], card["adjustments"]
    pub = (0.20 * d["学术身份"] + 0.30 * d["学术履历"] + 0.20 * d["学术习惯"] + 0.10 * d["合作网络"]) / 0.80
    w = adj["证据权重"]
    comb = 0.80 * (0.5 * (1 - w) + pub * w) + 0.20 * d["学术履约"]
    return 350 + 6 * round(100 * comb * adj["撤稿平衡系数"])


def spearman(x, y):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i]); r = [0] * len(v)
        for k, i in enumerate(order): r[i] = k
        return r
    rx, ry = ranks(x), ranks(y); n = len(x)
    return 1 - 6 * sum((a - b) ** 2 for a, b in zip(rx, ry)) / (n * (n * n - 1))


# ---------------- 一、公式与代码一致 ----------------
CASES = {"致远": "A5126602136", "何恺明": "A5100700361", "Karpathy": "A5009290031",
         "撤稿案例A": "A5031327561", "撤稿案例B": "A5027036101"}
with ThreadPoolExecutor(5) as ex:
    cards = dict(zip(CASES, ex.map(lambda i: C.checkup_v2(i), CASES.values())))
diffs = {k: abs(spec_score(c) - c["score"]) for k, c in cards.items()}
check("一 一致", "规格书公式重算 = 代码输出", all(v <= 6 for v in diffs.values()),
      "逐人差值 " + ", ".join(f"{k} {v}" for k, v in diffs.items()) + "（≤6 分视为舍入误差）")
check("一 一致", "分数范围与档位", all(350 <= c["score"] <= 950 and c["tier"]["name"] for c in cards.values()),
      ", ".join(f"{k} {c['score']}·{c['tier']['name']}" for k, c in cards.items()))
try:
    out = subprocess.run(["node", "read.mjs", CASES["致远"]], cwd=os.path.join(HERE, "..", "chain"),
                         capture_output=True, text=True, timeout=60).stdout
    rec = [a for a in json.loads(out) if a["kind"] == "SCORE" and a["rule"] == "checkup-v2"]
    on_chain = 350 + 6 * rec[-1]["value"] if rec else None
    check("一 一致", "BOT Chain 主网记录 = 代码算出的分", on_chain == cards["致远"]["score"],
          f"主网 chain_value {rec[-1]['value'] if rec else '无'} → {on_chain}；代码 {cards['致远']['score']}")
except Exception as e:
    check("一 一致", "BOT Chain 主网记录 = 代码算出的分", False, f"读链失败：{e}")

# ---------------- 二、效度 ----------------
s = {k: c["score"] for k, c in cards.items()}
check("二 效度", "对照组：干净的高影响力学者 ≥ 750", s["何恺明"] >= 750, f"何恺明 {s['何恺明']}")
check("二 效度", "对照组：大规模撤稿的公开案例 ≤ 500", s["撤稿案例A"] <= 500 and s["撤稿案例B"] <= 500,
      f"A {s['撤稿案例A']}，B {s['撤稿案例B']}")
check("二 效度", "对照组：只有 2 篇论文的新人落在「证据不足」600–679", 600 <= s["致远"] <= 679, f"致远 {s['致远']}")
check("二 效度", "对照组排序：何恺明 > 新人 > 撤稿案例", s["何恺明"] > s["致远"] > max(s["撤稿案例A"], s["撤稿案例B"]),
      f"{s['何恺明']} > {s['致远']} > {max(s['撤稿案例A'], s['撤稿案例B'])}")
def sample_cards(flt, seed, n=30):
    ids = [a["id"].split("/")[-1] for a in C.get(f"/authors?sample={n}&seed={seed}&filter={flt}&per-page={n}")["results"]]
    with ThreadPoolExecutor(6) as ex: return list(ex.map(C.checkup_v2, ids))
# 分层检验：论文多的学者应与 h 指数正相关；论文少的学者应被「收缩」到证据不足区间，而不是被硬排名
big = sample_cards("works_count:>20", 2026)
rho = spearman([c["score"] for c in big], [c["h_index"] for c in big])
check("二 效度", "随机 30 位成熟学者（论文 >20）：与 h 指数正相关（0.4 ≤ ρ ≤ 0.95）", 0.4 <= rho <= 0.95,
      f"Spearman ρ = {rho:.2f}（太低说明没抓住学术影响力；太高说明只是在复制 h 指数）")
small = sample_cards("works_count:>2,works_count:<10", 2026)
in_band = sum(600 <= c["score"] <= 700 for c in small)
check("二 效度", "随机 30 位论文少的学者（3–9 篇）：≥80% 落在 600–700「证据不足」附近", in_band >= 24,
      f"{in_band}/30 落在 600–700（证据少就不下结论）")
check("二 效度", "抽样全部算得出", len(big) + len(small) == 60, f"{len(big) + len(small)}/60")

# ---------------- 三、稳定与单调 ----------------
again = C.checkup_v2(CASES["致远"])
check("三 稳定", "可复算：同一人重算分数不变", again["score"] == cards["致远"]["score"], f"{cards['致远']['score']} / {again['score']}")
base = dict(cards["致远"]); bump = json.loads(json.dumps(base))
bump["adjustments"]["撤稿平衡系数"] = 0.7
lo = spec_score(bump)
bump2 = json.loads(json.dumps(base)); bump2["dimensions"]["学术履约"] = 1.0
hi = spec_score(bump2)
check("三 稳定", "单调：加撤稿 → 分数下降", lo < spec_score(base), f"{spec_score(base)} → {lo}")
check("三 稳定", "单调：履约变好 → 分数上升", hi > spec_score(base), f"{spec_score(base)} → {hi}")

# ---------------- 四、防作弊 ----------------
inv = PM.invariants()
check("四 防作弊", "积分不变量（不为负 / 买不到分 / 刷任务月涨 ≤6 分 / 单调）", all(ok for _, ok in inv), f"{len(inv)} 条全部成立")
rows, minted, burned = PM.simulate(PM.RULES_V12)
spam = PM.spam_share(rows)
cap = PM.baseline_cap(); cap_spam = sum(float(cap[k][:-1]) for k in ("失信者", "灌水者", "小号"))
check("四 防作弊", "12 个月模拟：坏人占审稿注意力低于一刀切", spam < cap_spam, f"本规则 {spam:.0f}% vs 一刀切 {cap_spam:.0f}%")
sybil = next(r for r in rows if r["人群"] == "小号")
check("四 防作弊", "12 个月模拟：零论文小号进不了审稿", sybil["人均投稿进入审稿"] == 0, f"小号人均 {sybil['人均投稿进入审稿']} 篇")
honest = [r for r in rows if r["人群"] in ("新人", "大牛")]
check("四 防作弊", "12 个月模拟：诚实的人不花积分", all(r["人均净花费积分"] == 0 for r in honest), "新人、大牛人均花费 0")

# ---------------- 汇总 ----------------
n_ok = sum(ok for *_, ok, _ in results)
print(f"\n自动验收：{n_ok}/{len(results)} 通过")
json.dump([{"组": g, "项": n, "通过": ok, "说明": d} for g, n, ok, d in results],
          open(os.path.join(HERE, "acceptance_result.json"), "w"), ensure_ascii=False, indent=1)
print("""
五、人工盲评（致远填写，脚本无法替代）
  选 5 位你熟悉的学者（导师、同门、合作者、你自己、一位你认为水平很高的人），
  先【不看分数】凭你的判断给他们排个序，再跑 `python3 aia/product/checkup.py <OpenAlex ID> --v2`，
  比较两个排序：至少 4 位相对顺序一致 → 通过；有明显反直觉的，记下来，作为 v2.2 的改进依据。
""")
sys.exit(0 if n_ok == len(results) else 1)
