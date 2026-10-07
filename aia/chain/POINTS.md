# 灋廌覈鑒 · 贡献积分（「代币环节」）

> 2026-10-07 致远定：**不发虚拟货币**。贡献用积分激励，积分绑在人身上、**不能转让、不能买卖**。规则来自致远手写设计图 MVP ③④⑤。

## 合约 `PointsLedger`（BOT Chain 测试网已部署）

- 地址：[`0x07F0Ac8dC05C992eb76c46779263C2Bd4B0aBAd4`](https://scan.bohr.life/address/0x07F0Ac8dC05C992eb76c46779263C2Bd4B0aBAd4)（`deployments/points-testnet.json`）
- 函数只有：`award`（发）、`spend`（扣）、`balanceOf`、`setIssuer`、`isIssuer`、`owner`
- **没有 `transfer` / `approve`**：积分不能在人和人之间流动，所以不是币。测试里专门断言了这一点
- 只有登记的发放方（平台钱包，以后可加期刊、核查者）能发和扣；每一笔记下原因和证据指纹，事件 `Awarded` / `Spent` 谁都能查
- 学者标识与 ActionRegistry 一致：`keccak256("openalex:<作者ID>")`

## 规则 `points-v0`（演示参数，不是最终定价）

| 规则 | 积分 | 含义 |
|---|---|---|
| `NEWCOMER` | +20 | 新手保护：Agent 认领 ORCID 成果后的初始积分（一次） |
| `CLAIM_FIX` | +5 | 认领并纠正一篇错挂论文 |
| `CHECK` | +3 | 核对一条参考文献或论文归属（多人比对一致） |
| `REVIEW` | +5 | 完成一份被采纳的审稿意见（仅高分可接） |
| `REPRODUCE` | +8 | 复现一个主张，独立复跑对得上 |
| `MAINTAIN` | +2 | 日常运维任务（数据纠错等） |
| `SUBMIT_LOW` | −10 | 低分档投稿：消耗积分 |

## 档位（看可核查度 0–100）

| 档位 | 分数 | 权益 |
|---|---|---|
| 低分 LOW | < 60 | 投稿需消耗 10 积分 |
| 中分 MID | 60–79 | 入门，投稿免费 |
| 高分 HIGH | ≥ 80 | 投稿免费 + 期刊优先 + 可审稿挣积分 |

档位和积分分开：**档位**由公开数据算出的可核查度决定；**积分**由行动挣来，用来支付低分档投稿、以后兑换实物激励（路线图）。

### 浏览器面板与规则来源

体检卡下方的「积分与档位」直接读取所选网络的 PointsLedger；任务卡和发放 CLI 共用 `aia/ui/points-rules.js`，避免两份奖励数字漂移。档位依据当前体检快照，不把积分余额加到可核查度中。页面本地认领不会发放积分；只有账本中成功记录的事件才作为积分流水。

规则表是登记方的业务策略。当前合约检查发放权限、正数金额及扣款余额，不强制新手限领一次、固定奖励金额、审稿资格、证据去重或任务验收；部署方还需要落实这些发放条件。原因和证据哈希可追查，不代表科学结论已核实。期刊优先和实物激励取决于参与机构后续接入，不是已兑现的权益。

## 命令

```sh
NETWORK=testnet npm run points -- show A5126602136 70      # 余额、档位、流水（只读）
NETWORK=testnet BOT_PRIVATE_KEY=0x... npm run points -- apply A5126602136 REPRODUCE
npm run test-points                                          # 本地模拟链自检
```

## 演示数据（测试网，真实交易）

致远：新手保护 [+20](https://scan.bohr.life/tx/0x87d0ee43cf2352a665a2c01fbb5df324778ad604a8a07b7d8d5fa4ef6684dde3) → 认领错挂 [+5](https://scan.bohr.life/tx/0xa57c822b7872e43ed34f292c0c92f5582852c63b43cb760425528e23da3304f2) → 余额 **25**；可核查度 70 → **中分档**

前端接入时已通过测试网 RPC 只读复核这两笔金额和余额。两笔事件的 `evidence` 当前均为全零值，表示尚未附证据指纹；面板会明确标出。交易真实不等于其对应的 ORCID 核验或论文归属已经由该事件证明。本轮前端接入没有补发、扣分或广播交易。

## 给前端：浏览器直接读

```js
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm";
const { abi } = await (await fetch("../chain/artifacts/PointsLedger.json")).json();
const { address, block } = await (await fetch("../chain/deployments/points-testnet.json")).json();
const p = new ethers.Contract(address, abi, new ethers.JsonRpcProvider("https://rpc.bohr.life"));
const s = ethers.keccak256(ethers.toUtf8Bytes("openalex:A5126602136"));
const points = Number(await p.balanceOf(s));
const flow = [...await p.queryFilter(p.filters.Awarded(s), block), ...await p.queryFilter(p.filters.Spent(s), block)];
```
