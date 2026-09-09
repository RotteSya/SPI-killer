# Objective Result V1 发版评测与灰度 Runbook

## 1. 固定资产

- `manifest.json` 固定 240 题：4 题型 × 3 语言 × 20；每组合 14 `ready`、3 `review`、3 `retake`。
- `images/` 必须与 manifest 的 SHA-256 完全一致。重新生成只能显式运行
  `python3 scripts/generate-objective-fixtures.py`，生成后需重新人工审题。
- 普通 CI 只运行 manifest 完整性、图片摘要和 Swift/Node 协议测试，不产生模型费用。

## 2. 正式评测

付费前先执行 `node scripts/evaluation-preflight.mjs`。2026-09-06 本轮累计预算为 100 元人民币，
其授权、题库查找结果和成本上界字段见 [评测准备记录](../../../docs/evaluation-readiness.md)。
Objective 与 legacy runner 共用 `.eval-results/budget-ledger.sqlite3`，不得删除账本重置额度。
两入口均要求 `NSPI_EVAL_COST_BOUND` 指向已核验币种、价格及候选 token 限制的有效上界文件；
没有这些证据时不进行付费调用。该检查不替代题集授权或独立质量复核。

准备一个隔离的测试设备令牌和已部署的候选服务，随后设置：

```sh
export NSPI_RUN_OBJECTIVE_EVAL=1
export NSPI_EVAL_BASE_URL=https://candidate.example
export NSPI_EVAL_DEVICE_TOKEN=dev_...
export NSPI_EVAL_MODEL=provider:model
export NSPI_EVAL_COMMIT=<40-char commit>
export NSPI_EVAL_APP_VERSION=<version>
export NSPI_EVAL_EXECUTOR=<name>
export NSPI_EVAL_REVIEWER=<different name>
node scripts/run-objective-eval.mjs
```

若 candidate 是受 Vercel Deployment Protection 保护的 Preview，另设临时 share URL 中的
`_vercel_share` 值；runner 会交换 HttpOnly Cookie，Protection 必须保持开启：

```sh
export NSPI_EVAL_VERCEL_SHARE_TOKEN=<temporary-share-token>
```

Treatment 和 legacy baseline 现在共用有 15 秒期限的访问交换入口。Cookie 绑定同一 origin，过期、跨域重定向或访问失败均停止，不自动续期或重试；临时凭证不写入结果。

Runner 对每张图片只调用一次，原始结果写入忽略跟踪的 `objective-eval-output/`。复核者只签署
已有评分；不得重跑失败题来挑选较好结果。正式归档只保留脱敏 JSONL 和 Markdown 摘要。

DeepSeek `deepseek-v4-flash-vision-exp` 非思考候选的初始运行归档见
[`JSONL`](../../../objective-eval-output/2026-08-31T10-04-29.595Z.jsonl) 与
[`summary`](../../../objective-eval-output/2026-08-31T10-04-29.595Z-summary.md)。闸门为 **FAIL**：
V1 合法率 97.50%、`ready` 精确率 87.37%、排序题准确率 80.39%。低强度思考只做失败集合诊断，
平均耗时 12.6 秒，不能替代完整评测。

随后冻结的 Objective r5 运行归档见
[`JSONL`](../../../objective-eval-output/2026-08-31T13-20-54.674Z.jsonl) 与
[`summary`](../../../objective-eval-output/2026-08-31T13-20-54.674Z-summary.md)，固定 legacy 基线见
[`JSONL`](../../../objective-eval-output/2026-08-31T13-06-26.590Z-legacy.jsonl) 与
[`summary`](../../../objective-eval-output/2026-08-31T13-06-26.590Z-legacy-summary.md)。离线比较见
[`comparison`](../../../objective-eval-output/2026-08-31T13-25-50.386Z-r5-vs-legacy-comparison.md)：
绝对准确率 96.57%、V1/状态/retake 100%，相对基线准确率 +20.10pp、平均 Token +5.92%、
p95 -43.58%，自动阈值全部 **PASS**。比较器生成文件中的状态保留为不可变的
`pending_owner_review`；RotteSya 后续已签署独立
[`attestation`](../../../objective-eval-output/2026-08-31T13-25-50.386Z-r5-vs-legacy-attestation.json)，
其 SHA-256 固定比较及两份 summary。签署不等于自动授权生产变更，灰度仍由所有者按第 4 节执行。

当前 r3 候选的脱敏归档是
[`objective-eval-output/2026-08-30T17-03-15.896Z.jsonl`](../../../objective-eval-output/2026-08-30T17-03-15.896Z.jsonl)
及其 `-summary.json` / `-summary.md`。自动绝对阈值已通过，RotteSya 已签署独立
[`attestation`](../../../objective-eval-output/2026-08-30T17-03-15.896Z-attestation.json)；固定基线
对比仍未包含在该签署中，在基线签署前不得据此开启生产灰度。

## 3. 发版阈值

| 指标 | 阈值 |
|---|---:|
| V1 合法率 | ≥98% |
| 机器行 UI 泄露 | 0（由逐字符 parser 测试保证） |
| 可作答整体精确率 | ≥92% |
| 每题型 / 每语言精确率 | ≥85% |
| `ready` 精确率 | ≥97% |
| `retake` 召回率 | ≥90% |
| 相对固定基线正确率下降 | ≤1 个百分点 |
| 平均 Token 增幅 | ≤8% |
| p95 总耗时增幅 | ≤10% |

Runner 强制绝对正确率阈值。同模型 legacy 基线使用 `scripts/run-objective-legacy-baseline.mjs`；
已有不可变归档可用以下离线比较，不产生模型调用：

```sh
export NSPI_COMPARE_OBJECTIVE_EVALS=1
export NSPI_BASELINE_SUMMARY=objective-eval-output/<legacy>-summary.json
export NSPI_BASELINE_JSONL=objective-eval-output/<legacy>.jsonl
export NSPI_TREATMENT_SUMMARY=objective-eval-output/<objective>-summary.json
export NSPI_TREATMENT_JSONL=objective-eval-output/<objective>.jsonl
node scripts/compare-objective-evals.mjs
```

比较器验证模型、各自提交中的完整 fixture 集和 240 行记录，再执行准确率、Token 与 p95 阈值；
复核者只签署生成的比较结果。

## 4. 灰度与回滚

所有者在完整验证和正式评测通过后按 `内部 → 5% → 25% → 100%` 推进。每档观察至少 72 小时，
且 treatment 捕获至少 200。协议无效率需 `<3%`，相对成功率下降 `<2pp`，p95 增幅 `≤10%`，
Token 增幅 `≤8%`，重复扣费、负余额、机器行泄露、白名单外事件必须均为 0。

生产灰度期间 Provider 必须分 slot，避免 control 被实验模型污染：

```text
OFFICIAL_PROVIDER=anthropic
OBJECTIVE_RESULT_V1_PROVIDER=deepseek
OBJECTIVE_RESULT_V1_MODEL=deepseek-v4-flash-vision-exp
OBJECTIVE_RESULT_V1_BPS=0
```

`DEEPSEEK_API_KEY` 只存于服务端秘密环境。BPS 调到 5% 后，仅携带 `objective_v1` 的 treatment
请求走 DeepSeek；未携带协议的 control 与旧客户端始终走 Anthropic。到 100% 时旧客户端仍保留
control 兼容路径，不能仅因新客户端已全量就删除。

出现重复扣费、负余额、机器行泄露、白名单外事件，或协议无效率连续 30 分钟 `>5%`、相对成功率
下降 `>5pp` 时，所有者立即设置：

```text
OBJECTIVE_RESULT_V1_BPS=0
```

客户端继续保留双解析，以安全完成在途或由 24 小时缓存配置启动的 V1 请求。
