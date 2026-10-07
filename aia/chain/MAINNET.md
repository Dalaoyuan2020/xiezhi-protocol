# BOT Chain 主网部署记录（Chain ID 677，2026-10-07 19:09–19:15 北京时间）

浏览器：https://scan.botchain.ai · 部署与平台钱包：`0xE7c719eBf64D2AA5dF3b00CF31A864811b3e242b`

## 合约

| 合约 | 地址 | 部署交易 | 链上代码 |
|---|---|---|---|
| ActionRegistry（学术行为登记） | [`0xA0853161002Af018225419324560FCE9CD9b10eD`](https://scan.botchain.ai/address/0xA0853161002Af018225419324560FCE9CD9b10eD) | [0x0116…2184](https://scan.botchain.ai/tx/0x0116376b976b20f4113731d3f0db5d8d87953290bcd4e272ec7202d84b2e2184) | 2,421 字节 ✓ |
| PointsLedger（贡献积分，不可转让） | [`0x28B2af15386C0D65D5427d5b81bEe485D4edD60A`](https://scan.botchain.ai/address/0x28B2af15386C0D65D5427d5b81bEe485D4edD60A) | [0x39b7…d8c6](https://scan.botchain.ai/tx/0x39b7f88bb9853b3870707ef8a61cf4ad40a914195290ed660f8f1c9aa5f9d8c6) | 1,374 字节 ✓ |

## 演示记录（真实主网交易）

| 内容 | 交易 |
|---|---|
| 评分：致远 656（中等 · 证据不足，checkup-v2） | [0xf540…2e4c](https://scan.botchain.ai/tx/0xf5402b83e707dc6e65134b798571c0e022eda66038db231fc41dc11ca64c2e4c) |
| 评分：Andrej Karpathy 704（良好） | [0xc52e…68e6](https://scan.botchain.ai/tx/0xc52e0de0f15d6b46cdc9bb1987ed3ffd5912b4bdfb406db5aa271b8a05ab68e6) |
| 评分：何恺明 788（优秀） | [0xcddb…8fee](https://scan.botchain.ai/tx/0xcddb1e0d1892218aeb2398f880b7eb38670cbd7f65139c94852d84a5b5338fee) |
| 演示期刊甲登记演示稿件 | [0xab8e…11e5](https://scan.botchain.ai/tx/0xab8ef53b6e0068db85f3f54ad2235289f8196029ed5c3bc5ea613d0affb311e5) |
| 演示期刊乙登记同一稿件（→ 疑似一稿多投） | [0x1ccd…1cbfa](https://scan.botchain.ai/tx/0x1ccdf80d882e229412470e45184b54cd0cf36672a563c88a3f3b16089861cbfa) |
| 积分：致远新手保护 +20 | [0x1485…2b6f](https://scan.botchain.ai/tx/0x148547f8b3bb903ef9e5ffba85addf63dad7ae4259e4b69b0f57709c8c102b6f) |
| 积分：致远认领错挂 +5 | [0x6f49…b234](https://scan.botchain.ai/tx/0x6f490018e565c9b47edd0fb22917841395e7805503403faf3c6994fe2947b234) |

链上回读核对：致远 `SCORE 51 checkup-v2`（展示分 350 + 6 × 51 = 656）；积分余额 25（+20、+5）。

链上分值存 0–100 的 chain_value，展示分 = 350 + 6 × chain_value。
