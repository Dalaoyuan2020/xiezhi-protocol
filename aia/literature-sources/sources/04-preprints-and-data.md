# 预印本与研究数据

论文检索要带上这一层，否则会漏掉还没进期刊的结果，以及论文对应的数据和代码。

| 源 | 接入 | 信任级别 |
|---|---|---|
| arXiv | 免 key API | 高，主源 |
| bioRxiv / medRxiv | 官方 API | 高，主源 |
| ChemRxiv | 经 Figshare / Cambridge 接口 | 中，先核对文档再接 |
| SSRN | 无稳定公开搜索 API | 不接入主链路 |
| Zenodo | REST，上传才要 token | 高，数据与软件 |
| Figshare | https://docs.figshare.com/ | 中，公开搜索可用 |
| OSF | https://developer.osf.io/ | 中，预注册与附件 |
| Dryad | 公开 API | 中，生命科学数据 |
| DataCite | 免 key 读 | 高，DOI 对齐 |

预印本命中后要再用 DOI 回 Crossref / OpenAlex 查有没有正式发表版，避免把同一篇计两次。
