# 提交材料 · 灋廌覈鑒 · 獬豸协议（汉客松 S1 · ETH Wuhan 2026）

> 按赛事手册 5.2 交付物要求整理。名称规范：协议全名 **灋廌覈鑒**（读作「法廌核鉴」，Xiezhi）· 简称 **獬豸协议** · 底层 **学术信誉链** · 社区 **知行社 · AIA Commons** · 记账单位 **廌点**（不可转让、不可买卖，不是虚拟货币）。

## 1. 项目介绍

| 项 | 内容 |
|---|---|
| 队名与成员 | **Know & Act（知行合一）**：吕志远（队长，产品与链上设计）、林夏槿、郭志伟、孙梓雯 |
| 项目名称 | 灋廌覈鑒 · 獬豸协议（Xiezhi Protocol）· 学术信誉链 + 知行社 · AIA Commons |
| 一句话 | 獬豸协议以学术信誉链为底层，在知行社中实现 AIA（注意力 · 想法 · 行动），用廌点记录每一份可验证的贡献 |
| 目标用户 | **学者**（免费查自己、认领论文、留下可核对的记录、通过行动修复信誉）；**期刊与会议**（收稿登记、一稿多投提示、按作者读链）；**高校与基金**（批量核验，规划中） |
| 解决的问题 | AI 让论文数量暴涨（ICLR 2025 → 2026 → 2027 摘要取号：11,672 → 19,814 → 62,288），审稿注意力被耗尽；大会只能一刀切限篇数，篇数可以靠互相挂名分摊，信誉分摊不了；公开学术库里论文还经常挂错人 |
| 赛道 | GCC 公共物品赛道 · 赛题一（Agent 公共信誉与服务验收）；BOT Chain 分赛道 |

### 核心功能（已实现，可演示）

1. **学术信誉链 · 本人认领**：输入姓名 / 拼音 / ORCID → Agent 实时检索同名学者 → OpenAlex × ORCID × Crossref 三方交叉验证，提示「错挂到他人名下」或「同一人被拆成两个档案」并给出置信度 → 灋廌学术分（350–950，规则公开可复算）→ 逐篇认领 → 邮箱验证码（单位邮箱域名核对；当前为演示模式，验证码显示在页面上）→ 生成认领凭证 → 凭证指纹与评分写入链上、盖红章 → 任何人可复核（篡改任一字段即不一致）
2. **稿件指纹登记与一稿多投提示**：两家期刊登记同一稿件指纹时提示疑似一稿多投；结案登记
3. **知行社 · AIA Commons**：Idea / Attention / Act 三个区；双模型预评审（两个可配置模型逐项一致才给结论，分歧转人工）；审稿门槛（材料可检查度 ≥ 60、模型一致、非高风险）与审稿资格（身份核验 + 学术分 ≥ 750）；首批 10 道来自真实 OpenAlex 快照的核对题，三人作答 + 暗题；文献核对（Crossref 返回 404 才出题）；论文复现三人分离验收；7 天 Agent 授权（不能自验收、不能审稿，记录写明担保人）；廌点账本（社区内链下记账）
4. **廌点**：链上 `PointsLedger` 只有发放与扣减，无转账；认领盖章时金币落下动画；学术分 ≥ 700 的学者有金币雨彩蛋（纯动画，不额外发放）

### 比赛期间完成的工作（10-06 至 10-08，全部为新增）

- 选题研究、AIA 框架与命名；运营规则 v1.2 与 12 个月机制模拟
- 评分规则 v2.1 冻结，17 项自动验收全部通过（`aia/product/acceptance.py`）
- 两个合约部署到 BOT Chain 测试网与主网，主网有真实评分、认领、积分、稿件登记交易
- Agent 实时检索 + 三方交叉验证；本人认领三步 + 认领凭证 + 本地模拟链 / 主网盖章 + 复核
- 知行社社区（账号、研究材料、审阅、任务、三人验收、双模型评审、Agent 授权、廌点账本）
- 前端：搜索首页、学术体检、机构查询、文献检索、工作台、实时核验页
- 《AIA 社区白皮书》（28 页图文 PDF）、两支演示视频
- 自动测试：`npm test` **237 / 237** 通过；前端测试 166 + 88 项通过

### 已实现 vs 规划中

| 已实现 | 规划中 |
|---|---|
| 学者检索、三方交叉验证、学术分 v2.1、本人认领与复核 | ORCID 登录授权、真实邮件发送 |
| 链上评分 / 认领 / 稿件登记 / 廌点（BOT 主网） | 押金锁定与退回合约 |
| 知行社三个区、双模型预评审、审稿门槛、核对题、复现验收、Agent 授权 | 社区廌点同步上链；履约记录推动学术分上涨 |
| 廌点链下账本与链上账本（发放 / 扣减，无转账） | 合作者邀请拉新；期刊与机构付费接入 |

## 2. 代码与运行说明

- 代码仓库：https://github.com/Dalaoyuan2020/xiezhi-protocol
- 环境依赖：Node.js ≥ 24.13；Python 3（评分脚本，仅标准库）
- 启动：
  - `npm ci && npm start` → http://127.0.0.1:8890/ui/（搜索首页）· /workspace/（知行社）
  - `./start-demo.sh` → 本地模拟链 + 实时核验与认领盖章页 http://127.0.0.1:8892/live/（主网：`NETWORK=mainnet ./start-demo.sh`，需服务端私钥）
  - 测试：`npm test`；评分验收：`python3 aia/product/acceptance.py`
- 代码结构：`aia/chain`（合约、Agent、链上读写）· `aia/product`（评分规则与验收）· `aia/live`（实时核验与认领页）· `aia/app`（知行社社区）· `xiezhi-ui`（前端页面）· `whitepaper`（白皮书）· `media`（演示视频）

**沿用组件与数据来源**

| 组件 | 来源 | 用途 |
|---|---|---|
| OpenAlex API | https://openalex.org（CC0） | 学者与论文公开记录 |
| ORCID 公共 API | https://orcid.org | 本人登记与雇主核对 |
| Crossref API | https://www.crossref.org | DOI 登记核对 |
| ethers.js 6 / solc-js 0.8.37 / Ganache 7 | MIT | 链上读写、合约编译、本地模拟链 |
| pinyin-pro | MIT | 中文姓名拼写变体 |
| BOT Chain | https://botchain.ai | 测试网 / 主网部署 |

## 3. 演示材料

- **视频 1 · 核心协议演示（85 秒）**：[media/xiezhi-video1-core-protocol-v2-85s.mp4](media/xiezhi-video1-core-protocol-v2-85s.mp4)
- **视频 2 · AIA 社区（2 分 18 秒）**：[media/xiezhi-video2-community-vision-v3-138s.mp4](media/xiezhi-video2-community-vision-v3-138s.mp4)（每段标注已上线 / 规划中）
- **《AIA 社区白皮书》**：[whitepaper/AIA_COMMUNITY_WHITEPAPER.pdf](whitepaper/AIA_COMMUNITY_WHITEPAPER.pdf)
- **在线体验（正式部署）：https://aia.hai.college/**（`/ui/` 学术查询 · `/live/` 实时核验 · `/workspace/` 知行社 · `/paper/` 论文体检）
- 静态演示站（早期版本）：https://dalaoyuan2020.github.io/xiezhi-protocol/

## 4. BOT Chain 部署核验

| 网络 | 合约 | 地址 | 浏览器 |
|---|---|---|---|
| **主网（677）** | ActionRegistry（学术行为登记） | `0xA0853161002Af018225419324560FCE9CD9b10eD` | https://scan.botchain.ai/address/0xA0853161002Af018225419324560FCE9CD9b10eD |
| **主网（677）** | PointsLedger（廌点账本，无转账） | `0x28B2af15386C0D65D5427d5b81bEe485D4edD60A` | https://scan.botchain.ai/address/0x28B2af15386C0D65D5427d5b81bEe485D4edD60A |
| 测试网（968） | ActionRegistry | `0xA0853161002Af018225419324560FCE9CD9b10eD` | https://scan.bohr.life/address/0xA0853161002Af018225419324560FCE9CD9b10eD |

主网部署交易与演示交易（评分 656 / 704 / 788、两家期刊登记同一稿件、新手保护 +20、认领错挂 +5）见 [aia/chain/MAINNET.md](aia/chain/MAINNET.md)。

## 5. 声明

不发行任何虚拟货币或代币，不募资；廌点不能转让、兑现或买卖。灋廌学术分只反映公开学术记录的可信程度，不是人品评价，不代替同行评议。
