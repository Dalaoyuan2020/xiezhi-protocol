# 查询顺序

默认并行，不串行。单次超时按 8 秒计，失败源跳过，不阻塞其余源。

1. Semantic Scholar `paper/search`
2. OpenAlex `works?search=`
3. Crossref `works?query=`
4. 学科是生命科学时加 Europe PMC 和 PubMed
5. 学科是物理、计算机、数学时加 arXiv
6. 学科是天文时加 ADS
7. 拿到 DOI 后再问 Unpaywall 和 CORE 有没有合法 PDF

去重键：DOI > PMID > arXiv id > 归一化标题+年份。
字段冲突：摘要和引用数用 Semantic Scholar，机构和开放状态用 OpenAlex，资助和许可用 Crossref。

## 已落地版本（2026-10-07）

上方是目标查询顺序。当前 `/ui/papers.html` 的联合检索使用 Sciverse、OpenAlex、Crossref、Semantic Scholar 并行召回；生命科学加 Europe PMC／PubMed，理工科加 arXiv，天文学加 arXiv／NASA ADS，数据集领域加 DataCite。也可单独选择来源。

每个来源最多 8 秒，失败或限流保留在本次来源状态中，不用假数据补齐。联合检索按各来源分别翻页，页内去重；显示本页合并数量，不把不同来源的总数相加作为唯一文献数。同标题但 DOI 等明确标识冲突的条目保留，避免错误合并。Semantic Scholar 的作者条件在本页返回记录上核对，不能用于声称作者全量成果。

Sciverse 语义查询及原文切片单独保留；访问原文不绕过来源权限。Unpaywall 和 CORE 第二跳目前尚未实现，在管理页标为待接入。密钥只在独立管理页或服务器环境配置，不能放进 URL、前端或本登记文件。
