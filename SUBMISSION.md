# 提交材料 · 獬豸协议 Xiezhi（汉客松 S1 · ETH Wuhan 2026）

> 按赛事手册 5.2 交付物要求整理。标 ⏳ 的项目待补。

## 1. 项目介绍

| 项 | 内容 |
|---|---|
| 队名与成员 | **Know & Act（知行合一）**；成员：吕志远（队长，产品与链上设计）、星野初夏、夏、sunziwen（UI 与演示） |
| 项目名称 | 獬豸协议 Xiezhi · 学术信誉层 |
| 目标用户 | **学者**（免费查自己的公开档案、认领论文、修复信誉）；**期刊与机构**（登记投稿、识别一稿多投、快速判断作者可信度） |
| 解决的问题 | AI 让论文数量暴涨（ICLR 2026 有效投稿 19,525 篇 → ICLR 2027 登记摘要超 6 万篇），审稿注意力被水文和一稿多投消耗；大会与 arXiv 只能一刀切限篇数，篇数可以分摊给他人挂名规避，信誉分摊不了；论文归属还常被数据库搞错 |
| 核心功能 | ① 学术体检：输入学者 → 用 OpenAlex 公开数据生成五维可核查度评分，每一分可追查证据，评分快照指纹上链；② 本人认领与提分任务；③ 机构查询台：按稿件指纹查跨期刊行为，同一稿件两家同时在审 → 「疑似一稿多投」；④ 链上登记合约：评分 / 投稿 / 结案 / 审稿 / 复现 / 认领六种行为，只存指纹 |
| 赛道 | GCC 公共物品赛道 · 赛题一（Agent 公共信誉与服务验收）；BOT Chain 分赛道 |

### 比赛期间完成的工作（10-06 至 10-08，全部为新增）

- 选题研究与产品定义：GCC 资助方向调研、AIA（注意力 / 想法 / 行动）框架、獬豸协议定名
- 评分脚本 `product/checkup.py`（OpenAlex 五维评分）与 4 个案例
- 合约 `ActionRegistry`（Solidity）+ 编译、部署、登记、读取、演示数据脚本，本地 EVM 自检
- **BOT Chain 测试网部署**及 7 笔演示交易；⏳ 主网部署
- 前端：学术体检（体检卡、评分收据、认领、提分任务）、机构查询台、链上只读模块
- 公开仓库与 GitHub Pages 演示站

### 已实现 vs 后续计划

| 已实现（可演示） | 后续计划（路线图） |
|---|---|
| OpenAlex 档案评分 v0、证据追查 | 评分规则 v1：按领域比较、合并档案识别 |
| 链上登记合约与测试网真实记录 | 期刊「官网挂地址」认证、多签治理可信名单 |
| 一稿多投识别（精确指纹 + 结案） | 抗改写的相似指纹（标题 + 摘要） |
| 认领、提分任务（演示流程） | ORCID OAuth 登录绑定钱包 |
| 机构查询台（快照 + 链上只读） | 期刊投稿系统插件、机构付费接口 |

## 2. 代码与运行说明

- 代码仓库：https://github.com/Dalaoyuan2020/xiezhi-protocol
- 环境依赖：Python 3.10+（评分脚本，仅标准库）；Node.js 20+（合约脚本，`ethers` 6、`solc` 0.8.37、开发用 `ganache` 7）；前端为纯静态页面
- 启动步骤：见 [README](README.md)「本地运行」
- 使用方法：打开 `ui/checkup.html` 选择案例 → 查看体检卡与证据 → 评分收据 / 认领；打开 `ui/org.html` 查询稿件指纹

**沿用组件与数据来源**

| 组件 | 来源 | 用途 |
|---|---|---|
| OpenAlex API | https://openalex.org （CC0 开放数据） | 学者与论文公开记录 |
| ORCID 公共 API | https://orcid.org | 核对学者身份 |
| ethers.js 6 | https://github.com/ethers-io/ethers.js （MIT） | 链上读写 |
| solc-js 0.8.37 | https://github.com/ethereum/solc-js （MIT） | 合约编译 |
| Ganache 7 | https://github.com/trufflesuite/ganache （MIT） | 本地 EVM 测试 |
| BOT Chain | https://botchain.ai | 测试网 / 主网部署 |

## 3. 演示材料

- 可运行链接：https://dalaoyuan2020.github.io/xiezhi-protocol/
- ⏳ 演示视频（3 分钟）

## 4. BOT Chain 部署核验

| 网络 | 合约地址 | 浏览器 |
|---|---|---|
| 测试网（968） | `0xA0853161002Af018225419324560FCE9CD9b10eD` | https://scan.bohr.life/address/0xA0853161002Af018225419324560FCE9CD9b10eD |
| ⏳ 主网（677） | 待 Gas 发放后部署 | https://scan.botchain.ai |

测试网交易记录见 [README](README.md)；主网交易记录部署后补充。
