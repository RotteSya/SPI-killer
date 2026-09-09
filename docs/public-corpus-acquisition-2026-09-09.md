# 公开测试材料获取记录 · 2026-09-09

用户授权自主查找并补充测试题及标准答案。本次仅获取与准备材料，没有调用付费模型，也没有为来源/真值/解释复核虚填签署。

| 来源 | 实际获取与检查 | 用途/边界 |
|---|---|---|
| 既有 objective-v1 | 240 题及答案、240 图片摘要匹配 | 仍需当前候选同模型重跑，不作新增留出集 |
| [Ai2 ARC](https://huggingface.co/datasets/allenai/ai2_arc) | 固定版本 `210d026faf9955653af8916fad021475a3f00453`；7,787 唯一题；6 文件上游 LFS SHA-256 全匹配；CC BY-SA 4.0 | 从 test 选 100 单选待审，原标签不改；许可及归属保留 |
| [GSM8K](https://github.com/openai/grade-school-math) | 固定提交 `3101c7d5072418e28b9008a6636bde82a006892c`；MIT 原许可；test 1,319 题均有最终答案 | 选 100 数值短答待审，须检查单位/规范化；不将中间解题过程发给被测模型 |
| [ScholarBench](https://huggingface.co/datasets/KISTI-KONI/ScholarBench) | 固定版本 `0f094f41d7451b0db833c1ae69802871a79a9be6`；1,123 英文记录；12,014,239 字节与上游 LFS SHA-256 匹配；CC BY-ND 4.0 声明 | 100 道真实多选待审，原答案 2–3 个、共 4 选项；100 段材料，按来源前缀保守归为 80 个候选家族，尚未独立审查 |
| [英国 STA 原卷与评分标准](https://www.gov.uk/government/collections/national-curriculum-assessments-past-test-materials) | 2024–2026 数学卷、评分标准及版权说明 19 份完整 PDF；6 道原生排序题逐题目视对照官方答案 | OGL v3.0；6 原页、6 答案页及 3 个完整目标裁切已检查，答案页与模型输入分开 |
| [OpenStax Biology](https://openstax.org/books/biology/pages/preface) | 页面同时包含 CC BY 声明和生成式 AI 摄入限制 | 不直接用于本轮外部模型评测，避免把普通开放下载推定成所需授权 |
| [Pirá](https://github.com/C4AI/Pira) | README/LICENSE 已取得；问题数据标 CC BY，原文另涉及 Scopus 与 UN 来源 | 尚未核对每段原文的授权链，未纳入题集 |
| [TimeDial](https://github.com/google-research-datasets/TimeDial) | CC BY-NC-SA，适用非商业限制 | 未作为商业产品发布验收材料 |
| [MC-TACO](https://github.com/CogComp/MCTACO) | 找到多答案/时间关系任务，当前源仓库未找到明确数据许可证 | 未纳入题集 |

证据目录为 `native/.release-evidence/2026-09-09/public-corpus/`。`arc-source-provenance.json`、`arc-upstream-integrity.json`、`arc-validation.json` 和 `gsm8k-source-provenance.json` 绑定原始版本、字节数与摘要。`source-review-cases.json` 保存 200 题的原文、参考答案、来源家族及卡片摘要；`review-cards/` 为不含答案的图片。它是复核队列，不是正式评测 manifest。取样使用固定 SHA-256 排序，未观察候选模型结果后挑题。

ARC、GSM8K 和 ScholarBench 图片是原题文字重新排版的卡片，不能冒充原始网页/PDF/练习界面布局。STA 图片保留原 PDF 的实际页面或单题区域。ARC 145 道含 order/sequence 字样的题中只筛出 36 道可能的排序改编候选，仍保留原单选格式、等待逐题审阅，不计入排序配额。不得把“in order to”等词出现当作排序题。

当前复核队列合计 306 题：单选/多选/短填各 100，排序 6。排序距计划 100 题仍差 94；这不是已通过真值审查的样本数。还需补足四类真实布局、不可读/裁切/缺材料/歧义及多目标/范围外场景；题型与语言各格样本、家族隔离、独立真值审查、80 份实际模型解释复核及候选执行证据都未完成。既有公开基准有训练污染可能，后续报告需单列这一限制。已获取材料及其答案不等于模型质量验收通过。


## ScholarBench 完整性恢复与渲染检查

初次固定 URL 下载提前结束，文件头有效但尾部及大小不符；失败记录保留。随后以原 ETag 的 If-Range 和精确 Content-Range 补取缺失 25,708 字节，完整文件 SHA-256 为 `8bf747843e21263d574124c6b9da787617028e1034b92aae5236b82263f4be4d`，与上游固定版本声明一致。只有该完整文件进入解析，见 `scholarbench-source-provenance.json`。

按发布方 human_accuracy=5、有效答案结构及长度上限筛选，以固定摘要排序和学科轮转取 100 道，未观察候选模型结果。发布方评分只是来源元数据，不代表本项目独立审题。`scholarbench-review-cases.json` 保留原文、原选项、答案标签、段落 ID 与待核验家族前缀；同一前缀的段落不得跨开发集和留出集。

最新 `scholar-review-cards-v3/` 共 218 张、每题最多 4 张，逐张解码与摘要唯一性检查通过。内部 section/text 字典表示仅解码为其原始标题/段落值，原始源串另存；答案标签不绘入输入。抽看首段和最长材料末页无裁切、遮挡。原材料仍存在断词、提及未附图表等问题：63 题带图表引用，必须逐题判断文字是否足够，不能把完整下载视为内容完整。尚未完成全部视觉及真值复核，见 `scholar-card-validation.json`。

## STA 排序题来源绑定

| 来源题目 | 原卷页 | 官方评分页 | 已核对顺序 |
|---|---:|---:|---|
| 2026 KS2 Paper 2 Q1 | 4 | 23 | 1,005 → 1,050 → 1,500 → 1,505 |
| 2026 KS2 Paper 3 Q6 | 8 | 32 | 9/8 → 1 3/8 → 1 5/8 → 15/8 |
| 2025 KS2 Paper 3 Q13 | 14 | 34 | 0.009 → 9/100 → 99/100 → 0.999 |
| 2024 KS2 Paper 3 Q12 | 13 | 34 | 1/5 → 3/4 → 8/10 → 7/8 |
| 2026 KS1 Paper 2 Q12 | 12 | 12 | 6 days → 6 weeks → 6 months → 6 years |
| 2025 KS1 Paper 2 Q30 | 28 | 18 | C → A → D → B |

6 份原卷与配套评分标准均已目视核对，分数、混合数、连线及钟面未依赖 PDF 纯文本推断。3 张多题原页另用原 PDF 渲染完整目标区域，保留像素裁切坐标与原页引用，完整题目和作答区均可见。原页与裁切仍属于同一题，不能重复计数。2025/2026 对应版权报告及 [2024 KS2 版权报告](https://www.gov.uk/government/publications/key-stage-2-tests-2024-mathematics-test-materials/2024-copyright-ownership-key-stage-2-national-curriculum-tests)明确数学材料没有第三方内容；每题记录指定归属文字与 OGL v3.0 链接。

`sta/ordering-review-cases.json` 绑定源 URL、原卷/评分标准 SHA-256、页码、输入图片及答案。`sta/pdf-downloads.json` 记录 19 份 PDF 的完整字节与本地摘要；没有出版方摘要的文件不能声称通过上游摘要匹配。8 份初次短传输经有界 Range 补取后通过总长度及 PDF 完整性检查。以上检查由实施工程代理执行，独立复核者为空，正式 holdout 标志仍为 false。

## 9 月 10 日统一复核索引

私有 `REVIEW-INDEX.md` 将全部 306 题按题型列出题图/材料、来源标准答案及候选家族。配套 `unified-review-index.json` 绑定 3 份原始题目记录的 SHA-256 和条目索引，并保留归属、答案页及材料风险标记。重新解码/核验 424 张输入图片，434 个本地链接全部存在；候选家族 215，仍需独立审查后按家族划分。图表引用标记不能单独证明缺材料或材料完整。独立签署为空、formal_holdout_approved 全为 false；题目数量及正式评测缺口没有因索引生成而改变。验证记录为 `unified-review-validation.json`。
