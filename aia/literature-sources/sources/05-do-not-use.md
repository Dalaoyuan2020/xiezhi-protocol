# 不要当可信源

这些不能进主检索链路，也不要为它们注册“学术源”账号。

- Sci-Hub、Library Genesis、随机 PDF 站：版权和供应都不稳定，不能当引用来源。
- Google Scholar 爬虫、SerpAPI 转接 Scholar：可以当召回参考，不能当主库。没有官方 API，结果会掉、会封。
- 知网、万方的非官方接口或 cookie 抓取：不接入。
- Academia.edu、ResearchGate 页面抓取：不是完整书目库，条款也不允许当 API 用。
- 过期的 Microsoft Academic 在线 API：已关闭，后继是 OpenAlex。
- 任何要求把 key 写进仓库的脚本：拒绝。

可信的判断：有官方文档、有稳定标识（DOI / PMID / arXiv id）、允许机器读取、出错能追溯到原始记录。
