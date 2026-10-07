# 獬豸协议 · Xiezhi Protocol

**学术信誉层：一个行为上链，一个评分。**
*An academic reputation layer on BOT Chain: one action on-chain, one score.*

> 獬豸是中国神话里专辨是非的判官神兽，「法」字的古写里就有它。

## 为什么

ORCID 给了学者一张名片，但名片不说明你靠不靠谱。AI 让论文产量暴涨：ICLR 2026 有效投稿 19,525 篇，ICLR 2027 截止前登记摘要超过 6 万篇；ICLR 2026 有 101 人各投 20 篇以上。大会和 arXiv 只能一刀切限篇数，但篇数可以分摊给别人挂名，**信誉分摊不了**。

獬豸协议围绕科研里最稀缺的三样东西（AIA）记账：

| | 痛点 | 链上记什么 |
|---|---|---|
| **Attention 注意力** | 水文和一稿多投消耗审稿人注意力 | 期刊登记「投稿」与「结案」→ 同一稿件两家同时在审即提示疑似一稿多投 |
| **Idea 想法** | 论文归属被数据库搞错 | 公开档案的评分快照指纹 + 本人认领 |
| **Act 行动** | 复现、核对、审稿做了没人记账 | 复现、审稿与核对记录 |

链上**只存指纹和分数**，不存论文、稿件或个人信息。规则公开，任何人都能复算；任何期刊、任何应用都能接入。不发币。

## 现在能看什么

- **演示页面**：[学术体检](ui/checkup.html)（个人档案、可核查度评分、认领与提分任务）· [机构查询台](ui/org.html)（行为时间线、一稿多投提示）
- **评分脚本**：[product/checkup.py](product/checkup.py)，只用 OpenAlex 公开数据，五维各 20 分；[案例](product/cases_2026-10-07.md)
- **合约**：[chain/contracts/ActionRegistry.sol](chain/contracts/ActionRegistry.sol)，记录 `SCORE / SUBMIT / CLOSE / REVIEW / REPRODUCE / CLAIM` 六种行为

## BOT Chain 测试网部署（Chain ID 968）

- 合约：[`0xA0853161002Af018225419324560FCE9CD9b10eD`](https://scan.bohr.life/address/0xA0853161002Af018225419324560FCE9CD9b10eD)
- 部署交易：[`0x43b4…87e8`](https://scan.bohr.life/tx/0x43b428548ca34a23da0e5bc73fd3837a7dfadae74f7e2728068d6a9f8a1187e8)
- 演示记录：3 笔评分（[致远 70](https://scan.bohr.life/tx/0xe88454487ee6e72b4e82de0c710808f8668c273db5503b1ee94c49f42573dd13)、[Karpathy 78](https://scan.bohr.life/tx/0x1d6119ca5aecbdff1aeeb4b53508010797b92fceb9980273b5fa066885551ed9)、[何恺明 83](https://scan.bohr.life/tx/0xed028b7995b27baca333f5222f965109a0331d032203f0d140f1a7733b469ed7)），两家演示期刊登记同一份演示稿件（[期刊甲](https://scan.bohr.life/tx/0x532137f7133159bde7d52f2ba16c81d14a3cc7e7a9fdd03ec854cffe81b6f29e)、[期刊乙](https://scan.bohr.life/tx/0x834a3f00b753e03f9d679cd8250eb0f0d892590a8a0f30c15131e55195e925f6)）

主网（Chain ID 677）部署待 Gas 发放后进行。

## 本地运行

```sh
python3 -m http.server 8878          # 在仓库根目录，打开 http://127.0.0.1:8878/ui/checkup.html
cd chain && npm install && npm run check && npm run test-demo   # 合约本地自检与演示流程
NETWORK=testnet npm run read -- A5126602136                     # 读测试网上的真实记录
```

## 诚实说明

- 评分规则是 v0 启发式规则，衡量「公开记录能支撑多少信任」，**不是人品分**，也不判定研究真伪
- 案例数据是 2026-10-07 的 OpenAlex 快照；演示期刊与演示稿件均为虚构
- 稿件指纹目前是精确哈希，改动文字即可绕过；相似指纹在路线图中

## 提交材料

见 [SUBMISSION.md](SUBMISSION.md)（按赛事 5.2 交付物要求整理）。

## 团队

汉客松 S1 · ETH Wuhan 2026 参赛作品。GCC 公共物品赛道 · BOT Chain 赛道。
