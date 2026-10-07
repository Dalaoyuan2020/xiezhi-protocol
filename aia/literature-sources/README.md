# 文献检索信源

汉客松 2026 武汉黑客松项目用。用来分头注册可信学术文献 API，补 OpenAlex 之外的召回。

不要把 API key 提交进这个仓库。凭据仅放服务端环境变量，或在独立管理页 `/admin/sources/` 登录后保存为服务端加密配置。注册进度写在 `registry/accounts.md`，不记录密钥。

更新：2026-10-07。

## 分工

1. `sources/01-register-now.md`：马上注册，P0 先领。
2. `sources/02-no-key.md`：免 key，直接并行接。
3. `sources/03-institutional.md`：走图书馆或已有订阅。
4. `sources/04-preprints-and-data.md`：预印本和数据集。
5. `sources/05-do-not-use.md`：不能进主链路的源。
6. `registry/accounts.md`：谁注册的、邮箱、环境变量名、实测额度。
7. `registry/query-order.md`：默认并行查询和去重顺序。

P0：Semantic Scholar、CORE、NCBI、OpenAlex 正式 key。

## 应用接入

查询入口为 `/ui/papers.html`；密钥配置入口只通过 `/admin/sources/` 访问，不加入产品导航。管理页的登录和服务器迁移说明见 [应用部署文档](../app/README.md#独立文献源管理)。

实现的查询来源为 Sciverse、OpenAlex、Crossref、Semantic Scholar、Europe PMC、PubMed、arXiv、DataCite、NASA ADS。默认并行查询通用来源，学科选项补充专业来源；单源失败保留其他结果，并标出本次各来源的状态。Sciverse 保留语义检索及有权读取的原文和图表。结果合并不是作者归属认证，也不会自动改变学者评分。

其他渠道的注册和配置预留仍保留在清单中。管理页会区分“已经接入”和“尚未接入”；仅保存了密钥不能视为该渠道已经可以查询，收到真实结果才算实际验证。
