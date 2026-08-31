# NotchSPI 官方服务 — 客户端 HTTP 契约

客户端实现：`Sources/NotchSPI/Cloud/`。服务端路由：`server/src/routes.ts`。
默认基址为 `OfficialAPI.defaultBaseURL`，可用 `official.baseURL`（`defaults write` 或启动参数）覆盖。

**计费：** 账户余额是整数「题数」。一次成功截屏问答扣 1 题，失败不扣。
新设备注册赠随机试用题，区间 `[TRIAL_MIN_QUESTIONS, TRIAL_MAX_QUESTIONS]`；
`TRIAL_QUESTIONS` 只是对外宣传上限。金钱只出现在充值：题包价格字段 `amount_cents`
是**币种最小单位**（JPY 为日元整数，CNY/USD 为分）。

服务端代持厂商 API Key。客户端只持有匿名设备令牌。

DeepSeek 视觉候选的配置为 `OFFICIAL_PROVIDER=deepseek`、
`OFFICIAL_MODEL=deepseek-v4-flash-vision-exp`、`DEEPSEEK_BASE_URL=https://api.deepseek.com`；
密钥只通过 `DEEPSEEK_API_KEY` 注入运行环境。普通 DeepSeek 文本模型不接受截图，不能用于该通道。
该候选必须先通过固定 Objective 评测才可替换生产 Provider；Anthropic 与 OpenAI 继续保留为兼容路径。

通用约定：

- 认证：`Authorization: Bearer <device_token>`（除注册端点外）。
- 错误体：`{"error": {"message": "<兜底信息>", "code": "<错误码>"}}`。
  已知码：`insufficient_quota` / `invalid_token` / `bad_request` /
  `rate_limited` / `upstream_error` / `internal`。
- `401 invalid_token`：客户端**保留**设备令牌（已购题数的唯一凭证），只清空本地题数镜像。
- `402 insufficient_quota`：额度用完。
- `429 rate_limited`：注册频率或并发截图超限。

## 客户端遥测请求头

由 `server/src/auth.ts` 在 Bearer 鉴权时读取；写失败不得打断已付费请求：

| 头 | 值 | 作用 |
| --- | --- | --- |
| `x-app-version` | 客户端版本 | 更新 `devices.app_version`（仅变化时写） |
| `x-onboarded` | `1` | 标记引导完成 |
| `x-client-event` | `hotkey` | 热键按下计数（预热 ping；截图失败也算） |

`store.recordHotkeyPress` **只**由 `x-client-event: hotkey` 触发。

## GET /healthz — 无状态预热与健康检查

无需认证。客户端尚无设备令牌时，`warmUp()` 用此端点建立连接；本地启动脚本也用它
判定服务就绪。正常响应 200：

```json
{ "ok": true, "provider": "mock", "db": "sqlite", "payments": "stub", "webhook": "n/a" }
```

真实厂商被选中但密钥缺失时响应 503，`ok=false` 并附带 `provider_error`；不得将此状态
误报为健康。

## POST /v1/devices — 匿名设备注册

无需认证。首次注册赠随机试用题。重复调用允许（客户端只在本地无令牌时调用）。
按客户端 IP 限流（`DEVICE_REG_PER_HOUR`），超限 `429 rate_limited`。

请求：

```json
{ "platform": "macos", "app_version": "2.0" }
```

响应 200：

```json
{ "device_token": "dev_xxxxxxxx", "balance_questions": 142 }
```

`balance_questions` 以注册响应为准；客户端不猜测赠送区间。

## GET /v1/account — 题数与用量

响应 200：

```json
{
  "balance_questions": 172,
  "total_questions": 8,
  "total_input_tokens": 182000,
  "total_output_tokens": 45120,
  "cli_enabled": false
}
```

`total_*` 覆盖本地累计镜像。`cli_enabled` 由运营按设备打开后，客户端在下次账户同步时镜像。

## GET /v1/client-config — 稳定分桶配置

Bearer 鉴权。客户端启动与热键预热异步刷新，缓存 24 小时；失败使用 `control` 基础配置。服务端以
`HMAC-SHA256(OBJECTIVE_RESULT_EXPERIMENT_SALT, device_token)` 前 32 位 `% 10000` 稳定分桶。

```json
{
  "schema_version": 1,
  "revision": "2026-objective-v1-r1",
  "objective_result_v1": {"variant":"objective_v1","protocol":"objective_v1","prompt_variant":"objective_v1"},
  "telemetry": {"enabled":true,"max_batch_size":50,"max_queue_age_days":7}
}
```

## POST /v1/captures — 截图问答（SSE，1 题/次）

请求：

```json
{
  "system": "<系统提示词>",
  "task": "<用户消息文本>",
  "image_base64": "<JPEG base64>",
  "image_media_type": "image/jpeg",
  "stream": true
}
```

Objective V1 为可选扩展；旧客户端字段缺省时行为完全不变：

```json
{"result_protocol":"objective_v1","capture_id":"3e7979c6-20cb-4c12-a23e-ece6eb3aa52d"}
```

模型最后一行固定为 `NSPI_RESULT_V1: <strict JSON>`。`ready/review` 前一行必须为与
`answer` 规范化后一致的 `FINAL:`；`retake` 只输出机器行。合法 `ready/review` 或
`legacy_fallback` 扣 1 题；`retake`、无可用结果、供应商失败且没有已交付结果均释放预扣，
并在正常流末发送 `questions_charged: 0`。协议解析在 route 层统一完成，Provider 接口不变。

上下文追问（⌘⇧2）可追加 `images_base64`（有序：老上下文在前、新截图在后，单张上限与
`image_base64` 相同，数量上限 4，仍只扣 1 题）。该字段存在时优先；客户端同时把**最后一张**
放进 `image_base64`，旧服务端退化为单图：

```json
{
  "system": "…",
  "task": "…",
  "image_base64": "<新截图 base64>",
  "images_base64": ["<老上下文图 base64>", "<新截图 base64>"],
  "image_media_type": "image/jpeg",
  "stream": true
}
```

响应 `text/event-stream`：

```
data: {"type":"delta","text":"答案增量文本"}
data: {"type":"delta","text":"…"}
data: {"type":"usage","input_tokens":1200,"output_tokens":480,"questions_charged":1,"balance_questions":179}
data: [DONE]
```

- `usage` 在流结束前发出**一次**。
- 流出错或没有任何 `delta`：发送 `error` 事件后结束，**不扣题**。
- 请求前额度已用完：HTTP `402` `insufficient_quota`。
- 并发超过 `CAPTURE_CONCURRENCY_PER_TOKEN`：HTTP `429` `rate_limited`。
- 指定了真实厂商但 Key 为空：HTTP `503` `upstream_error`，不扣题。

扣题采用「预扣 — 结算」。客户端在收到足量答案后主动断开，这一题仍然计费。

## POST /v1/events/batch — 匿名可靠性事件

Bearer 鉴权，单批 1–50 条、解压后不超过 64 KiB、每设备默认每分钟 30 批。事件严格白名单，
逐条校验并以 `event_id` 幂等；部分非法不影响合法事件。响应始终不回显事件内容：

```json
{"accepted":1,"duplicate":0,"rejected":0}
```

服务端总开关关闭时返回 `202` 且不写入。事件仅包含捕获生命周期、固定结果枚举、耗时与动作，
不允许截图路径、题目、答案、Prompt 或原始错误文本。详细事件保留 90 天。

## GET /admin/metrics — 产品可靠性指标

`X-Admin-Token` 鉴权；范围默认 7 天、最大 90 天，可选 `variant=control|objective_v1`。
响应按分组聚合成功率、协议有效率、结果状态、深度、动作与 p50/p95，绝不返回设备令牌、题目、
答案或模型原文。

## GET /topup?device=\<token\>&lang=\<zh|ja|en\> — 题包购买页

客户端用系统浏览器打开。页面完成支付后，客户端点「刷新」走 `/v1/account`。

运营：Stripe webhook `POST /webhooks/stripe` 必须同时订阅
`checkout.session.completed` 与 `checkout.session.async_payment_succeeded`（延迟通知类支付在
`completed` 时可能仍为 unpaid）。入账以 Checkout Session id 为幂等键。

开发桩 `POST /topup/stub-complete` 只在本地显式 `ALLOW_STUB_TOPUP=1` 时存在；生产默认 404。

## GET /update — 最新版本

客户端检查更新。响应 `{ version, tag, notes }`，不暴露上游托管主机。

## GET /dl — 下载 DMG

客户端「前往下载」打开此地址；服务端流式代理内部产物源。

## 客户端行为摘要

- 额度拦截只作用于官方模式：本地已知题数 ≤ 0 时在截图前拦下；题数未知时放行，以服务端 `402` 为准。
- 自定义 API Key / 本机 CLI 不经过官方服务。
- 新安装引导内静默注册；老安装保持原通道。
