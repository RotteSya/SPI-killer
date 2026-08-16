# NotchSPI 官方服务 — 服务端 API 契约（v2 · 题数额度制）

客户端（`Sources/NotchSPI/Cloud/`）已按本契约实现完毕。服务端参考实现见
[`../server/`](../server/)（Node.js + TypeScript + Fastify；生产 Postgres，本地 SQLite / memory，`npm start` 开箱即跑）。
上线后无需改动客户端代码（默认地址 `https://notchspi-api.vercel.app`，可用
`defaults write com.rottesya.notchspi official.baseURL <url>` 指向测试环境）。

**计费模型：题数额度制。** 账户余额是整数「题数」；一次成功的截屏问答扣 1 题，
失败（网络/模型错误）不扣。新设备注册赠随机试用题，区间
`[TRIAL_MIN_QUESTIONS, TRIAL_MAX_QUESTIONS]`（默认 100–180）；`TRIAL_QUESTIONS` 只是对外宣传上限。
金钱只出现在充值环节 —— 充值页出售「题包」（题数 + 价格），客户端永远只看到题数。

服务端职责：代持真正的模型厂商 API Key、代理模型调用、按题计量、扣减题数、
处理题包购买（网页端）。客户端永远拿不到厂商 Key，只持有一个匿名设备令牌。

通用约定：

- 认证：`Authorization: Bearer <device_token>`（除注册端点外）。
- 错误响应体：`{"error": {"message": "<兜底信息>", "code": "<错误码>"}}`。
  客户端按 `code` 本地化已知错误（`insufficient_quota` / `invalid_token` /
  `bad_request` / `rate_limited` / `upstream_error` / `internal`），未知码显示 `message`。
- `401 invalid_token` 令牌无效：客户端**保留**设备令牌（它是已购题数的唯一凭证，
  瞬时 401 不得销毁），仅清空本地题数镜像并标记「凭证待确认」，在设置 →「账户与额度」
  提供二次确认的「重置服务凭证」。`402 insufficient_quota` 额度用完（客户端把本地题数
  镜像清零并引导充值）；`429 rate_limited` 请求过于频繁（注册频率或并发截图超限）。

## 客户端遥测请求头（经营数据，缺了会瞎）

由 `server/src/auth.ts` 在每次 Bearer 鉴权时读取，写失败不得打断已付费请求：

| 头 | 值 | 作用 |
| --- | --- | --- |
| `x-app-version` | 客户端版本，如 `2.9` | 更新 `devices.app_version`（仅在变化时写） |
| `x-onboarded` | `1` | 标记引导完成 |
| `x-client-event` | `hotkey` | 热键按下计数（走预热 ping，截图/额度失败也算） |

`store.recordHotkeyPress` **只**由 `x-client-event: hotkey` 触发，不在 `routes.ts` 里出现。

## POST /v1/devices — 匿名设备注册（开箱即用入口）

无需认证。首次注册赠送随机试用题数（默认 100–180）。重复调用允许（客户端只在本地无令牌时调用）。
为防止免费额度被脚本批量领取，本端点按客户端 IP 限流（`DEVICE_REG_PER_HOUR`，默认 30 次/小时），
超限返回 `429 rate_limited`。此为进程内尽力而为的限流，硬性保障应交由平台 WAF。

请求：

```json
{ "platform": "macos", "app_version": "2.0" }
```

响应 200：

```json
{ "device_token": "dev_xxxxxxxx", "balance_questions": 142 }
```

## GET /v1/account — 题数与用量查询

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

（客户端读取全部字段；`total_*` 会覆盖本地累计镜像，以服务端为准。Token 数只做
内部统计展示，不参与计费。`cli_enabled` 是按设备的 CLI 通道开关：默认 false，
运营在管理后台（POST /admin/cli，与手动加题同一套 ADMIN_TOKEN 鉴权）按设备码
开启后，客户端在下一次账户同步时镜像该值，设置 → 高级 才会出现「本机 CLI」选项。）

## POST /v1/captures — 截图问答（SSE 流式，1 题/次）

请求：

```json
{
  "system": "<系统提示词，客户端已按模式/深度/人物像构建好>",
  "task": "<用户消息文本>",
  "image_base64": "<JPEG base64>",
  "image_media_type": "image/jpeg",
  "stream": true
}
```

上下文追问（⌘⇧2，双图）追加可选字段 `images_base64`（有序数组：老上下文图在前、
新截图在后，单张上限与 `image_base64` 相同，数量上限 4，仍只扣 1 题）。该字段存在
时优先于 `image_base64`；客户端同时把**最后一张**（当前题目）放进 `image_base64`，
这样尚未升级的服务端也能退化为单图作答而不是拿错图：

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

服务端选择模型、调用厂商 API、成功后扣 1 题。响应为 `text/event-stream`，事件均为
`data: <json>` 行：

```
data: {"type":"delta","text":"答案增量文本"}
data: {"type":"delta","text":"…"}
data: {"type":"usage","input_tokens":1200,"output_tokens":480,"questions_charged":1,"balance_questions":179}
data: [DONE]
```

- `usage` 事件必须在流结束前发出**一次**，客户端据此更新本地题数镜像与累计用量。
- 流中出错，或模型返回空回答（没有任何 `delta` 文本）：发送
  `data: {"type":"error","error":{"message":"…","code":"…"}}` 后结束，**不扣题**
  —— 只有真正产出了答案文本才会扣 1 题。
- 请求前额度已用完：直接返回 HTTP `402`（响应体用通用错误格式，`code:
  "insufficient_quota"`）。
- 同一令牌并发截图超过 `CAPTURE_CONCURRENCY_PER_TOKEN`（默认 3）：返回 HTTP `429`
  `rate_limited`（在流开始前，仍是通用 JSON 错误格式）。
- 服务端未配置好模型厂商 Key（`OFFICIAL_PROVIDER` 指定了真实厂商但对应 Key 为空）：返回
  HTTP `503` `upstream_error`，**不扣题**。此时 `GET /healthz` 同样返回 503 并带
  `provider_error` 字段说明缺哪个变量。客户端无需特殊处理——`upstream_error` 是已知错误码。

**扣题时序（服务端实现约定）：** 采用「预扣 — 结算」。请求进入时用一条原子 SQL
（`WHERE balance_questions >= n`）先扣住 1 题，流结束后确认为答案则结算，失败则退回。
对客户端而言语义与「失败不扣题」完全一致，但并发请求无法把余额扣成负数。唯一的行为差异：
客户端在收到足量答案文本后主动断开连接，这一题仍然计费（答案已送达）。

## GET /topup?device=\<token\>&lang=\<zh|ja|en\> — 题包购买网页（非 API）

「充值」按钮用系统浏览器打开此地址；`lang` 由客户端传入其界面语言，页面据此本地化。
页面展示题包目录（`PACKS_JSON` 配置）并自行完成支付（生产接 Stripe / 支付宝 / 微信；
开发环境 `ALLOW_STUB_TOPUP=1` 时点击即入账）。到账后客户端点「刷新」即可通过
`/v1/account` 同步。

## 客户端行为摘要（便于服务端联调）

- 额度拦截只作用于官方模式：本地已知题数 ≤ 0 时在发起截图前拦下并引导充值；
  题数未知时放行，以服务端 `402` 为准。自定义 API Key / 本机 CLI 模式完全不经过
  官方服务，也不受拦截影响。
- 新安装引导流程内静默注册；老安装保持原有模式，不会被改路由。

## 非客户端契约端点（索引，细节以代码为准）

这些路径不是客户端 SDK 契约，只在此列目录，避免第二份会漂移的说明书：

| 方法 | 路径 | 一句话 | 锚点 |
| --- | --- | --- | --- |
| GET | `/` | 产品落地页 | `server/src/routes.ts` `app.get('/')` |
| GET | `/dl` | 流式代理 DMG | `app.get('/dl')` |
| GET | `/update` | 版本中继（客户端检查更新） | `app.get('/update')` |
| GET | `/stats` | 下载按钮点击计数 | `app.get('/stats')` |
| GET | `/healthz` | 健康检查 | `app.get('/healthz')` |
| POST | `/topup/checkout` | 创建 Stripe Checkout Session | `app.post('/topup/checkout')` |
| POST | `/webhooks/stripe` | Stripe 入账 webhook | `app.post('/webhooks/stripe')` |
| GET | `/admin` | 管理台（需 `ADMIN_TOKEN`） | `app.get('/admin')` |
| POST | `/admin/grant` | 手动加题 | `app.post('/admin/grant')` |
| GET | `/admin/activity` | 最近注册 / 充值 | `app.get('/admin/activity')` |
| POST | `/admin/cli` | 按设备开关 CLI 通道 | `app.post('/admin/cli')` |
