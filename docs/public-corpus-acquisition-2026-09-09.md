# 公开测试材料获取记录 · 2026-09-09

用户授权自主查找并补充测试题及标准答案。本次仅获取与准备材料，没有调用付费模型，也没有为来源/真值/解释复核虚填签署。

| 来源 | 实际获取与检查 | 用途/边界 |
|---|---|---|
| 既有 objective-v1 | 240 题及答案、240 图片摘要匹配 | 仍需当前候选同模型重跑，不作新增留出集 |
| [Ai2 ARC](https://huggingface.co/datasets/allenai/ai2_arc) | 固定版本 `210d026faf9955653af8916fad021475a3f00453`；7,787 唯一题；6 文件上游 LFS SHA-256 全匹配；CC BY-SA 4.0 | 从 test 选 100 单选待审，原标签不改；许可及归属保留 |
| [GSM8K](https://github.com/openai/grade-school-math) | 固定提交 `3101c7d5072418e28b9008a6636bde82a006892c`；MIT 原许可；test 1,319 题均有最终答案 | 选 100 数值短答待审，须检查单位/规范化；不将中间解题过程发给被测模型 |
| [ScholarBench](https://huggingface.co/datasets/KISTI-KONI/ScholarBench) | 许可声明 CC BY-ND 4.0；候选英文文件应为 12,014,239 字节，固定 URL 实际收到 11,993,558 字节 | 完整性不符，未纳入材料；多选来源继续获取，不能以格式头有效代替摘要匹配 |
| [OpenStax Biology](https://openstax.org/books/biology/pages/preface) | 页面同时包含 CC BY 声明和生成式 AI 摄入限制 | 不直接用于本轮外部模型评测，避免把普通开放下载推定成所需授权 |
| [Pirá](https://github.com/C4AI/Pira) | README/LICENSE 已取得；问题数据标 CC BY，原文另涉及 Scopus 与 UN 来源 | 尚未核对每段原文的授权链，未纳入题集 |
| [TimeDial](https://github.com/google-research-datasets/TimeDial) | CC BY-NC-SA，适用非商业限制 | 未作为商业产品发布验收材料 |
| [MC-TACO](https://github.com/CogComp/MCTACO) | 找到多答案/时间关系任务，当前源仓库未找到明确数据许可证 | 未纳入题集 |

证据目录为 `native/.release-evidence/2026-09-09/public-corpus/`。`arc-source-provenance.json`、`arc-upstream-integrity.json`、`arc-validation.json` 和 `gsm8k-source-provenance.json` 绑定原始版本、字节数与摘要。`source-review-cases.json` 保存 200 题的原文、参考答案、来源家族及卡片摘要；`review-cards/` 为不含答案的图片。它是复核队列，不是正式评测 manifest。取样使用固定 SHA-256 排序，未观察候选模型结果后挑题。

所有图片都是原题文字重新排版的卡片，不能冒充原始网页/PDF/练习界面布局。ARC 145 道含 order/sequence 字样的题中只筛出 36 道可能的排序改编候选，仍保留原单选格式、等待逐题审阅，不计入排序配额。不得把“in order to”等词出现当作排序题。

还需补齐多选和排序各 100、四类真实布局、不可读/裁切/缺材料/歧义及多目标/范围外场景；题型与语言各格样本、家族隔离、独立真值审查、80 份实际模型解释复核及候选执行证据都未完成。既有公开基准有训练污染可能，后续报告需单列这一限制。已获取材料及其答案不等于模型质量验收通过。
