"""AIA 白皮书配图（SVG）。用法：python3 whitepaper/figures/make_figures.py
数据图的数字来自 aia/product/points_model.py 实跑（RULES_V12，seed=7），结果另存 sim.json。"""
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
INK, RED, GOLD, GREY, LINE, BG, OK = "#2a2622", "#b8292f", "#b08a4a", "#6b645d", "#ddd6ca", "#f7f4ef", "#2f7d5b"
FONT = "PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
COIN = "data:image/png;base64," + base64.b64encode(open(os.path.join(ROOT, "brand/zhidian-coin-256.png"), "rb").read()).decode()
SEAL = "data:image/png;base64," + base64.b64encode(open(os.path.join(ROOT, "brand/seal.png"), "rb").read()).decode()


def svg(w, h, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="{FONT}">'
            f'<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{GREY}"/></marker>'
            f'<marker id="arrR" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{RED}"/></marker></defs>'
            f'<rect width="{w}" height="{h}" fill="#fff"/>{body}</svg>')


def t(x, y, s, size=14, fill=INK, w="400", anchor="middle"):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{w}" text-anchor="{anchor}" dominant-baseline="middle">{s}</text>'


def box(x, y, w, h, fill="#fff", stroke=LINE, r=10, sw=1.5):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'


def arrow(x1, y1, x2, y2, color=GREY, label=None, lx=None, ly=None, red=False):
    m = "arrR" if red else "arr"
    s = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{RED if red else color}" stroke-width="1.8" marker-end="url(#{m})"/>'
    if label: s += t(lx if lx is not None else (x1 + x2) / 2, ly if ly is not None else (y1 + y2) / 2 - 10, label, 12, GREY)
    return s


def save(name, content):
    open(os.path.join(HERE, name), "w", encoding="utf-8").write(content)
    print("saved", name)


# 图 1 · 产品架构：底层学术信誉链 → 知行社 → 廌点流转
def fig_architecture():
    W, H = 900, 520; b = ""
    # 顶层：廌点
    b += box(60, 30, 780, 110, BG, GOLD, 14)
    b += f'<image href="{COIN}" x="90" y="45" width="80" height="80"/>'
    b += t(200, 62, "廌点 · 在社区里流转的记账单位", 18, INK, "700", "start")
    b += t(200, 92, "做了可验证的事就发：核对 +3 · 认领纠错 +5 · 审稿 +5 · 复现 +8", 13, GREY, "400", "start")
    b += t(200, 116, "用于：投稿押金 · 低档投稿费 · 兑换社区激励　|　不能转让 · 不能兑现 · 不能买卖", 13, RED, "400", "start")
    # 中层：知行社
    b += box(60, 170, 780, 150, "#fff", INK, 14, 1.8)
    b += t(450, 194, "知行社 · AIA Commons（社区）", 17, INK, "700")
    for i, (name, sub, kind) in enumerate([("Idea 想法区", "交论文 · 双模型评审", "SUBMIT / CLOSE"), ("Attention 注意力区", "学术分 ≥ 750 审稿", "REVIEW"), ("Act 行动区", "核对 · 复现 · 运维", "REPRODUCE / CLAIM")]):
        x = 85 + i * 252
        b += box(x, 215, 225, 88, BG, LINE, 10)
        b += t(x + 112, 240, name, 15, RED if i == 1 else INK, "700")
        b += t(x + 112, 264, sub, 12.5, GREY)
        b += t(x + 112, 286, kind, 11.5, GOLD, "600")
    # 底层：学术信誉链
    b += box(60, 350, 780, 140, "#fff", RED, 14, 2.2)
    b += f'<image href="{SEAL}" x="85" y="372" width="96" height="96"/>'
    b += t(205, 382, "灋廌覈鑒 · 学术信誉链（底层）", 17, RED, "700", "start")
    b += t(205, 412, "每位学者一条个人链：身份 · 论文归属 · 灋廌学术分 · 认领凭证 · 学术行为记录", 13, INK, "400", "start")
    b += t(205, 438, "Agent 交叉验证（OpenAlex × ORCID × Crossref）· 规则公开可复算", 13, GREY, "400", "start")
    b += t(205, 464, "BOT Chain 主网：ActionRegistry（行为登记）· PointsLedger（廌点账本）", 13, GREY, "400", "start")
    b += arrow(450, 350, 450, 322, label="身份与信誉", lx=520, ly=336)
    b += arrow(450, 170, 450, 142, label="验收通过 → 发廌点", lx=540, ly=156)
    return svg(W, H, b)


# 图 2 · AIA 循环
def fig_aia_loop():
    W, H = 760, 420; b = ""
    nodes = {"Idea": (380, 70, "Idea · 想法", "投稿、研究主张", "记录想法"), "Attention": (620, 300, "Attention · 注意力", "审稿人的时间与判断", "保护注意力"),
             "Act": (140, 300, "Act · 行动", "复现、核对、运维", "保护行动")}
    for k, (x, y, name, sub, goal) in nodes.items():
        b += box(x - 115, y - 46, 230, 92, BG if k != "Attention" else "#fbeeee", RED if k == "Attention" else INK, 14, 1.8)
        b += t(x, y - 18, name, 16, INK, "700"); b += t(x, y + 6, sub, 12.5, GREY); b += t(x, y + 28, goal, 12.5, RED, "600")
    b += f'<image href="{COIN}" x="335" y="205" width="90" height="90"/>' + t(380, 310, "廌点", 14, GOLD, "700")
    b += arrow(470, 110, 580, 250, label="消耗：只给过了门槛的稿子", lx=600, ly=165)
    b += arrow(505, 320, 255, 320, label="审稿被采纳 → 廌点 + 履约", lx=380, ly=345)
    b += arrow(165, 250, 300, 112, label="做任务修复信誉 → 降低投稿门槛", lx=150, ly=165)
    return svg(W, H, b)


# 图 3 · Agent 核验七步
def fig_agent_flow():
    W, H = 900, 300; b = ""
    steps = [("1", "理解输入", "姓名 / 拼音 / ORCID"), ("2", "定位学者", "同名候选供选择"), ("3", "核对身份", "ORCID 官方雇主"), ("4", "拉取论文", "OpenAlex"),
             ("5", "交叉验证", "错挂 / 档案拆分"), ("6", "计算学术分", "公开规则 v2.1"), ("7", "本人认领", "盖章上链")]
    for i, (n, name, sub) in enumerate(steps):
        x = 22 + i * 124; hi = n in ("5", "7")
        b += box(x, 70, 112, 96, "#fbeeee" if hi else BG, RED if hi else LINE, 10, 1.6)
        b += f'<circle cx="{x + 56}" cy="70" r="15" fill="{RED if hi else INK}"/>' + t(x + 56, 71, n, 13, "#fff", "700")
        b += t(x + 56, 108, name, 14.5, INK, "700"); b += t(x + 56, 136, sub, 11.5, GREY)
        if i < 6: b += arrow(x + 113, 118, x + 123, 118)
    for j, src in enumerate(["OpenAlex", "ORCID", "Crossref"]):
        x = 420 + (j - 1) * 105
        b += box(x - 45, 220, 90, 34, "#fff", GOLD, 17, 1.4) + t(x, 237, src, 12.5, GOLD, "600")
        b += arrow(x, 220, 554 - 26 + (j - 1) * 20, 168)
    b += t(450, 280, "三方证据：同单位署名 · ORCID 是否冲突 · 本人 ORCID / Crossref 是否登记 → 判定 + 置信度（高 / 中）", 12.5, GREY)
    return svg(W, H, b)


# 图 4 · 本人认领与复核
def fig_claim():
    W, H = 900, 300; b = ""
    items = [("① 逐篇确认", "是我的 / 不是我的 / 不确定", "默认「不确定」"), ("② 邮箱验证", "6 位码 · 10 分钟 · 5 次", "单位邮箱核对（演示模式）"),
             ("③ 认领凭证", "档案 · 论文 · 学术分 · 时间", "邮箱只存哈希"), ("④ 写入链上", "CLAIM 凭证指纹 + SCORE", "红章 / 灰章「待复核」")]
    for i, (a, s1, s2) in enumerate(items):
        x = 25 + i * 218
        b += box(x, 40, 196, 110, BG if i < 3 else "#fbeeee", RED if i == 3 else LINE, 12, 1.6)
        b += t(x + 98, 72, a, 16, RED if i == 3 else INK, "700"); b += t(x + 98, 102, s1, 12, INK); b += t(x + 98, 126, s2, 11.5, GREY)
        if i < 3: b += arrow(x + 197, 95, x + 216, 95)
    b += box(250, 200, 400, 70, "#fff", OK, 12, 1.8)
    b += t(450, 224, "复核：任何人提交凭证原文 → 重算指纹 → 与链上 CLAIM 比对", 13, INK, "600")
    b += t(450, 250, "一致 ✓　|　凭证任一字段被改 → 不一致 ✗", 13, OK, "600")
    b += arrow(775, 152, 655, 222, color=OK)
    return svg(W, H, b)


# 图 5 · 学术分：五个维度权重 + 档位阶梯
def fig_score():
    W, H = 900, 330; b = ""
    dims = [("学术身份", 20, "ORCID · 雇主一致 · 领域一致"), ("学术履历", 30, "领域归一化引用 · 成果积累"), ("学术习惯", 20, "开放获取 · 产出节奏"),
            ("学术履约", 20, "链上行为（不收缩）"), ("合作网络", 10, "规划中，记中性")]
    b += t(30, 30, "五个维度（权重）", 15, INK, "700", "start")
    for i, (n, wt, sub) in enumerate(dims):
        y = 58 + i * 50
        b += t(30, y + 12, n, 13.5, INK, "600", "start")
        b += f'<rect x="110" y="{y}" width="300" height="24" rx="5" fill="{BG}"/><rect x="110" y="{y}" width="{wt * 10}" height="24" rx="5" fill="{RED if n == "学术履约" else GOLD}"/>'
        b += t(110 + wt * 10 + 8, y + 12, f"{wt}%", 13, INK, "700", "start")
        b += t(110, y + 38, sub, 11, GREY, "400", "start")
    tiers = [("极好", 830, 950, "审稿专家"), ("优秀", 750, 829, "可接审稿"), ("良好", 680, 749, "投稿免费"), ("中等 · 证据不足", 600, 679, "新人默认"),
             ("一般", 500, 599, "押 10 廌点"), ("待提升", 350, 499, "押 20 + 交 10")]
    b += t(500, 30, "档位（350–950）", 15, INK, "700", "start")
    for i, (n, lo, hi, right) in enumerate(tiers):
        y = 52 + i * 42; shade = ["#7d1a1f", RED, "#c9555a", "#d9a441", "#bcae9a", "#9b8f84"][i]
        b += f'<rect x="500" y="{y}" width="170" height="34" rx="6" fill="{shade}"/>' + t(585, y + 17, n, 13, "#fff", "700")
        b += t(684, y + 17, f"{lo}–{hi}", 13, INK, "600", "start") + t(770, y + 17, right, 12.5, GREY, "400", "start")
    b += t(450, 318, "学术分 = 350 + 6 × round(100 × 综合 × 撤稿平衡)；论文少向中性收缩 w = n/(n+10)；廌点余额不进公式", 12, GREY)
    return svg(W, H, b)


# 图 6 · 审稿注意力被谁占用（机制模拟）
def fig_attention(share):
    W, H = 760, 300; b = ""
    bars = [("一刀切：每人每年 20 篇", share["cap"], "#9b8f84"), ("本协议第一版 v1", share["v1"], "#c9a77a"), ("现行规则 v1.2", share["v12"], RED)]
    b += t(380, 26, "失信者 + 灌水者 + 零论文小号 占用的审稿注意力（12 个月机制模拟）", 14, INK, "700")
    for i, (n, v, c) in enumerate(bars):
        y = 60 + i * 66
        b += t(230, y + 20, n, 13.5, INK, "600", "end")
        b += f'<rect x="245" y="{y}" width="420" height="40" rx="6" fill="{BG}"/><rect x="245" y="{y}" width="{4.2 * v}" height="40" rx="6" fill="{c}"/>'
        b += t(245 + 4.2 * v + 10, y + 20, f"{v:.0f}%", 16, INK, "700", "start")
    b += t(380, 272, "越低越好。数据：aia/product/points_model.py（seed = 7）；为假设人群下的机制模拟，不是真实运营数据", 11.5, GREY)
    return svg(W, H, b)


# 图 7 · 五类人群 12 个月学术分轨迹（机制模拟）
def fig_trajectory(traj):
    W, H = 860, 380; b = ""
    x0, y0, w, h = 70, 40, 500, 280; lo, hi = 440, 880
    X = lambda m: x0 + w * m / 12; Y = lambda v: y0 + h * (1 - (v - lo) / (hi - lo))
    for v in (450, 500, 600, 680, 750, 830, 880):
        dash = ' stroke-dasharray="4 4"' if v in (680, 750, 830) else ""
        b += f'<line x1="{x0}" y1="{Y(v)}" x2="{x0 + w}" y2="{Y(v)}" stroke="{LINE}"{dash}/>' + t(x0 - 8, Y(v), str(v), 11, GREY, "400", "end")
    for m in range(0, 13, 3): b += t(X(m), y0 + h + 18, f"{m} 月", 11, GREY)
    b += t(x0 + w + 6, Y(830) - 8, "极好 830", 10.5, RED, "400", "start") + t(x0 + w + 6, Y(750) - 8, "优秀 750（可审稿）", 10.5, RED, "400", "start") + t(x0 + w + 6, Y(680) - 8, "良好 680", 10.5, GREY, "400", "start")
    colors = {"大牛": RED, "新人": OK, "小号": "#9b8f84", "灌水者": GOLD, "失信者": "#5b4b8a"}
    names = {"大牛": "资深学者 788→848", "新人": "新人 656→716", "小号": "零论文小号 650", "灌水者": "灌水者 560→500", "失信者": "大量撤稿者 464→470"}
    for k, ys in traj.items():
        pts = " ".join(f"{X(m):.1f},{Y(v):.1f}" for m, v in enumerate(ys))
        b += f'<polyline points="{pts}" fill="none" stroke="{colors[k]}" stroke-width="2.6"/>'
    for i, k in enumerate(["大牛", "新人", "小号", "灌水者", "失信者"]):
        y = 60 + i * 26
        b += f'<rect x="{x0 + w + 140}" y="{y + 130}" width="16" height="4" fill="{colors[k]}"/>' + t(x0 + w + 162, y + 132, names[k], 11.5, INK, "400", "start")
    b += t(430, 368, "学术分随行为变化（12 个月机制模拟，RULES v1.2）：诚实的人分数上升，灌水者下降，小号原地不动", 11.5, GREY)
    return svg(W, H, b)


# 图 8 · 链上 / 链下边界
def fig_boundary():
    W, H = 900, 300; b = ""
    b += box(20, 30, 390, 240, "#fbeeee", RED, 14, 2) + t(215, 58, "链上（BOT Chain，公开、不可删）", 15, RED, "700")
    for i, s in enumerate(["学者标识：keccak256(\"openalex:作者编号\")", "评分：数值 + 快照指纹 + 规则版本", "认领凭证指纹（CLAIM）", "稿件指纹（SUBMIT）· 结案（CLOSE）", "廌点流水：原因编号 + 证据指纹"]):
        b += t(42, 95 + i * 34, "· " + s, 12.5, INK, "400", "start")
    b += box(490, 30, 390, 240, BG, LINE, 14, 2) + t(685, 58, "链下（不上链）", 15, INK, "700")
    for i, s in enumerate(["姓名、单位、论文元数据（公开数据源）", "认领凭证原文、稿件原文", "邮箱：只在凭证里存哈希", "研究材料：服务端权限保护", "任何人可拿原文重算指纹核对"]):
        b += t(512, 95 + i * 34, "· " + s, 12.5, INK if i < 4 else OK, "400" if i < 4 else "600", "start")
    b += arrow(488, 231, 412, 231, color=OK) + t(450, 212, "重算", 12, OK, "600") + t(450, 252, "核对", 12, OK, "600")
    return svg(W, H, b)


# 图 9 · 廌点怎么来、怎么去
def fig_points():
    W, H = 900, 330; b = ""
    earn = [("新手保护（首次上链）", "+20"), ("认领纠正错挂", "+5"), ("核对题（每月 ≤ 30）", "+3"), ("审稿被采纳", "+5"), ("复现一个主张", "+8"), ("运维纠错", "+2")]
    use = [("投稿押金（规范结案退回）", "10 / 20"), ("低档投稿费", "−10"), ("兑换社区激励（机构出资）", "规划中")]
    b += t(150, 26, "只有一条来路：可验证的行动", 14, OK, "700")
    for i, (n, v) in enumerate(earn):
        y = 44 + i * 42
        b += box(20, y, 260, 34, "#fff", LINE, 8) + t(34, y + 17, n, 12.5, INK, "400", "start") + t(268, y + 17, v, 13, OK, "700", "end")
        b += arrow(281, y + 17, 372, 165)
    b += f'<image href="{COIN}" x="380" y="105" width="120" height="120"/>' + t(440, 240, "廌点余额（链上）", 13.5, INK, "700")
    b += t(440, 262, "不进学术分公式", 12, GREY)
    b += t(735, 26, "去处", 14, INK, "700")
    for i, (n, v) in enumerate(use):
        y = 70 + i * 56
        b += box(590, y, 290, 40, "#fff", LINE, 8) + t(604, y + 20, n, 12.5, INK, "400", "start") + t(868, y + 20, v, 13, RED if v.startswith("−") else INK, "700", "end")
        b += arrow(502, 165, 588, y + 20)
    b += box(590, 250, 290, 48, "#fff", RED, 8, 1.8)
    b += t(735, 266, "✗ 转账　✗ 买卖　✗ 兑现", 13.5, RED, "700") + t(735, 286, "合约里没有 transfer / approve", 11.5, GREY)
    return svg(W, H, b)


if __name__ == "__main__":
    sim = json.load(open(os.path.join(HERE, "sim.json"), encoding="utf-8"))
    save("fig1_architecture.svg", fig_architecture())
    save("fig2_aia_loop.svg", fig_aia_loop())
    save("fig3_agent_flow.svg", fig_agent_flow())
    save("fig4_claim.svg", fig_claim())
    save("fig5_score.svg", fig_score())
    save("fig6_attention.svg", fig_attention(sim["share"]))
    save("fig7_trajectory.svg", fig_trajectory(sim["traj"]))
    save("fig8_boundary.svg", fig_boundary())
    save("fig9_points.svg", fig_points())
