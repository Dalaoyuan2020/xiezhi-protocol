# 注册进度

只记账号归属和额度，不记 key。环境变量名是约定，值放部署环境。

| 源 | 负责人 | 注册邮箱 | 环境变量 | 额度（实测） | 状态 | 日期 |
|---|---|---|---|---|---|---|
| Semantic Scholar | | | `S2_API_KEY` | | todo | |
| CORE | | | `CORE_API_KEY` | | todo | |
| NCBI | | | `NCBI_API_KEY` | | todo | |
| OpenAlex | 用户提供 | | `OPENALEX_API_KEY` | 未确认总额度；姓名／ORCID／单位查询已实测 | registered | 2026-10-07 |
| Sciverse | 用户提供 | | `SCIVERSE_API_TOKEN` | 未确认总额度；字段、结构化、语义、原文及图表已实测 | registered | 2026-10-07 |
| NASA ADS | | | `ADS_DEV_KEY` | | todo | |
| OpenAIRE | | | `OPENAIRE_TOKEN` | | todo | |
| Unpaywall | | | `UNPAYWALL_EMAIL` | | todo | |
| Crossref polite | | | `CROSSREF_MAILTO` | | todo | |
| EPO OPS | | | `EPO_OPS_KEY` | | todo | |
| Springer Nature | | | `SPRINGER_API_KEY` | | todo | |
| The Lens | | | `LENS_API_TOKEN` | | todo | |

状态用 `todo` / `registered` / `limited` / `rejected` / `skipped`。

2026-10-07 接口验证：Crossref、Europe PMC、PubMed、arXiv、DataCite 的公开查询均实际返回记录；Sciverse 和 OpenAlex 使用用户提供的服务端凭据成功查询。Semantic Scholar 匿名请求遇到限流，应用保留其他来源的结果。NASA ADS 已实现查询适配并通过模拟测试，尚无实际凭据验证；其余预留渠道不能视为已接入。管理员可在 `/admin/sources/` 填写凭据，配置状态不等于上游鉴权验证成功。
