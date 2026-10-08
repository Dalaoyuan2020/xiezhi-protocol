# 灋廌覈鑒 · Xiezhi｜学术工作台

## 当前运行入口（2026-10-07 晚）

根目录 `新ui/` 工作台入口为 `/workbench/`，来自队友的 `new-ui` 分支。默认 `/ui/` 是 `xiezhi-ui/` 的彩色搜索首页，左上角九点图标“返回搜索首页”可直接切换；姓名、单位与合法 network 参数保留。`aia/ui/` 仍停用；`xiezhi-workbench-v3/` 仅为上传时副本，不参与运行。

在仓库根目录 `npm ci && npm start`，打开 `http://127.0.0.1:8890/workbench/`。需要 Node 服务，当前实时功能不通过静态服务启动。首页调用服务端 OpenAlex 真实姓名／ORCID 检索，支持可选学术单位及中英文别名。选择候选进入使用相同新版工作台布局的 `/workbench/live/`，真实取数核验；返回时保留查询和单位。用户提供的“徐林森”已验证返回候选，并可按河海大学筛选。

文献检索 `/workbench/papers.html` 使用多源服务端接口，支持结构化与语义查询、部分失败展示、原文及图表。独立密钥管理 `/admin/sources/` 不出现在工作台导航中，凭据只在服务端保存，说明见 [服务端文档](../aia/app/README.md)。

角色草稿、典型案例和机构页保留其自身标明的本地／快照边界；实时查询不会用这些快照替代失败结果。正式账号与私有协作继续使用 `/workspace/`。邮箱验证码认领的新代码已从 `main` 合入，但 8890 的公开核验保持只读，没有把演示验证码当作真实身份验证或自动发起链上交易。

验证：`npm test` 检查服务端，`npm run test:ui` 检查两套界面行为。以下历史交付描述保留用于追溯，其中快照搜索和静态启动不代表当前首页的实时实现。

## V3 当前功能与交付验收

保留单稿手动保存，新增覆盖保护、跨标签 Web Locks、原文备份、JSON 预览导入与 Markdown 导出。导入/恢复备份只进入编辑区，不自动存储。宽屏证据为真实非模态侧栏，窄屏为全宽面板；分数从首次显示即为实际值，动画仅更新图形。

- `page-registry.js` 是导航与网络链接的共同注册表；网络提示使用既有明确挂载点。
- `role-drafts-core.js` 提供异步 `saveDraft(..., { locks, expectedRaw })`、`readSnapshot`、`parseImport`、`buildMarkdown`；v1文本字段保持兼容。
- `evidence-core.js` 只整理原始字段与摘要，不反推缺失计数；`evidence-panel.css` 提供两种阅读布局。
- 必须递归打包 `tests/**`，包括真正的 `helpers/reader-dom.cjs` 和 `helpers/draft-dom.cjs`。
- 使用根目录 `tools/release.py` 构建并验证 ZIP。最终通过数、工具版本、命令和 SHA256 以 ZIP 旁的验收报告为准；不得把工作副本结果当作发布包结果。

以下为先前版本的说明与验证记录，保留用于溯源。


## 当前工作台交付（2026-10-07）

当前前端在同一项目中提供读者、审稿人、投稿人三个工作视角，以及机构查询、公开规则和数据说明。角色切换不代表登录或权限。研究工作台 `commission-demo` 的服务、身份和模拟账本未合并。

- 读者：搜索 → 候选 → 档案／证据 → 返回原结果，恢复查询、选中项、滚动与焦点；原有评分、收据和网络语义保留。
- 审稿人、投稿人：仅本地草稿保存／手动恢复、缺项检查与 JSON 导出。没有真实任务分配、投稿后端或业务提交。
- 公共框架：`workbench.js` 挂载 `#wb-sidebar-slot`、`#wb-topbar-slot`；`network-nav.js` 只使用 `#network-notice`，覆盖七页及新标签选网。
- 样式：`style.css` 为语义 token，业务 CSS 保留组件布局，`workbench.css` 最后加载。机构选择器限定 `.org-page`；`homepage.css` 为兼容空文件。
- 启动：项目根目录运行 `python3 start-demo.py`。完整说明与边界见 [本轮交付说明](../../delivery/workbench/工作台前端交付说明.html)。
- 验证：基线 69 项，最终 117 项单元测试通过；新界面 21 项浏览器场景通过。记录位于 `delivery/workbench/verification/`，真实外网与链上状态未核验。

以下保留此前基础能力、数据与组件说明，作为历史技术背景；本轮界面与验证以以上入口为准。


学术信誉链的两个示范应用：个人体检与机构查询。当前入口为 `index.html`，按 `plan/WINDOWS_TASKS.md` 接手搜索首页，并同步 15:00 定名；共享评分脚本、学者案例和合约保持由原负责人维护。

## 启动

在仓库根目录执行：

```sh
python -m http.server 8878 --bind 127.0.0.1 --directory aia
```

打开 <http://127.0.0.1:8878/ui/index.html>。静态服务必须覆盖 `aia/`，因为网页会读取同级 `product/` 和 `chain/`。无需构建或安装前端依赖。收据使用 Web Crypto，线上应提供 HTTPS。

**真实测试网已接入**：<http://127.0.0.1:8878/ui/org.html?network=testnet> 自动读取测试网的演示稿件；<http://127.0.0.1:8878/ui/checkup.html?case=A5126602136&view=receipt&network=testnet> 显示致远的真实评分记录。顶部可切回主网，测试网始终标为 Chain ID 968，不计作主网交付。

[3 分钟快照演示备份](docs/demo-snapshot-3min.webm)：1440×960、静音、加速整理自实际页面操作，展示搜索、证据、本地认领、虚构期刊结案。视频录制早于项目更名和测试网入口接入，画面沿用“学术体检”，不包含真实链上认领或交易广播。

## 本次 P0

- 首页：ORCID、中文名与拼音查询；输入 Lyu / Zhiyuan Lyu / 吕志远先显示 5 个真实 OpenAlex 同名候选，带机构、研究方向、论文数和来源日期；本人 ORCID 精确匹配后直达体检卡。
- 搜索范围是本地候选快照与四个演示案例，并非全库实时检索。`search-data.json` 保留公开 API 字段、抓取时间、历史单位和中文摘要。A5111337086 的当前河海记录与历史交大署名冲突会明确显示。
- 尚无评分的候选进入档案摘要，显示“暂未评分”；不借用别人的分数，也不伪造五维数据。已有案例仍读取唯一的 `../product/mock_cases.json`。
- 链上读取支持 SCORE / SUBMIT / CLOSE / REVIEW / REPRODUCE / CLAIM；CLOSE 的 REJECTED / WITHDRAWN / ACCEPTED 显示拒稿 / 撤稿 / 录用。未支持的行为保留原值，并明确不参与规则判断。
- 机构页按投稿生命周期判断：同一稿件在两个以上可信机构同时在审才触发提示；结案关闭对应在审状态，再投可重新打开。拒稿本身不代表违规，不自动扣分。
- 期刊登记同时匹配名单中的地址和机构指纹。名单外记录显示“未认证来源，不计入判断”；名单缺失、无可信投稿或连接失败不显示无风险绿灯。
- 体检卡、收据、机构查询、返回搜索之间有清楚的跳转；`checkup.html?case=A5126602136&view=receipt` 可直接打开该学者收据；机构页可读同一作者记录。

## 3 分钟演示路线

1. 首页点击本人案例或搜索 Lyu，辨认同名候选，选择河海大学本人档案。
2. 看 70 分体检卡，点开维度证据。点击“本人认领 · 演示”进入本地确认，查看错挂论文、归属变化及重算说明。
3. 在收据页查看链状态；未部署时会明确显示“未部署 · 快照演示”。本地收据与真实链记录分区呈现。
4. 点击“下一步 · 机构查询”。虚构模式选择两刊在审，查看红灯，点模拟结案，确认只剩一家在审且提示解除；也可直接选择“结案后改投”案例。
5. 返回个人体检，查看低分任务或何恺明的审稿专家推荐；回到机构的同一学者链上查询，说明两个应用共读同一登记合约。

真实链上的红灯 → 结案 → 绿灯，需要部署方执行 seed / close，并在机构页刷新。页面不代签、不广播交易。链上认领由部署方脚本写入，页面刷新后可展示 CLAIM 及对应交易凭据。

**尚未实现真实的答题验收与奖励结算**：个人任务目前展示核验要求和贡献分草案，不会通过点一次按钮就修改真实信誉。认领不等于 ORCID 授权验证；普通钱包提交 CLAIM 也不能自动证明论文归属。

## 合约与来源接入

UI 只读下列部署文件：

```text
chain/deployments/botchain.json
  { chainId: 677, address: "0x…", block: 123, … }
chain/deployments/journals.json
  { manuscript: "0x…", journals: [{ name, address, org }], … }
chain/artifacts/ActionRegistry.json
  { abi: […] }
```

首次打开且未指定 network 时优先主网 677；仅当主网清单不存在（404）且测试网配置有效，页面自动跳转至 `?network=testnet`。显式 `?network=mainnet` 则停留主网，即使未部署也不会回退。测试网 968 使用 `botchain-testnet.json` 与 `journals-testnet.json`、RPC `https://rpc.bohr.life`、浏览器 `https://scan.bohr.life`；错误配置或 RPC 故障不触发跨网切换。机构页无 mode/q 时按选中网络的有效部署与名单自动选择链上模式；未部署时保留诚实的虚构预览。

真实作者查询用 `actionsOf(keccak256("openalex:<作者ID>"))`；稿件查询用 `actionsByContent(hash)`。一次读取固定区块，登记人、时间、规则取自合约 Action；交易哈希、区块和日志序号必须与真实 Recorded 事件匹配。事件无法唯一匹配时保留行为，明确缺少交易凭据。

机构结案匹配 recorder + org + subject + content，按时间和合约返回顺序处理，避免同秒事件顺序不确定、另一机构替人结案、另一个稿件关闭错误投稿。投稿频率提示按近 7 天不同稿件指纹计数，重复提交同一文件不会累加为多篇。

可信名单是本站的演示接入策略，不代表这些钱包在链上获得了官方期刊认证。任何人都能登记的合约，需要由应用自己声明采信来源。机构匹配和规则判断在浏览器进行。

默认未部署状态不加载 ethers、不请求主网 RPC。部署文件有效后，读链前检查所选 chainId（主网 677／测试网 968）、RPC 网络、部署区块及地址合约代码；失败会显示原因和重试。事件扫描限制为最近至多 20,000 区块、20 批和 15 秒预算；超出范围会说明交易历史不完整。

网络资料：[BOT Chain 官方配置](https://dev-docs.botchain.ai/docs/Developers/quick-guide/)，[ethers 合约 API](https://docs.ethers.org/v6/api/contract/)。缺失部署 JSON 的 HTTP 404 是静态托管时预期的回落路径，不是已经部署。

## 评分与认领边界

- 真实姓名的评分快照为 2026-10-07；不实时重算履历，不将任意地址上链的 SCORE 覆盖成平台公认评分。
- 虚构案例源总分 21、五维合计 9，页面显示可复算的 9 并提示不一致，没有改写队友原文件。
- 本地认领演示记录论文数量 2 → 3；五维指标尚未补齐，仍为 70 分，不声称完成新增论文的全量评分。
- +5 / +3 / +8 是独立贡献分草案，不与 v0 合计；专家推荐不等于已获资格。
- 本地收据是真实 SHA-256 完整性指纹，包含 simulation 标志；合约使用 keccak256，两者不可混用。哈希证明内容是否变动，不证明科学结论或身份真实。
- “未触发提示”只描述已读取、可信来源覆盖内的行为，不代表没有其他问题。

## 组件接口

```js
ScholarCheckup.selectCase('A5126602136');
ScholarCheckup.showView('receipt');
ScholarCheckup.setPresentation(true);

const view = ScholarCheckupChain.mount(root, { id: 'A5126602136' }, {
  onStatus(state) { /* loading / snapshot / synthetic / ready / partial / error */ }
});
// 按稿件读取：mount(root, { contentHash: '0x…' }, options)
view.reload();
view.destroy();

const manifest = await ScholarCheckupChain.loadJournals();
const journal = ScholarCheckupChain.trustedJournal(record, manifest);
```

`card.html?id=作者ID` 保持兼容；无评分候选使用 `checkup.html?case=作者ID&candidate=1`。未知 ID 明确提示不存在。雷达可键盘操作，证据弹窗支持左右翻页和 Esc；投影模式扩大主要信息。页面保留完整交互动画，包括系统开启减少动态效果时；手机端保留响应式布局与粒子数量限制。

## 检查

```sh
cd aia/ui
npm test
```

Node 20+，测试本身无安装依赖。覆盖评分一致性、收据篡改、未核验贡献、链上六类行为、未知类型、名单校验、同秒结案顺序、重新投稿、不同来源隔离、搜索与 ORCID 精确路由等。

2026-10-07 本轮 **66 项单元测试通过**。真实浏览器验证首页中文／Lyu／ORCID、无结果、故障重试、键盘焦点、未评分候选、认领与跨页跳转；320／390px 无横向溢出。正常已配置的测试网流程无脚本异常；缺失主网部署／名单的预期 HTTP 404 会在浏览器网络控制台出现。

浏览器核对真实 ethers 6.17 与仓库 ABI 的解码，网络使用明确的模拟 RPC，验证六类行为、来源匹配、红灯 → CLOSE → 绿灯、日志与交易链接及移动布局。**模拟 RPC 验证不是主网或测试网部署证明**。正常快照流程另行验证，不混入模拟链数据。

随后读取了队友部署的实际测试网合约 `0xA0853161002Af018225419324560FCE9CD9b10eD`：致远评分 70 的 [真实交易](https://scan.bohr.life/tx/0xe88454487ee6e72b4e82de0c710808f8668c273db5503b1ee94c49f42573dd13) 已通过 RPC 返回及 Recorded 事件匹配；机构页实际读到两家可信期刊投稿并显示红灯。未调用钱包或发送任何链上交易。真实测试网结案需由持有对应期刊钱包的部署方执行，页面刷新接收结果。

## Windows 部署脚本交接（未改合约负责人的文件）

只读复现发现 `chain/demo.mjs` 入口比较 `import.meta.url === 'file://' + process.argv[1]` 在 Windows 为 false：前者是 `file:///C:/…`，后者拼出反斜杠路径。需要用 `pathToFileURL(process.argv[1]).href` 比较，否则命令可能静默退出。

`chain/lib.mjs` 的 `runCheckup` 也需将 URL 的 `.pathname` 改用 `fileURLToPath`，并使用可用 Python。本机 `python --version` 为 3.12.10；`python3` 是 WindowsApps 别名，退出码 9009。只改环境变量不能解决入口判断问题。相关文件按任务分工留给合约负责人修改。

## 公网托管文件

可发布到静态托管，保留 `ui/`、`product/mock_cases.json`、`product/checkup.py`、`chain/artifacts/ActionRegistry.json` 和已生成的公开部署 JSON 的相对目录。入口为 `/ui/index.html`。缺失的部署文件应返回真实 404，不要重写成首页 HTML。无需发布整个仓库、录音、密钥或 node_modules。
