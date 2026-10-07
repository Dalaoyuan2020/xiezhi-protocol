# 灋廌覈鑒 · Agent 服务接口（给前端）

## 启动

```sh
cd aia/chain && npm ci
NETWORK=testnet npm run agent     # http://127.0.0.1:8892；默认只读，不需要钱包
```

这是保留的 Agent 工具服务，与真实账号产品 `aia/app` 的 8890 端口分开。`AIA_AGENT_PORT` 可修改端口，`AIA_AGENT_HOST` 默认 `127.0.0.1`；不再沿用产品的 `PORT` / `HOST` 配置。Windows PowerShell 可先运行 `$env:NETWORK = 'testnet'`，再运行 `npm run agent`。

打分步骤需要 Python 3。Windows 默认使用 `python`，其他系统使用 `python3`；`AIA_PYTHON` 可指定解释器的完整路径，路径中可含空格。子进程使用 UTF-8、原生绝对路径和固定工作目录，总超时默认 120 秒，可用 `AIA_CHECKUP_TIMEOUT_MS` 调整（最多 180000 毫秒）。运行失败会报错，不返回演示分数。

默认上链开关关闭：即使环境中已有 `BOT_PRIVATE_KEY`，GET、健康检查和无 `anchor=1` 的请求都不会读取该密钥，更不会广播。只有管理员显式设置 `AIA_AGENT_ANCHOR_ENABLED=1`，配置该网络部署与签名能力后，同源 POST 的 `anchor=1` 才能进入原有 Agent 上链业务。`GET ...&anchor=1` 始终返回 405。

所有 POST 必须携带与当前服务完全一致的 `Origin`（浏览器同源 `fetch` 自动携带）。反向代理部署时可设置 `AIA_AGENT_ORIGIN=https://agent.example.org`，保留原始 Host。这个历史服务没有真实账号授权，写入开关仅供受控环境中的管理员使用；真实用户的签名及存证应使用 `aia/app` 的钱包流程。

静态资源采用精确清单：现有 `ui/` 页面运行文件、`product/mock_cases.json`、链上公开 ABI 和指定部署清单、`brand/seal.html` 与 `brand/seal.png`。不提供整个仓库目录。`.env`、`.runtime`、数据库、`node_modules`、测试和源码（包括 Python、服务器与合约源码）均不能通过此服务下载。根路径跳转到 `/ui/index.html`。

## 接口

| 接口 | 作用 |
|---|---|
| `GET /api/health` | `{network, chainId, contract, wallet:null, balance:null, anchoringEnabled, service:'legacy-agent'}`；不查询平台钱包或余额 |
| `GET /api/run?q=<输入>[&pick=<OpenAlex作者ID>]` | 只读 SSE，逐步推送 Agent 过程，不上链 |
| `POST /api/run?q=<输入>[&pick=<OpenAlex作者ID>]&anchor=1` | 必须同源且服务端开关已开启，才允许第 7 步上链 |
| `POST /api/stamp?author=<OpenAlex作者ID>&name=<文件名>[&anchor=1]` | 请求体为稿件原文字节（≤5MB）；SSE：指纹 → 结构预检 → 红章上链 |

`anchor` 只允许省略、`0` 或 `1`，重复参数被拒绝。`stamp` 不带 `anchor=1` 时仅预检；带 `anchor=1` 时同样要求服务端开关与同源 POST。输入检查、Origin、方法或配置错误在 SSE 开始前返回 JSON `{error,code}`；处理过程失败以 SSE `{error,code:'AGENT_EXECUTION_FAILED'}` 结束，不回传内部异常、密钥或文件路径。

## `/api/run` 的事件（每条 `data: {...}`）

| step | title 示例 | 额外字段 |
|---|---|---|
| 1 | 识别为中文姓名 / ORCID / 学者编号 | `detail`：检索用的拼写，如 `Zhiyuan Lv / Zhiyuan Lyu / Zhiyuan Lu` |
| 2 | 找到 39 位同名学者 | `candidates[]`：`{id, name, orcid, works, cited_by, h_index, institutions[], topics[]}` |
| 2 | （同名多人时）`need_pick: true` | 前端展示候选，用户选中后带 `pick=<id>&q=<原输入>` 再请求一次 |
| 3 | 核对身份 | `target`（同候选卡结构）、`orcid: {orcid, employers[], match}`、`detail` |
| 4 | 拉取到 N 篇论文 | `works[]`：`{title, year, venue, oa, retracted}`（最多 8 篇） |
| 5 | 发现 N 篇疑似错挂论文 / 未发现 | `misattributed[]`：`{title, year, doi, in_profile, in_profile_name, in_profile_orcid}` |
| 6 | 可核查度 70 / 100 | `card`：与 `product/mock_cases.json` 单条结构一致 |
| 7 | 签名并广播交易… → **红章已盖 ✓ 个人已上链** | `sealed: true`、`seal: "灋廌覈鑒"`、`chain: {network, chainId, contract, tx, block, txUrl, subject, snapshot, rule, score}`、`points: {balance, award}`（第一次上链自动领新手保护 +20，`award` 含交易链接）、`meaning`；未上链时 `chain: null` |
| — | | `{done: true}` 结束；`{error: "..."}` 出错 |

只读查询可用 `new EventSource('/api/run?q=' + encodeURIComponent(q))`。需要上链的请求必须改为 `fetch('/api/run?q=' + encodeURIComponent(q) + '&anchor=1', {method:'POST'})`，按 SSE 格式读取响应流；不能把 `anchor=1` 放进 EventSource 的 GET 请求中。

## `/api/stamp` 的事件

| step | title | 额外字段 |
|---|---|---|
| 1 | 计算稿件指纹 | `detail`（keccak256）、`filename`、`size` |
| 2 | 结构预检通过 / 有缺项 | `checks[]`：`{item, ok}`（标题、摘要、参考文献、DOI）、`passed` |
| 3 | 红章已盖 ✓ 指纹已上链 | `sealed: true`、`fingerprint`、`chain{tx, block, txUrl}`、`meaning` |

`stamp` 是 POST，浏览器端用 `fetch(url, {method:'POST', body: file})` 读 `response.body` 的流，按 `\n\n` 切分 `data:` 行。

**红章的含义（页面上必须写）**：稿件指纹已登记上链 + 结构预检通过；**不等于论文为真或审稿通过**。

## 实测（2026-10-07，BOT 测试网）

以下是原 Agent 版本的历史记录。本次服务安全整合只进行了离线注入的 HTTP 测试，没有重新查询这些交易，也没有广播新交易。

- 输入「吕志远」→ 39 位同名学者 → 选 A5126602136 → ORCID 官方雇主河海大学 ✓ → 2 篇论文 → **发现 1 篇疑似错挂**（墒情预印本在上海交大同名学者档案 A5111337086）→ 70 分 → 上链 [tx](https://scan.bohr.life/tx/0x6b8793baeb634e37da0fc4d1d419133458f42f6ae0f3fb63812f79e2e1df8bb2)
- 输入 ORCID `0009-0008-5473-5367` 直达，同样发现错挂
- 稿件盖章 → 预检 4 项通过 → [tx](https://scan.bohr.life/tx/0xd845e4bd9c04ba85a4370d8700d637e01b6a8d7dfa394f8dde2e22fea4184e50)
- 一次完整检索约 15 秒（OpenAlex 实时查询）+ 上链约 5 秒
