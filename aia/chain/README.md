# 链上评分（BOT Chain 主网）

学术体检的核心功能：**把学者的可核查度评分写上链**，谁都能查历次评分。链上只放哈希和分数，论文与原始数据留在链下。

## 合约 `ActionRegistry`（2026-10-07 13:30 从只记评分扩为记行为）

**一个行为上链，一个评分。** 投稿、结案、审稿、复现、认领、评分，每做一件事记一笔指纹。

| 函数 | 作用 |
|---|---|
| `record(subject, kind, content, org, rule, value)` | 登记一个行为；`kind` 为 `SCORE / SUBMIT / CLOSE / REVIEW / REPRODUCE / CLAIM`，`value` 只在 SCORE 时用（0–100） |
| `submitScore(subject, score, snapshot, rule)` | 评分的便捷写法 |
| `actionsOf(subject)` | 某个人的行为时间线（to C 个人页） |
| `actionsByContent(content)` | 同一指纹的全部记录（to B 机构页）：某期刊有「投稿」没「结案」= 在审；**两家以上同时在审 → 疑似一稿多投**。判断逻辑在 `lib.mjs` 的 `openSubmissions()`，**只采信公开名单里的期刊地址所记的行** |
| `count()` / `getAction(id)` | 总数 / 单条 |

字段约定（`lib.mjs`）：
- `subject = keccak256("openalex:<作者ID>")`，致远是 `openalex:A5126602136`
- `kind = bytes32("SUBMIT")` 等，用 `ethers.encodeBytes32String`
- `content`：稿件文件字节、或体检卡 JSON（键排序后）的 keccak256；**只上指纹，不上内容**
- `org = keccak256("org:<机构名>")`，个人行为为 0
- `rule`：评分时是规则版本 `bytes32("checkup-v0")`；结案时是原因 `REJECTED / WITHDRAWN / ACCEPTED`
- 任何人都能登记，链上记下登记人地址 `recorder`；读者按自己信任的登记人筛选

编译用 solc 0.8.37、`evmVersion: paris`（不产生 PUSH0 指令）。

## 使用

```sh
cd aia/chain
npm install
npm run compile          # 生成 artifacts/ActionRegistry.json
npm run check            # 本地 EVM 全流程自检 + 对主网估算部署 gas（不花钱）
BOT_PRIVATE_KEY=0x... npm run deploy            # 部署，写入 deployments/botchain.json
BOT_PRIVATE_KEY=0x... npm run score -- A5126602136 A5009290031   # 打分并上链，收据存 receipts/
BOT_PRIVATE_KEY=0x... npm run record -- SUBMIT A0000000001 ./manuscript.pdf 期刊甲   # 登记投稿等行为
npm run read -- A5126602136                      # 某人的行为时间线
npm run read -- --content 0x...                  # 同一指纹的全部记录
```

**路演演示数据**（部署后）：

```sh
BOT_PRIVATE_KEY=0x... npm run demo -- seed    # 3 个真实案例评分上链；两家演示期刊登记同一稿件（红灯）；写出 deployments/journals.json（可信期刊名单）
BOT_PRIVATE_KEY=0x... npm run demo -- close   # 现场：演示期刊甲「拒稿结案」→ 变绿
BOT_PRIVATE_KEY=0x... npm run demo -- claim   # 现场：致远认领档案
npm run test-demo                              # 在本地模拟链上先把上面整套跑一遍
```

演示期刊的钱包由平台私钥派生，`seed` 时自动各转 0.01 BOT 作手续费。

不带 `BOT_PRIVATE_KEY` 时 `score`、`record` 只算指纹，不上链。**私钥只放环境变量，不要提交进仓库。**

## 实测（2026-10-07）

- 本地 EVM：评分；一稿多投识别（两家期刊同时在审）；**作者自己伪造「结案」不被采信**；**期刊甲拒稿结案后改投期刊乙不报警**；个人时间线；非法输入拒绝，全部通过
- 主网只读估算：chainId 677，部署约 581,799 gas，gasPrice 20 gwei，**约 0.0116 BOT**；每次登记更便宜
- 主网 RPC 允许跨域（`Access-Control-Allow-Origin: *`），**前端可以在浏览器里直接读链**

## 给 UI 队友：浏览器里直接读链

部署后，合约地址在 `deployments/botchain.json`，ABI 在 `artifacts/ActionRegistry.json`。

```html
<script type="module">
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm";
const abi = (await (await fetch("../chain/artifacts/ActionRegistry.json")).json()).abi;
const { address } = await (await fetch("../chain/deployments/botchain.json")).json();
const reg = new ethers.Contract(address, abi, new ethers.JsonRpcProvider("https://rpc.botchain.ai"));
const subject = ethers.keccak256(ethers.toUtf8Bytes("openalex:A5126602136"));
const timeline = await reg.actionsOf(subject);        // [{subject, kind, content, org, rule, value, recorder, time}, ...]
// kind 用 ethers.decodeBytes32String(a.kind) 解出 "SCORE" / "SUBMIT" / ...
const sameManuscript = await reg.actionsByContent(fingerprint);  // 机构页：同一稿件出现在几家机构
</script>
```

## 还没做

- 主网部署：等致远领到 Gas、给部署钱包
- 「本人认领」目前只是公开声明，没有和 ORCID 登录绑定
- 分数如何根据行为记录更新（v1 规则）：评分仍由 `checkup.py` 链下计算，规则版本随评分一起上链
