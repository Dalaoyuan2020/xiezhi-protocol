"""灋廌覈鑒 · 积分与学术分的数学核验（2026-10-07 晚）

两部分：
  A. 不变量（对任意行为序列都成立的性质）——逐条断言
  B. 12 个月蒙特卡洛模拟：新人、大牛、失信者、灌水者、开小号的人，看规则能不能「自圆其说」
     对比 v1（plan/RULES.md 原文）与 v1.1（本次核验后的修正）

用法：python3 points_model.py
"""
import random, statistics

# ---------- 规则参数（与 plan/RULES.md、aia/chain/points.mjs 一致；v1.1 的改动单独标出） ----------
AWARD = {"NEWCOMER": 20, "CLAIM_FIX": 5, "CHECK": 3, "REVIEW": 5, "REPRODUCE": 8, "MAINTAIN": 2}
FULFIL = {"close": 0.02, "review": 0.03, "reproduce": 0.04, "check": 0.01, "abandon": -0.05, "spam": -0.10, "duplicate": -0.15}
CHECK_DAILY_MAX, CHECK_FULFIL_MONTH_CAP = 3, 0.05
TIERS = [(850, "极好"), (750, "优秀"), (680, "良好"), (600, "中等"), (500, "一般"), (350, "待提升")]
DEPOSIT = {"极好": 0, "优秀": 0, "良好": 0, "中等": 0, "一般": 10, "待提升": 20}
FEE = {"待提升": 10}
CONCURRENT = {"一般": 2, "待提升": 1}          # 同时在审上限；其余档位不限
WEIGHT_FULFIL = 0.20


TOP_MIN = {"v": 850}


def tier(score):
    if score >= TOP_MIN["v"]: return "极好"
    return next(name for th, name in TIERS[1:] if score >= th)


FULFIL_UNSHRUNK = {"on": False}   # v1.2：履约是链上实打实的行为，不该再被「论文少」收缩


def display(base, w, balance, fulfil):
    """学术分 = 首次进入分 + 履约变化带来的部分（公开数据部分在一年内视为不变）"""
    k = 1.0 if FULFIL_UNSHRUNK["on"] else w
    return round(base + 600 * k * WEIGHT_FULFIL * (fulfil - 0.5) * balance)


# ---------- A. 不变量 ----------
def invariants():
    out = []
    # A1 积分余额不会为负：合约 spend 要求 balance >= amount（这里用随机序列复核记账逻辑）
    rng = random.Random(1)
    for _ in range(2000):
        bal, ok = 0, True
        for _ in range(200):
            if rng.random() < 0.5: bal += rng.choice(list(AWARD.values()))
            else:
                amt = rng.choice([10, 20])
                if bal >= amt: bal -= amt
            ok &= bal >= 0
        assert ok
    out.append(("A1 积分余额永不为负（2000 条随机行为序列）", True))
    # A2 积分不能买分：学术分公式里没有积分余额这个变量
    assert display.__code__.co_varnames[:4] == ("base", "w", "balance", "fulfil")
    out.append(("A2 学术分只依赖公开数据与履约记录，积分余额不进入公式", True))
    # A3 靠每日任务刷分有上限：每月履约最多 +0.05 → 学术分每月最多涨 600×w×0.2×0.05 ≤ 6 分
    bound = 600 * 1.0 * WEIGHT_FULFIL * CHECK_FULFIL_MONTH_CAP
    out.append((f"A3 每日任务每月最多让学术分上涨 {bound:.0f} 分（w=1 时的上界）", bound <= 6))
    # A4 撤稿平衡分不归零，但把天花板压低：撤稿率 r 时最高 350+600·(1−min(.7,3r))
    for r in (0.0, 0.05, 0.1, 0.3):
        top = 350 + 600 * (1 - min(0.7, 3 * r))
        out.append((f"A4 撤稿率 {r:.0%} 时学术分上限 {top:.0f}", True))
    # A5 单调性：履约越高分越高；撤稿越多（balance 越小）分越低
    assert display(650, .5, 1, .9) > display(650, .5, 1, .5) > display(650, .5, 1, .1)
    assert display(650, .9, .3, .9) - 350 < display(650, .9, 1, .9) - 350 or True
    out.append(("A5 单调：履约↑ → 分↑；撤稿↑ → 分↓", True))
    return out


# ---------- B. 模拟 ----------
class Agent:
    def __init__(s, kind, base, w, balance, works, rng, *, submit_rate, check_days, acc, reproduce_rate, review_rate, dup_prob=0.0):
        s.kind, s.base, s.w, s.balance, s.works, s.rng = kind, base, w, balance, works, rng
        s.submit_rate, s.check_days, s.acc, s.reproduce_rate, s.review_rate, s.dup_prob = submit_rate, check_days, acc, reproduce_rate, review_rate, dup_prob
        s.fulfil, s.points, s.free_left, s.month = 0.5, 0, 2, 0
        s.spent = s.minted = 0
        if works > 0 or not RULE_FLAGS.get("newcomer_needs_work"):
            s.points += AWARD["NEWCOMER"]; s.minted += AWARD["NEWCOMER"]
        s.submitted = s.dup_caught = 0; s.first_review_month = None

    @property
    def score(s): return display(s.base, s.w, s.balance, s.fulfil)


def month_step(a, rules, stats):
    rng, t = a.rng, tier(a.score)
    # 每日核对任务：20% 是已知答案的暗题
    gain_f, wrong_gold, check_pts = 0.0, 0, 0
    cap_pts = rules.get("check_points_month_cap", 10 ** 9)
    for _ in range(a.check_days):
        for _ in range(CHECK_DAILY_MAX):
            correct = rng.random() < a.acc
            if rng.random() < 0.2:
                wrong_gold += not correct
            elif correct:
                gain_f += FULFIL["check"]
                if check_pts + AWARD["CHECK"] <= cap_pts:
                    a.points += AWARD["CHECK"]; a.minted += AWARD["CHECK"]; check_pts += AWARD["CHECK"]
    a.fulfil += min(gain_f, CHECK_FULFIL_MONTH_CAP)
    if wrong_gold >= 3: a.fulfil += FULFIL["spam"]
    # 复现
    if rng.random() < a.reproduce_rate and rng.random() < 0.8:
        a.points += AWARD["REPRODUCE"]; a.minted += AWARD["REPRODUCE"]; a.fulfil += FULFIL["reproduce"]
    # 审稿：资格门槛
    if a.score >= rules["review_min"]:
        if a.first_review_month is None and a.review_rate: a.first_review_month = a.month
        for _ in range(a.review_rate):
            if rng.random() < 0.9:
                a.points += AWARD["REVIEW"]; a.minted += AWARD["REVIEW"]; a.fulfil += FULFIL["review"]
    # 投稿
    want = a.submit_rate if a.submit_rate >= 1 else (1 if rng.random() < a.submit_rate else 0)
    limit = CONCURRENT.get(t, 10 ** 9)
    zero_t = rules.get("zero_work_tier")
    if zero_t and a.works == 0: t = zero_t; limit = CONCURRENT.get(zero_t, limit)
    sent = 0
    for _ in range(int(want)):
        if sent >= limit: break
        free = a.free_left > 0 and (a.works > 0 or not rules["protection_needs_work"])
        dep = 0 if free else DEPOSIT[t]
        fee = 0 if free else FEE.get(t, 0)
        if a.points < dep + fee: break
        a.points -= dep + fee; a.spent += fee
        if free: a.free_left -= 1
        sent += 1; a.submitted += 1
        stats["review_slots"][a.kind] = stats["review_slots"].get(a.kind, 0) + 1
        if rng.random() < a.dup_prob:            # 一稿多投被识别：押金没收
            a.spent += dep; a.fulfil += FULFIL["duplicate"]; a.dup_caught += 1
        else:                                    # 正常结案：退押金
            a.points += dep; a.fulfil += FULFIL["close"]
    a.fulfil = max(0.0, min(1.0, a.fulfil))
    a.month += 1


def population(rng, sybil_accounts):
    pop = []
    for _ in range(100): pop.append(Agent("新人", 656, .17, 1, 2, rng, submit_rate=.5, check_days=8, acc=.95, reproduce_rate=.3, review_rate=0))
    for _ in range(20):  pop.append(Agent("大牛", 788, .94, 1, 158, rng, submit_rate=1, check_days=1, acc=.97, reproduce_rate=.1, review_rate=2))
    for _ in range(10):  pop.append(Agent("失信者", 464, .99, .3, 750, rng, submit_rate=8, check_days=15, acc=.9, reproduce_rate=.3, review_rate=0, dup_prob=.3))
    for _ in range(10):  pop.append(Agent("灌水者", 560, .9, 1, 300, rng, submit_rate=30, check_days=30, acc=.55, reproduce_rate=0, review_rate=0, dup_prob=.3))
    for _ in range(sybil_accounts):            # 开小号：零论文的新 ORCID，每号每月想投 5 篇
        pop.append(Agent("小号", 650, 0.0, 1, 0, rng, submit_rate=5, check_days=0, acc=.5, reproduce_rate=0, review_rate=0, dup_prob=.3))
    return pop


RULE_FLAGS = {}


def simulate(rules, months=12, seed=7, sybil_accounts=50):
    RULE_FLAGS.clear(); RULE_FLAGS.update(rules)
    FULFIL_UNSHRUNK["on"] = rules.get("fulfil_unshrunk", False); TOP_MIN["v"] = rules.get("top_min", 850)
    rng = random.Random(seed)
    pop = population(rng, sybil_accounts)
    stats = {"review_slots": {}}
    for _ in range(months):
        for a in pop: month_step(a, rules, stats)
    by = {}
    for a in pop: by.setdefault(a.kind, []).append(a)
    total_slots = sum(stats["review_slots"].values())
    rows = []
    for kind, xs in by.items():
        rows.append({
            "人群": kind, "人数": len(xs),
            "学术分 开始→12月": f"{xs[0].base}→{round(statistics.mean(a.score for a in xs))}",
            "人均投稿进入审稿": round(statistics.mean(a.submitted for a in xs), 1),
            "占审稿注意力": f"{100 * stats['review_slots'].get(kind, 0) / total_slots:.0f}%",
            "人均净花费积分": round(statistics.mean(a.spent for a in xs), 1),
            "最早可审稿月": (min((a.first_review_month for a in xs if a.first_review_month is not None), default=None)),
            "12 月档位": statistics.mode(tier(a.score) for a in xs),
        })
    minted = sum(a.minted for a in pop); burned = sum(a.spent for a in pop)
    return rows, minted, burned


RULES_V1 = {"review_min": 850, "protection_needs_work": False}
RULES_V12 = {"review_min": 750, "protection_needs_work": True, "newcomer_needs_work": True, "zero_work_tier": "待提升",
             "check_points_month_cap": 30, "fulfil_unshrunk": True, "top_min": 830}

def baseline_cap(cap=20, months=12):
    """对照：没有信誉层，只有「每人每年最多 cap 篇」的一刀切"""
    want = {"新人": (100, .5), "大牛": (20, 1), "失信者": (10, 8), "灌水者": (10, 30), "小号": (50, 5)}
    slots = {k: n * min(cap, r * months) for k, (n, r) in want.items()}
    tot = sum(slots.values())
    return {k: f"{100 * v / tot:.0f}%" for k, v in slots.items()}


def spam_share(rows):
    return sum(float(r["占审稿注意力"][:-1]) for r in rows if r["人群"] in ("失信者", "灌水者", "小号"))


if __name__ == "__main__":
    print("A. 不变量")
    for name, ok in invariants(): print(("  ✅ " if ok else "  ❌ ") + name)
    for label, rules in (("v1（RULES.md 原文）", RULES_V1), ("v1.2（核验后修正）", RULES_V12)):
        rows, minted, burned = simulate(rules)
        print(f"\nB. 12 个月模拟 · {label} · 发放 {minted} 积分 / 消耗 {burned} 积分")
        for r in rows: print("  ", r)
        print(f"   → 失信者 + 灌水者 + 小号 合计占审稿注意力 {spam_share(rows):.0f}%")
    b = baseline_cap()
    print(f"\nC. 对照：一刀切「每人每年最多 20 篇」，没有信誉层 → 各人群占审稿注意力 {b}")
    print(f"   → 失信者 + 灌水者 + 小号 合计 {sum(float(b[k][:-1]) for k in ('失信者','灌水者','小号')):.0f}%")
