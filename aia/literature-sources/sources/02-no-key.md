# 第二批：免 key，可直接接

并行检索时加进去重，不要当唯一信源。

| 源 | 端点 | 覆盖 | 限速习惯 | 备注 |
|---|---|---|---|---|
| arXiv | http://export.arxiv.org/api/query | 物理、计算机、数学预印本 | 约 1 次 / 3 秒 | 用 export 域名，带 User-Agent |
| Europe PMC | https://www.ebi.ac.uk/europepmc/webservices/rest/search | 生命科学、预印本、资助、部分全文 | 比较宽松 | 比 PubMed 更适合程序调用，JSON |
| bioRxiv / medRxiv | https://api.biorxiv.org/ | 生命与医学预印本 | 按文档 | 可按日期窗口拉增量 |
| DOAJ | https://doaj.org/api/v2/docs | OA 期刊 | 比较宽松 | 只覆盖目录内期刊 |
| DBLP | https://dblp.org/faq/13501473.html | 计算机会议与期刊 | 低 | 元数据准，不是全文库 |
| OpenAIRE Graph | https://api.openaire.eu/graph/ | 论文、数据、项目、机构 | 公开有限，token 更高 | 偏移翻页上限约 1 万，全量用游标或快照 |
| Zenodo | https://zenodo.org/api/records | 数据集、软件、报告、预印本 | 按文档 | 搜索用 REST；上传才需 token |
| HAL | https://api.archives-ouvertes.fr/docs | 法国 OA 仓库 | 按文档 | 欧洲学位论文补充 |
| PMC OA | https://www.ncbi.nlm.nih.gov/pmc/tools/oa-service/ | PMC 开放全文 | 低 | 只要 OA 子集 |
| ROR | https://api.ror.org/ | 机构标识 | 宽松 | 用来对齐作者单位，不是论文搜索 |
| OpenCitations | https://opencitations.net/index/api/v1 | 引用边 | 按文档 | 引用图补 Semantic Scholar |
| Crossref Event Data | https://www.eventdata.crossref.org/guide | 论文被提及事件 | 按文档 | 不是主检索 |

INSPIRE-HEP（高能物理）有公开 REST，和 ADS 重叠，物理组再接。ERIC 有公开检索，教育学组再接。RePEc 经济学没有稳定的搜索 key，不列入主库。
