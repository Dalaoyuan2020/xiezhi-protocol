# 第一批：马上注册

有官方接口，免费或低门槛能拿到 key，能补 OpenAlex 缺的摘要、全文、预印本、生命科学和专利。

状态栏留空，注册后改成 `registered` / `blocked` / `skipped`。

| 优先级 | 源 | 补什么 | 注册 | 鉴权 | 备注 | 状态 |
|---|---|---|---|---|---|---|
| P0 | Semantic Scholar | 约 2.14 亿论文、引用、TLDR、SPECTER2 | https://www.semanticscholar.org/product/api | 头 `x-api-key` | 入门约 1 RPS，不够再申请提额 | |
| P0 | CORE | 开放全文与机构库，约 2 亿+ 产出 | https://core.ac.uk/services/api | `Authorization: Bearer` | 用学校邮箱；免费档大约 10 秒 5 次单查 | |
| P0 | NCBI E-utilities | PubMed 生命医学，有 key 约 10 次/秒 | https://www.ncbi.nlm.nih.gov/account/ | 参数 `api_key` | 同时带 `tool` 和 `email` | |
| P0 | OpenAlex | 已在用。补一把正式 key | https://openalex.org/ | `api_key` 或头 | 2026-02 起高用量要 key，超免费额度会计费；单条 DOI 查询和快照仍免费 | |
| P1 | NASA ADS | 天文、物理文献 | https://ui.adsabs.harvard.edu/ 账号设置里 Generate API Token | `Authorization: Bearer` | 文档 https://github.com/adsabs/adsabs-dev-api | |
| P1 | OpenAIRE | 欧洲 OA 论文、项目、数据集图 | https://graph.openaire.eu/ 注册后领 Personal Access Token | Bearer | 公开端点可先用；token 约 1 小时有效，要刷新 | |
| P1 | Unpaywall | DOI 到合法 OA PDF | https://unpaywall.org/products/api | 查询参数 `email` | 不是搜索引擎，只做第二跳 | |
| P1 | Crossref | 约 1.5 亿 DOI 元数据 | 不用注册，polite pool | `mailto` 放进 User-Agent | https://api.crossref.org/works | |
| P1 | ORCID Public API | 作者消歧 | https://info.orcid.org/documentation/api-tutorials/api-tutorial-read-data-on-a-record/ | public API | 只读公开字段；写入要成员资格 | |
| P2 | EPO OPS | 专利，约 1.3 亿+ | https://developers.epo.org/ | OAuth key | 免费注册，有周/日额度 | |
| P2 | Springer Nature Open Access API | Springer OA 元数据与部分全文 | https://dev.springernature.com/ | API key | 先拿 metadata，不要假设能下全库 PDF | |
| P2 | DataCite | 数据集与非期刊 DOI | 读取不用 key | 无 | REST https://api.datacite.org/dois ；GraphQL 将于 2027-07 废弃 | |
| P2 | The Lens | 论文 + 专利 | https://www.lens.org/lens/user/registration | 试用要单独申请 | 账号不自动带 API；公开说法约每月 5000 次、10 次/分钟 | |

申请理由统一写：学术文献发现与去重，非商业转卖，不批量下载受限制的全文。联系邮箱用项目公共邮箱。
