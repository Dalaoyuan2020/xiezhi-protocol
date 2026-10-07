---
name: whitepaper-writing
description: "Draft or revise the Zhidian whitepaper for the Wuhan hackathon. Use when asked to write, rewrite, or review 白皮书, whitepaper, 廗点, or 行点 token mechanism."
---

# Whitepaper writing — Zhidian / 廗点

Write a protocol note, not a pitch. The object is 廗点 in this repo. Users may say 行点; treat that as 廗点 unless they explicitly rename it.

## Read first

1. `plan/RULES.md` — scoring, deposits, point earn/spend. This wins on numbers.
2. `whitepaper/ZHIDIAN_WHITEPAPER.md` — current v0.1. Revise it. Do not open a second token paper.
3. `aia/product/POINTS_VALIDATION.md` and `aia/chain/MAINNET.md` if present — only cite checks and addresses that exist.
4. `whitepaper/skills/whitepaper-writing/references/sources.md` — outside writing rules. Do not paste those articles into the paper.
5. `whitepaper/skills/whitepaper-writing/references/zhidian-brief.md` — facts that must not be contradicted.

## Output

- Rewrite `whitepaper/ZHIDIAN_WHITEPAPER.md` in Chinese.
- Keep the coin image line at the top.
- Bump version only if a rule changed; otherwise stay on v0.1 and add a revision date.
- Do not commit a new PDF unless asked. Markdown is the source.
- English filenames. Chinese body. Tables over slogans.

## Required sections

Keep these headings. If a section does not apply, write `N/A` and one sentence why.

1. 一句话与范围 — what 廗点 does, for whom, stage (hackathon demo / mainnet ledger).
2. 问题 — one group, one cost. Non-goals in the same section.
3. 两本账 — 学术分 vs 廗点. They do not mix.
4. 怎么赚、怎么用 — only rows from RULES.md. Mark ✅ shipped and 📌 planned.
5. 机制 — `award` / `spend`, no `transfer`. Evidence hash on every event.
6. 威胁与失败 — sybil, collusion, inflation, oracle/journal dependency.
7. 经济来源 — journals and institutions pay. Scholars do not buy points.
8. 治理与升级 — versioned rules, issuer allowlist, who can change parameters today.
9. 路线图 — shipped vs next vs later. No undated marketing timeline.
10. 风险与不承诺 — write this before the closing.
11. 怎么核对 — repo paths and commands a reader can run.
12. 声明 — not an offer, not a virtual currency, not investment advice.

## Rules

- Verifiable over rhetorical. A number needs a file path or a cited source.
- Describe function, not price. No ROI, yield, 价值捕获, 稳赚, or 上所.
- Do not call 廗点 a transferable token. The contract has no `transfer`.
- Do not use 首创, 颠覆, 千万, or 稳定收益 unless a source says so.
- 去中心化 must say what is still an allowlist.
- Unaudited code stays unaudited. Do not imply an audit.
- Do not copy Bitcoin, Uniswap, or BOT Chain whitepapers. Cite them in one line if comparing scope.
- If RULES.md and the old whitepaper disagree, follow RULES.md and note the drift.

## Done when

- Every earn/spend number matches `plan/RULES.md`.
- Shipped and planned are marked.
- Risk section names at least four failures.
- A teammate can point to the contract and the simulation command.
