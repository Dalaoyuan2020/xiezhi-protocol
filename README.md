# 灋廌覈鑒 · 獬豸协议 · Xiezhi Protocol

**学术信誉链 + 知行社 · AIA Commons。** 獬豸协议以学术信誉链为底层，在知行社中实现 AIA（注意力 · 想法 · 行动），用**廌点**记录每一份可验证的贡献。
*An academic reputation chain on BOT Chain, with a community (AIA Commons) where verified contributions are recorded as non-transferable Zhi Points.*

> 獬豸是中国神话里专辨是非的独角神兽，「法」的古字「灋」里就有它。

| 先看这些 | |
|---|---|
| 📄 白皮书 | [《AIA 社区白皮书》PDF](whitepaper/AIA_COMMUNITY_WHITEPAPER.pdf) |
| 🎬 视频 1 · 核心协议（85 秒） | [media/xiezhi-video1-core-protocol-v2-85s.mp4](media/xiezhi-video1-core-protocol-v2-85s.mp4) |
| 🎬 视频 2 · AIA 社区（2 分 18 秒） | [media/xiezhi-video2-community-vision-v3-138s.mp4](media/xiezhi-video2-community-vision-v3-138s.mp4) |
| 🌐 在线体验 | **https://aia.hai.college/** |
| 📋 提交材料 | [SUBMISSION.md](SUBMISSION.md) |
| ⛓ BOT Chain 主网 | ActionRegistry [`0xA085…10eD`](https://scan.botchain.ai/address/0xA0853161002Af018225419324560FCE9CD9b10eD) · PointsLedger [`0x28B2…D60A`](https://scan.botchain.ai/address/0x28B2af15386C0D65D5427d5b81bEe485D4edD60A) |

**运行**：`npm ci && npm start`（http://127.0.0.1:8890/ui/ 搜索首页 · /workspace/ 知行社）；`./start-demo.sh`（本地模拟链 + 认领盖章页 http://127.0.0.1:8892/live/）。Node ≥ 24.13，Python 3。可运行代码在 `aia/`、`xiezhi-ui/`；下方 `ui/`、`chain/`、`product/` 为比赛第一天的静态版本，保留作记录。

## 早期静态版本（10-06）

## 现在能看什么

- **演示页面**：[首页搜索](ui/index.html)（输入 ORCID / 中文名 / 拼音，重名先选人）· [学术体检](ui/checkup.html)（个人档案、可核查度评分、认领与提分任务）· [机构查询台](ui/org.html)（行为时间线、一稿多投提示）
- **评分脚本**：[product/checkup.py](product/checkup.py)，只用 OpenAlex 公开数据，五维各 20 分；[案例](product/cases_2026-10-07.md)
- **合约**：[chain/contracts/ActionRegistry.sol](chain/contracts/ActionRegistry.sol)，记录 `SCORE / SUBMIT / CLOSE / REVIEW / REPRODUCE / CLAIM` 六种行为

## BOT Chain 测试网部署（Chain ID 968）

- 合约：[`0xA0853161002Af018225419324560FCE9CD9b10eD`](https://scan.bohr.life/address/0xA0853161002Af018225419324560FCE9CD9b10eD)
- 部署交易：[`0x43b4…87e8`](https://scan.bohr.life/tx/0x43b428548ca34a23da0e5bc73fd3837a7dfadae74f7e2728068d6a9f8a1187e8)
- 演示记录：3 笔评分（[致远 70](https://scan.bohr.life/tx/0xe88454487ee6e72b4e82de0c710808f8668c273db5503b1ee94c49f42573dd13)、[Karpathy 78](https://scan.bohr.life/tx/0x1d6119ca5aecbdff1aeeb4b53508010797b92fceb9980273b5fa066885551ed9)、[何恺明 83](https://scan.bohr.life/tx/0xed028b7995b27baca333f5222f965109a0331d032203f0d140f1a7733b469ed7)），两家演示期刊登记同一份演示稿件（[期刊甲](https://scan.bohr.life/tx/0x532137f7133159bde7d52f2ba16c81d14a3cc7e7a9fdd03ec854cffe81b6f29e)、[期刊乙](https://scan.bohr.life/tx/0x834a3f00b753e03f9d679cd8250eb0f0d892590a8a0f30c15131e55195e925f6)）

## BOT Chain 主网部署（Chain ID 677）✅

- 学术行为登记 ActionRegistry：[`0xA0853161002Af018225419324560FCE9CD9b10eD`](https://scan.botchain.ai/address/0xA0853161002Af018225419324560FCE9CD9b10eD)
- 贡献积分 PointsLedger（不可转让，不是虚拟货币）：[`0x28B2af15386C0D65D5427d5b81bEe485D4edD60A`](https://scan.botchain.ai/address/0x28B2af15386C0D65D5427d5b81bEe485D4edD60A)
- 全部主网交易记录：[chain/MAINNET.md](chain/MAINNET.md)

## 本地运行

```sh
python3 -m http.server 8878          # 在仓库根目录，打开 http://127.0.0.1:8878/ui/index.html
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

**Know & Act（知行合一）** 队 · 汉客松 S1 · ETH Wuhan 2026 参赛作品。GCC 公共物品赛道 · BOT Chain 赛道。
