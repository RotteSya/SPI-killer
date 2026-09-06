# 独立质量记录操作说明

状态：2.12 / build 19 本地实现，未部署。`independent-quality-v1` 用于独立评测的录入、聚合、审计和阅读；不执行模型调用，也不自动扩大支持范围。

## 数据与复核边界

接口接收已经独立标注、运行并评分的逐题摘要；不会从产品事件推导正确率。授权材料、原始输出、标准答案、题目家族划分及签署原件应保留在受控评测目录，报告只保留摘要和聚合。接口不接收任意文字、图片或答案字段，服务器日志不应记录请求体。

权威结构位于 [`QualitySubmission`](../server/src/quality.ts)，必须包含所有字段；未知值使用契约允许的 `null` 或明确的未标注枚举，不填零冒充测量。

| 部分 | 必需内容与校验 |
|---|---|
| `run` | 执行 ID、数据集 ID/用途及 SHA-256、原始结果 SHA-256、家族划分 SHA-256 或 null、合约、范围/Prompt 版本、模型、40 位 Git 提交、App 版本、起止时间、执行者、计划样本数 |
| `declarations` | 唯一 `profile × kind × language` 支持组合。即使没有实际样本，也会出现零样本单元；`other` 不是可声明客观题型 |
| `cases` | 唯一 case SHA-256、真实 family SHA-256 或 null、profile/题型/语言/布局、真值预期/风险、输出状态/解析路径/协议合法性、是否有答案/正确性、HTTP 时间及 token |
| `review` | 与执行者不同的复核者、复核时间、原 attestation SHA-256、摘要绑定方式和对象；真值/输出/完整执行/无挑选重跑/授权/家族隔离的明确声明 |

标识符为受限 ASCII，SHA-256 为小写 64 位十六进制；时间使用规范 UTC ISO 格式（含毫秒），复核不得早于执行结束，任何时间不得在未来。模型和提交必须是实际运行版本。1–5,000 个计划样本；缺失输出应尽量以 `failed` 项保留，部分运行也可录入，但不得声明 `complete_run=true`。

`ready/review` 必须有答案；无答案的正确性为 null。已标注且有答案的项目必须有布尔评分，只有 `answerable` 才能判对；`unlabelled` 的正确性保持 null。`legacy_fallback` 必须是 review；`screen_no_result` 只属于新题组合约并提供明确范围外/多目标原因。传输器失败用 `failed/none`。这些检查只核对记录自洽性，不能替代对原始输出的真实评分。

新数据使用 `review.binding=case_digest`。`qualityReviewSubject` 对规范化后的 `{run,declarations,cases}` 以代码单元顺序排序对象键、保留数组顺序计算 SHA-256；复核人核对这些确切内容后，才记录其摘要和声明。不得先签摘要再修改标签、顺序或版本。`attestation_sha256` 是实际复核文件的字节摘要。服务端校验摘要绑定，不声称认证了填入的复核人身份。

## 读数与修订

服务端重算聚合并将内容 SHA-256 用作记录 ID。每个 run 的执行元数据首次写入后固定；更改模型、结果文件或执行版本必须使用新的 run ID。相同执行的评分/复核修订追加不可变报告，不覆盖旧结果。相同内容重试返回原记录和修订号。SQL 事务以专用行锁串行分配修订，memory、SQLite 和 PostgreSQL 语义一致。

列表默认每个执行只返回最新修订。最新记录已撤回时继续显示撤回状态，不回退到旧评分。授权撤回、评分错误、执行不完整、版本绑定错误或复核撤回，可通过受保护的撤回端点记录不可重复使用的审计引用；原聚合仍保留，原材料的删除由材料管理流程执行。

页面分层展示 profile、题型、语言、分母及 Wilson 95% 区间。V1 与 fallback 精确率分开；范围覆盖的分母是声明组合中独立标为完整可作答的项目。对未标注输出不报告确定精确率。家族未知时不把 case ID 当成家族 ID。HTTP 请求时间、token 缺失分别报告，不代表完整用户任务时间或已确认货币成本。

非 SPI 样本量只计算 reading_practice/general 的已声明客观题组合中的已标注项目；SPI、其他范围挑战、未声明组合和未标注项不补足 400 / 每题型 100。每个声明组合还需要至少 50 个已标注样本。布局分层与家族摘要可供审核，但是否覆盖真实网页、PDF、跨页材料以及独立授权仍须人工核对源材料。

`thresholds_met` 不是发布批准。必须另外核验准确候选绑定、同模型固定基线比较、机器行零泄漏、至少 80 个解释样本、完整软件验收和真实灰度时间/样本。未经这些验收的组合不得写入公开支持目录。

## 既有 240 题的离线核对

本仓库已经存在 2026-08-31 的 r5 与 legacy 同模型比较及签署。以下命令已在本地实际运行，输入保持不变；路径必须指向仓库内实际归档，不加载密钥、不调用模型、不上传：

```sh
node scripts/prepare-legacy-quality.mjs \
  --attestation objective-eval-output/2026-08-31T13-25-50.386Z-r5-vs-legacy-attestation.json \
  --treatment-jsonl objective-eval-output/2026-08-31T13-20-54.674Z.jsonl \
  --baseline-jsonl objective-eval-output/2026-08-31T13-06-26.590Z-legacy.jsonl \
  --out .release-evidence/2026-09-06/quality-legacy-r5-v3.json
```

输出路径不允许覆盖；如果准备文件已经存在，读取并核对该文件或使用新的明确版本路径。旁边的 `.provenance.json` 记录源摘要和限制。它是本地证据，不应打包进客户端或发布为用户数据。

转换器核验 attestation 引用的 comparison、treatment/baseline summary 字节摘要，读取当时 Git 提交中的 manifest，核对两组各 240 条唯一 ID、模型/提交、题型/语言及评分，重新计算原 summary 和相对比较。任何不一致直接失败，不能挑出失败行后继续归档。

历史导入仅生成 treatment 的 `legacy_regression/objective_v1/legacy_objective` 记录。支持声明为空、家族及开始时间未知；材料授权和独立真值审查不从旧签署内容中推断。复核为 `legacy_summary_only`，明确只绑定原始比较摘要，不能冒充对新转换逐题文件字节的独立签署。结果为 197/204（96.57%）且新范围证据不足，不代表 2.12 新阅读场景正确率。

## 上传与恢复

[`upload-quality-report.mjs`](../scripts/upload-quality-report.mjs) 必须通过环境显式提供 `NSPI_QUALITY_BASE_URL` 和 `NSPI_QUALITY_ADMIN_TOKEN`；目标只允许 HTTPS origin 或本机 HTTP origin，不接受路径、查询、URL 凭证或占位密钥。不要将真实密钥放进命令历史、文档或日志。由安全环境注入凭证后执行：

```sh
node scripts/upload-quality-report.mjs --file .release-evidence/2026-09-06/quality-legacy-r5-v3.json
```

工具上传前先校验字段/摘要/体积，15 秒超时，拒绝重定向，不自动重试；成功时核验服务端返回的确切内容摘要，只输出记录 ID、修订和目标 origin。网络中断时保持相同输入再次执行，以不可变 ID 核对是否已经入库。若执行版本确实改变，不得沿用原 run ID。

本周期只向 `http://127.0.0.1:18796` 的隔离 SQLite 上传过。最终本地修订为 3，报告 ID `9b03012f0c3ea43774c827652acf0446cf3bafdd2cb42d4ece25effcb007e345`；修订 1 是开发时的错误范围映射，已在本地记录撤回，不是生产撤回。服务器不存源题目，源数据尚未通过本接口对外分发。

## 尚未具备的评测条件

新 manifest 的完整执行、原始响应归档、离线重算及答案/解释独立复核入口已实现，见 [阅读评测操作说明](reading-evaluation.md)。授权留出集、独立家族/真值审查、隔离候选设备凭证和价格上界证据尚未取得；当前未执行真实新范围模型评测。此工具链不能生成这些证据，旧 240 题不能改名代替新增留出集。正式材料收取/撤回流程随 B21 完成，生产启用与真实评测分别记录。
