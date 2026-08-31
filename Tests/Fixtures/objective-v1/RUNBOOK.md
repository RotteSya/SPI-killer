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
node scripts/run-objective-eval.mjs
```

若 candidate 是受 Vercel Deployment Protection 保护的 Preview，另设临时 share URL 中的
`_vercel_share` 值；runner 会交换 HttpOnly Cookie，Protection 必须保持开启：

```sh
export NSPI_EVAL_VERCEL_SHARE_TOKEN=<temporary-share-token>
```

Runner 对每张图片只调用一次，原始结果写入忽略跟踪的 `objective-eval-output/`。复核者只签署
已有评分；不得重跑失败题来挑选较好结果。正式归档只保留脱敏 JSONL 和 Markdown 摘要。

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
