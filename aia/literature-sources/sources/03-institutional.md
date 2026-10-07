# 第三批：机构或付费

覆盖更全，尤其是正式期刊和人文社科，但个人注册通常拿不到可用额度。走学校图书馆或已有订阅。

| 源 | 去哪要 | 补什么 | 备注 |
|---|---|---|---|
| Scopus / Elsevier | https://dev.elsevier.com/ | 引文、作者消歧、期刊指标 | 要机构 token；和 Crossref 重叠高 |
| Web of Science | Clarivate Developer Portal | 核心合集、高被引 | 最贵，有订阅再要 |
| Dimensions | https://www.dimensions.ai/ | 资助、专利、临床试验链接 | 免费层很薄 |
| IEEE Xplore | https://developer.ieee.org/ | 电子与计算机会议 | 元数据 API 多为机构 |
| ACM DL | 图书馆申请 | 计算机会议全文权限 | 没有稳定公开搜索 key |
| Wiley TDM | 出版社 TDM 协议 | 受权全文挖掘 | 只在有协议时用 |
| JSTOR | 机构 | 人文社科回溯 | 不适合当主检索 API |

中文库：知网、万方没有可对外发放的检索 API，不要写进自动化主链路。需要中文文献时，先用已授权的图书馆通道，或深势玻尔已公开的中文期刊库（约 1 万种期刊、约 8000 万篇，要单独确认商用条款）。
