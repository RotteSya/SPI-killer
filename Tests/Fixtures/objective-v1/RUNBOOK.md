# Objective Result V1 发版评测与灰度 Runbook

## 1. 固定资产

- `manifest.json` 固定 240 题：4 题型 × 3 语言 × 20；每组合 14 `ready`、3 `review`、3 `retake`。
- `images/` 必须与 manifest 的 SHA-256 完全一致。重新生成只能显式运行
  `python3 scripts/generate-objective-fixtures.py`，生成后需重新人工审题。
- 普通 CI 只运行 manifest 完整性、图片摘要和 Swift/Node 协议测试，不产生模型费用。

## 2. 正式评测

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
export NSPI_EVAL_VARIANT=objective_v1
node scripts/run-objective-eval.mjs
```

固定 legacy 基线使用同一候选服务、模型和 240 张图片，只切换冻结 Prompt 与结果解析：

```sh
export NSPI_EVAL_VARIANT=legacy
export NSPI_EVAL_REGISTER_DEVICES=3
export NSPI_EVAL_TREATMENT_SUMMARY=objective-eval-output/<objective>-summary.json
export NSPI_EVAL_TREATMENT_JSONL=objective-eval-output/<objective>.jsonl
node scripts/run-objective-eval.mjs
```

`NSPI_EVAL_REGISTER_DEVICES` 仅允许 `1...4`，供隔离候选环境注册临时设备；生产环境不得使用。
每个设备先核对余额，再按轮询固定分配题目。legacy 运行会额外输出 `-comparison.json` 和
`-comparison.md`，自动执行正确率、平均 Token 和 p95 延迟三项相对闸门。Comparison 通过后仍需
独立复核者签署，不能由 runner 自动授权生产灰度。

若 candidate 是受 Vercel Deployment Protection 保护的 Preview，另设临时 share URL 中的
`_vercel_share` 值；runner 会交换 HttpOnly Cookie，Protection 必须保持开启：

```sh
export NSPI_EVAL_VERCEL_SHARE_TOKEN=<temporary-share-token>
```

自动化环境也可设置 `NSPI_EVAL_VERCEL_BYPASS_TOKEN`；两种访问凭证不得同时提供，且不得写入
评测 JSONL、日志或 Git。

Runner 对每张图片只调用一次，原始结果写入忽略跟踪的 `objective-eval-output/`。复核者只签署
已有评分；不得重跑失败题来挑选较好结果。正式归档只保留脱敏 JSONL 和 Markdown 摘要。

当前 r3 候选的脱敏归档是
[`objective-eval-output/2026-08-30T17-03-15.896Z.jsonl`](../../../objective-eval-output/2026-08-30T17-03-15.896Z.jsonl)
及其 `-summary.json` / `-summary.md`。自动绝对阈值已通过，RotteSya 已签署独立
[`attestation`](../../../objective-eval-output/2026-08-30T17-03-15.896Z-attestation.json)；固定基线
对比仍未包含在该签署中，在基线签署前不得据此开启生产灰度。

固定 legacy 基线已于 2026-08-31 在同一 240 题 manifest、同一模型和隔离候选服务上完成一次性运行。
原始记录经 `objective-semantic-v1` 统一重评分，以接受 `A and C (2, 5)` 这类选项与值同时出现的
语义等价格式；没有重跑任何题。归档见
[`legacy JSONL`](../../../objective-eval-output/2026-08-31T09-31-41.861Z-legacy.jsonl)、
[`semantic baseline`](../../../objective-eval-output/2026-08-31T09-31-41.861Z-semantic-baseline-summary.json) 和
[`comparison`](../../../objective-eval-output/2026-08-31T09-31-41.861Z-semantic-comparison.json)。
Comparison 当前为 **FAIL**：准确率提升 3.43 个百分点，但平均 Token 增加 43.47%，p95 延迟增加
57.16%。`OBJECTIVE_RESULT_V1_BPS` 必须保持 `0`，直到提示词/协议开销降至阈值内并完成新的固定评测。

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

Runner 强制绝对正确率阈值；Token、耗时和基线差异由评测摘要与上一份签署摘要对比后签署。

## 4. 灰度与回滚

所有者在完整验证和正式评测通过后按 `内部 → 5% → 25% → 100%` 推进。每档观察至少 72 小时，
且 treatment 捕获至少 200。协议无效率需 `<3%`，相对成功率下降 `<2pp`，p95 增幅 `≤10%`，
Token 增幅 `≤8%`，重复扣费、负余额、机器行泄露、白名单外事件必须均为 0。

出现重复扣费、负余额、机器行泄露、白名单外事件，或协议无效率连续 30 分钟 `>5%`、相对成功率
下降 `>5pp` 时，所有者立即设置：

```text
OBJECTIVE_RESULT_V1_BPS=0
```

客户端继续保留双解析，以安全完成在途或由 24 小时缓存配置启动的 V1 请求。
