# NotchSPI 官方服务 — 客户端 HTTP 契约

兼容服务迁移暂停期间，新捕获、解释及恢复可返回 `503`、错误码 `service_maintenance` 和 `Retry-After: 60`，不会建立 capture 或调用模型。原请求的 status、结算和持有恢复继续；客户端不能据此自动重发收费 POST。数据库停流/校验/恢复和旧实例退出要求见 [迁移与兼容回退](quota-migration.md)。

客户端实现：`Sources/NotchSPI/Cloud/`。服务端路由：`server/src/routes.ts`。
默认基址为 `OfficialAPI.defaultBaseURL`，可用 `official.baseURL`（`defaults write` 或启动参数）覆盖。

**计费：** 账户余额是整数「题数」。一次成功截屏问答扣 1 题，失败不扣。
新设备注册一次性获得固定 30 题；服务端响应中的 `balance_questions` 是唯一准数，旧设备余额不会被重置。
金钱只出现在充值：题包价格字段 `amount_cents`
是**币种最小单位**（JPY 为日元整数，CNY/USD 为分）。

服务端代持厂商 API Key。客户端只持有匿名设备令牌。

DeepSeek 视觉候选通过独立 treatment slot 配置：
`OBJECTIVE_RESULT_V1_PROVIDER=deepseek`、
`OBJECTIVE_RESULT_V1_MODEL=deepseek-v4-flash-vision-exp`、
`DEEPSEEK_BASE_URL=https://api.deepseek.com`。密钥只通过 `DEEPSEEK_API_KEY` 注入运行环境。
未携带 `result_protocol` 的旧客户端和 control 流量继续走 `OFFICIAL_PROVIDER`；携带
`objective_v1` 的请求才走 treatment slot。普通 DeepSeek 文本模型不接受截图，不能用于该通道。
该候选的 Objective r5 自动绝对/相对闸门已通过，并由所有者通过独立 attestation 签署；归档见
评测 Runbook。生产灰度仍按内部、5%、25%、100% 闸门逐档授权。Anthropic 与 OpenAI 继续保留
为兼容路径。

通用约定：

- 认证：`Authorization: Bearer <device_token>`（除注册端点外）。
- 错误体：`{"error": {"message": "<兜底信息>", "code": "<错误码>"}}`。
  已知码：`insufficient_quota` / `invalid_token` / `bad_request` /
  `rate_limited` / `upstream_error` / `internal`。
- `401 invalid_token`：客户端**保留**设备令牌（已购题数的唯一凭证），只清空匹配当前账户的本地题数镜像。旧账户/旧服务的迟到 401 不修改新账户；较新的账户刷新已成功时，较早刷新返回的 401 不覆盖其状态。
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
{
  "ok": true,
  "provider": "mock",
  "objective_provider": "mock",
  "objective_provider_active": false,
  "db": "sqlite",
  "payments": "stub",
  "webhook": "n/a"
}
```

control 厂商被选中但密钥缺失时响应 503，`ok=false` 并附带 `provider_error`。当
`OBJECTIVE_RESULT_V1_BPS>0` 时，treatment 厂商缺少密钥也响应 503，并附带
`objective_provider_error`；BPS 为 0 时 treatment 错误不会阻断 control 捕获。错误字段只包含
配置项名称，不包含密钥值。

## POST /v1/devices — 匿名设备注册

无需认证。首次注册一次性赠送 30 题。同一 `registration_attempt_id` 的重试返回同一设备/令牌且不重复发放；未携带该字段的旧客户端保留原注册语义，不能宣称任意重复 POST 都幂等。
按客户端 IP 限流（`DEVICE_REG_PER_HOUR`），超限 `429 rate_limited`。

当前客户端只有在 Keychain 明确返回 item-not-found、且无旧明文设备令牌时才准备注册。读取失败、锁定/ACL 错误、无效存储值均要求重试，不能当作新设备。先在原 `official.registrationAttempt` 项保存 256-bit 随机值的 43 字符 base64url 编码，并核验读回，再发送 `registration_attempt_id`。响应丢失或 token 写入失败保留同一重试值；正式令牌核验保存后才移除重试项。注册在途的账户重置、凭证替换或服务变化会使响应失效，不覆盖后来账户。

请求：

```json
{ "platform": "macos", "app_version": "2.0" }
```

响应 200：

```json
{ "device_token": "dev_xxxxxxxx", "balance_questions": 30 }
```

`balance_questions` 以注册响应为准；客户端不猜测赠送区间。

注册写入完成后若有并发持有、结算或充值，响应中的 `balance_questions` 与 `balance_version` 均取自同一份最新 quota 快照，不把 registerDevice 返回时的旧余额配上新版本。暂时无法取得快照返回 503，保留原重试凭证；不返回伪造的初始余额。

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

服务端先完成鉴权、客户端版本/引导诊断及过期持有恢复，再调用 `BillingStore.accountSnapshot`。SQLite 在同一同步事务内读取，PostgreSQL 以设备行锁保护 devices 与 lots 的一致读取，Memory 在无 await 的同一执行段复制。响应的余额、版本、held、分项、累计用量和 CLI 均来自该快照，不能混用此前鉴权读取的 Account。账户消失返回 401，读取失败返回一般服务错误；非法计数、超出 JavaScript 安全整数范围的计数或非法权限拒绝输出。余额版本仍为精确十进制字符串，可超过 2^53。所有成功账户响应保持 no-store；没有新增字段或数据库迁移。

当前客户端在发起时冻结设备、服务、身份 generation 和刷新序列，响应在主线程提交时重新核验。余额/版本、CLI 和总量作为同一响应整体应用；旧请求不能覆盖较新成功刷新，旧 `balance_version` 不能只覆盖权限或总量。版本比较保持十进制整数精度。服务端总量可纠正本地偏高估计，不能用永久取最大值掩盖差异；已进入版本化镜像后，缺版本的旧响应不覆盖它。

注册、账户刷新及购买交接只接收最多 64 KiB、`application/json` 的完整响应；非法类型、负数、非法版本或超限正文在任何镜像/凭证写入前拒绝。重定向不会继续发送请求。缓存使用地址和令牌的 SHA-256 摘要绑定；新设备/地址显示未知余额直到核验，并清理旧账户的 CLI/累计镜像，实际服务端额度不因此改变。

显式重置失败时不继续重新领取。购买交接响应携带仅本地存在的账户绑定，返回时及设置页真正打开浏览器前分别核验；该绑定不进入 HTTP 响应或遥测。Keychain 状态判断依据 Apple 的 [SecItemCopyMatching](https://developer.apple.com/documentation/security/secitemcopymatching(_:_:)) 和 [errSecInteractionNotAllowed](https://developer.apple.com/documentation/security/errsecinteractionnotallowed) 定义；没有把不可读取解释为项目不存在。

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
服务端以 `result_protocol` 选择 Provider slot：缺省走 `OFFICIAL_PROVIDER/OFFICIAL_MODEL`，
`objective_v1` 走 `OBJECTIVE_RESULT_V1_PROVIDER/OBJECTIVE_RESULT_V1_MODEL`。treatment 配置缺省时
完整继承 control，因此旧部署行为不变；任一 slot 配置错误只拒绝选中该 slot 的请求且不预扣。

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

data: {"type":"usage","input_tokens":1200,"output_tokens":480,"questions_charged":1,"balance_questions":29}

data: [DONE]

```

- `usage` 在流结束前发出**一次**。
- 没有有效结果的生成失败：结算确认为释放后发送 `error`、`usage(0)`、`DONE`；无法确认持久化终态时中断连接，由 status/reaper 核对。
- 请求前额度已用完：HTTP `402` `insufficient_quota`。
- 并发超过 `CAPTURE_CONCURRENCY_PER_TOKEN`：HTTP `429` `rate_limited`。
- 指定了真实厂商但 Key 为空：HTTP `503` `upstream_error`，不扣题。

启用 `screen_query_v1` 时，客户端必须同时发送 `capture_id`、`result_protocol=objective_v1`、
`response_contract=screen_query_v1`、已放行的 `profile_id/profile_version/prompt_version` 和
单目标 `scope`。服务端会重建官方提示词，不接受客户端覆盖 `system/task`；未放行的 profile
返回 `503 feature_disabled`。范围外或多目标由 `NSPI_NO_RESULT_V1` 终止且不扣题。

新合约主查题及 explain/recover 在任何预扣、预算持有或模型调用之前验证所有图片：严格规范 base64
（单张最多 8 Mi 字符）、仅静态 JPEG/PNG、实际格式匹配、完整容器/PNG CRC、完整像素解码及
最多 16,000,000 像素。拒绝动画 PNG、拼接图片、损坏像素、截断或超限尺寸，返回 `422 invalid_image`。
摘要取原始解码文件字节，不重编码、不缩图。旧合约保留原有格式接收与指纹语义。

采用固定版本 sharp/libvips，关闭操作缓存；同一请求按图片顺序验证，进程内最多两个解码任务，
容量已满立即 `503 rate_limited`，不建立无界等待队列。libvips 的像素处理时限为每图 5 秒，
不包含 libuv 等待时间，不能据此宣称整个 HTTP 请求固定在 5 秒内完成。正式环境仍需验证运行平台、
入口 body limit 和整体资源预算。原生依赖随 lockfile 安装，部署不可忽略 optional dependencies。

客户端使用 `OfficialStreamDecoder` 按 SSE 空行分帧，支持 LF/CRLF/CR、UTF-8 跨网络分块、首行 BOM、
注释及多行 data。事件上限 512 KiB、完整流 4 MiB、解码后的总正文 64 KiB；超限即失败，不截短成可用答案。
usage 数值必须具有正确类型且非负，收费为 0/1；请求 ID、操作、版本与结算状态必须一致，新合约须有完整
`SettlementSnapshot`。拒绝非法 JSON、未知事件、重复 usage、usage 后追加正文/错误或提前 DONE。
旧服务端可以省略新回执字段，但仍须提供合法的基础 usage 和完整 DONE。

当前服务端的全部 usage 回执、status 与同 ID 重复请求结算元数据均包含
`account_totals: { questions, input_tokens, output_tokens }`。三个非负整数是服务端账户累计 solve
计数，与同一响应的 `balance_questions` / `balance_version` 来自同一设备锁和事务。
usage 顶层 token 是本次调用用量；解释/恢复尝试不增加账户 solve 计数，相关真实费用仍在尝试账本中。
`finish` 在结算事务内返回完整快照，不再结算后另读余额拼接累计量。

客户端按账户身份和余额版本整体替换 `account_totals`，同一回执重复到达不重复累计，较旧回执不能回退
余额或计数。不得把顶层 token / questions_charged 再加到已刷新过的账户累计量。累计组存在时必须完整，
类型/范围正确，并带有效余额版本；缺失或 null 表示旧服务没有提供累计快照，客户端保留现有计数并发起
有界 `GET /v1/account`。此刷新在启动和提交时均核验原账户身份；失败保留已知镜像，账户页仍可手动刷新。
兼容策略不改变 `INV-DEPLOY-001`：服务端新字段先于客户端发版。

保留的父请求在客户端绑定至发起时的设备、base URL 和身份 generation。解释、恢复及账单补查使用该身份；
当前身份已更换则不发请求，在途旧状态响应不能更新新账户。`CaptureEnvironment.connected` 同样冻结创建时的
身份，不在稍后 dispatch 时改用新凭证。NotchController 另按目标/模式/实际通道选择校验回调，清理题组时使
旧 generation 失效并取消官方任务与补查。首次注册前保存的本地正文只允许在同一选择下绑定至本次注册确认
的账号；已有账号之间不能转移，15 分钟到期材料也不能恢复。

合法 usage 可更新本机账本镜像；完整收到 DONE 才能确认传输完成。网络错误、截断或协议错误不会被忽略，
未完成时只读取原 capture 的 status，不重新 POST。已结算的 status 不代表答案完整送达；失败路径保留原请求供恢复。
任务取消不启动额外状态查询，账号/服务地址已经变化时不把旧回执写入当前余额。本机累计用量在整数溢出时饱和，
余额仍由带版本的服务端快照决定。

扣题采用「预扣 — 结算」。客户端在收到足量答案后主动断开，这一题仍然计费。

## GET /v1/captures/:id/status — 结算状态

Bearer 鉴权且只能读取本设备的元数据。响应包含 `settlement_status`、`terminal_state`、
`questions_charged`、`balance_version` 与可用结果标记，不返回截图、答案或模型原文。处理中请求
返回 `held`，客户端在连接中断或超时后应查询此端点；过期持有由恢复任务释放。
`settled` 仅用于收费 solve，`questions_charged=1` 且 `terminal_state=usable`。
explain/recover 终态为 `settlement_status=not_required`、`questions_charged=0`，其
`usable_result` 表示该辅助调用是否交付结果，不进入新的 solve 成功计数。未确认的
`held` 状态 `questions_charged=null`，不能显示为免费。

## POST /v1/captures/:id/explanation — 按需解释

仅接受服务端已结算且可用的 `screen_query_v1` 父请求，在材料保留期内每个父请求最多调用一次。
解释本身不扣题，失败保留原答案；请求体中的图片、范围、语言与 profile 绑定必须和父请求一致。

路径 `:id` 始终为原收费 solve。可选 `answer_capture_id` 指定当前显示的答案：省略或等于 `:id` 时核验
原 solve 的答案 HMAC；指定恢复子请求时，必须为同设备、原父记录明确关联、已经完成且可用的直接 recover。
同时核对原材料 HMAC、密钥版本、profile/prompt/result contract 和 config revision；`final_answer` 与选中答案
HMAC 比较。未知、其他父链、尚在运行、失败或绑定不一致的子请求返回 409，非法 selector 返回 422。
恢复接口不接受此 selector。

`answerCaptureId` 作为可选 capture 元数据持久化，解释的 `parentCaptureId`、成本归属和
`explanation_requests.parent_request_id` 仍为原收费请求；原答案和恢复答案争用同一事务名额，失败也不能
从另一个答案再领一次。期限从原父请求创建时间算起，恢复不延长 15 分钟窗口。旧元数据缺该字段仍指原答案；
旧请求省略 selector 时保持原 HMAC 格式，重试不会因升级而改成新请求。

## POST /v1/captures/:id/recovery — 结果恢复

用于连接中断后恢复同一父请求的答案，仍受材料保留期、原模型策略和成本预算限制。恢复失败会在
同一结算事务中追加一笔唯一的 goodwill 题数补偿，不能重复领取，也不等同于现金退款。
恢复成功返回完整、已验证的 Objective V1/兼容 FINAL 响应，保留子请求自己的答案 HMAC、
解析路径及结果状态。父请求账单保持不变，解释次数仍绑定原父请求。恢复进程终止时，过期
恢复器也执行同一笔唯一补偿；迟到回调不能撤销补偿或复活请求。辅助调用仅在终态持久化后
发送可用内容与 usage；持久化不可确认时返回 `internal` 并关闭流，不声称确定扣题结果。

solve/recover 的 usage 仅在功能仍开放、原收费请求未使用解释名额且未过期时返回
`explanation_available=true`，`explanation_expires_at` 始终是原父请求的截止时间。客户端冻结当前可见答案的
capture ID，通过原收费路径携带 `answer_capture_id` 请求解释；完整答案收到且服务端明确允许后才显示入口。
缺 capability 的旧服务器、非法 capability、截断正文或仅有结算回执不会开启恢复答案的解释入口。
新字段遵守服务端先发的部署顺序；此修改无新增数据库列或表。

## GET /api/internal/reap — 独立调度的过期恢复

调度器使用独立 `Authorization: Bearer <CRON_SECRET>`，不能使用设备或管理员凭证替代。
未配置返回 404，凭证不符返回 401。每次最多处理 1,000 项、每个事务最多 100 项，
批次间检查 20 秒预算；返回 `processed/checked_at/more_possible`，不返回设备或题目内容。
并发调度与正常结算由设备锁和终态条件保护，重放不重复释放或补偿。
在批次开始仍有预算时另取最多 5 个待核对退款、3 个待处理 Checkout，各组并发执行有超时的
供应商读取。返回 `refunds_reconciled/refunds_failed` 和
`checkouts_credited/checkouts_review/checkouts_failed`；Checkout 计数只记录本次取得处理权的结果。
前述处理后若仍有启动预算，再最多并发重核 3 笔订单的财务资源，返回
`finance_reconciled/finance_failed`。计数指资源快照读取与持久化，不代表完整费用或最终拒付已知。
本接口也执行 90 天事件清理并返回 `events_pruned`。金额不符等审查状态须走管理员核对，
不由调度器反复尝试；临时缺依赖/读取失败的 Checkout 延后 60 秒，累计五次处理后停在 review。

Vercel 配置按每分钟调用该路径，独立于进程内计时器；正式环境需核验支持分钟调度的套餐、
配置 `CRON_SECRET` 并验证真实调度日志。官方行为说明见
[Vercel Cron 安全与运行规则](https://vercel.com/docs/cron-jobs/manage-cron-jobs) 及
[调度频率限制](https://vercel.com/docs/cron-jobs/usage-and-pricing)。本地计时器和 status 查询
仍可触发恢复，不替代生产的独立调度证据。

## 正式模型准入与预算

客户端执行 `OfficialAPI.run` 时冻结设备凭证与服务地址。delta、usage、401 拒绝标记、状态
补查余额以及最终成功回调在主线程实际执行时重新检查取消和该归属；迟到的旧账号响应不得
更新当前状态。补查始终 GET 原请求 ID，不自动重复 POST。status 必须为最多 64 KiB 的
`application/json`，ID 和 operation 均与请求匹配；终态一致性另外校验。收到已结算状态不等于
完整收到答案。异常退出、达到读取上限或读到终止事件时显式取消对应 `AsyncBytes.task`，
避免未消费响应继续传输；这是 Apple 提供的[传输任务接口](https://developer.apple.com/documentation/foundation/urlsession/asyncbytes/task)。

官方客户端最终 JSON 限制为 **4 MiB**，为已核验的 [Vercel 4.5 MB 入口](https://vercel.com/docs/functions/limitations)
保留余量。本机读取在 base64 编码前限制普通文件，按编码后的长度预算全部图片，多个材料时
还计入兼容字段重复的最后一张题图；单图原字节最多 3 MiB，完整 JSON 仍须复核。序列化不
额外转义斜杠，避免放大 base64。空文件、目录、符号链接和管道仍拒绝。原顺序、字节和图片
质量保持不变；此读取器不宣称验证像素内容。超限在 HTTP 前结束，不隐式压缩或丢页。

Vercel 模式 Fastify parser 上限为 **4,500,000 字节**；self-hosted 仍为 16 MiB，不能据此宣称
官方入口可收 16 MiB。无论 Content-Length 还是 chunked body，超限均在鉴权/模型之前返回
`413 payload_too_large`。平台提前返回的非 JSON 413 也映射为客户端三语框选/减少材料提示；
不自动 POST 重试或发起结算补查。

正式持久存储模式要求 fixed30、真实 control/treatment provider、已知价格与版本、记账币种、
正整数每日预算及单次预留上界。缺失条件会在启动时拒绝。两个模型 slot 和 solve/explain/recover
共享同一官方每日预算，不按模型各领取一份预算。预算持有绑定所属设备，其他设备不能释放或
结算。实际超支完整入账；无 usage 或未知费用保持预留上界，不记为零。SQLite 的余额版本
以 bigint 读取、十进制字符串传输，避免超过 JavaScript 安全整数后舍入。

solve/explain/recover 从鉴权前监听连接关闭，解码、预算预留、额度持有及尝试记录之后均检查
取消，已关闭的请求不会继续启动模型。三者共享设备并发限制。预算预留或持有事务抛错也执行
清理；提交回执丢失时以服务端私有 requestId 回查归属，客户端不能指定该标识，重复请求不会
释放另一执行者的持有。仅当确认没有调用供应商时，已有尝试记录才写零 tokens/费用并释放预算；
模型已启动但未报告 usage 时仍记未知费用并保留上界。恢复子请求一旦成功创建而最终失败，仍
按原约定至多补偿一次 goodwill。数据库不可用导致清理失败时记录待核对，不能承诺已释放；
后续持有恢复任务和费用核对仍是正式部署的必需项。

## POST /v1/events/batch — 匿名可靠性事件

Bearer 鉴权，单批 1–50 条、解压后不超过 64 KiB、每设备默认每分钟 30 批。事件严格白名单，
逐条校验并以 `event_id` 幂等；部分非法不影响合法事件。响应始终不回显事件内容：

```json
{"accepted":1,"duplicate":0,"rejected":0}
```

服务端总开关关闭时返回 `202` 且不写入。事件仅包含捕获生命周期、固定结果枚举、耗时与动作，
不允许截图路径、题目、答案、Prompt 或原始错误文本。详细事件保留 90 天。

批次 `schema_version` 支持 1（旧客户端）和 2。schema 2 每条必须有非负且不超过 10^9 的
`consent_epoch`、`event_sequence`，先同步以下观察偏好。序列在同一设备和同意版本内唯一，
从 0 递增；UUID 规范化为小写。相同 event_id 的同内容重发计 duplicate，变更正文或复用序列计 rejected。
新事件必须属于当前开启的同意版本且发生时间不早于其 valid_from；已关闭版本不补写新行为。

schema 2 白名单另包括 `profile_id=spi|reading_practice|general`、
`profile_version=screen-query-v1-r1`、`source_group=spi_entry|reading_practice_entry|direct|unknown`、
`source_method=self_reported|attributed|unknown`、`session_id` UUID、`queue_drop_count` 有界整数，
以及 `operation=solve|explain|recover`。`capture_completed` 必须明确 capture_id、usable_result boolean、
completion_kind=usable|retake|no_result|failed|canceled 和 operation。usable_result=true 只接受
tutor/非 hint/solve/无错误的 ready 或 review V1，或明确 legacy_fallback。动作不会增加成功 solve。
业务完成按 `(device_id,capture_id)` 去重，不用 event_id 数量代替。

新客户端官方 screen_query 流的 usage 包含与 status 一致的 capture_id、operation、terminal_state、
settlement_status、questions_charged、usable_result、balance_questions、held_questions、十进制字符串
balance_version、can_retry/can_recover。服务端仅在终态已提交时发送；客户端验证 ID 和结算组合。
仅有 delta 或 DONE 不构成客户端可用交付证据；解释/恢复的 charge 为 0，结算状态为 not_required。

## GET /v1/device-observation 与 POST /v1/device-observation

Bearer 鉴权、`Cache-Control: no-store`。GET 返回 server_time（UTC ISO 8601）、telemetry_enabled
和 preference（尚无记录时为 null）。POST 每设备每分钟最多 30 次，JSON 不超过 4 KiB；
顶层仅允许 schema_version=1 与 preference、coverage 其中一个字段。

preference 仅含 consent_epoch、sharing_enabled boolean、valid_from UTC 时间。版本不可覆写，
相邻版本的生效时间必须有序；相同版本相同内容重发安全。冲突返回 409，成功返回 200；均返回
accepted、server_time 和当前最高版本 preference，供客户端核对离线修改或恢复既有关闭偏好。
偏好属于必要的服务状态；关闭共享只同步此元数据，不生成退出事件或补发产品事件。

coverage 含 observation_id（UUID v4）、consent_epoch、valid_from/to、sequence_from/to、
queue_drop_count、coverage_status=complete|partial|unknown|telemetry_disabled、gap_reason。
序列范围为半开区间；时间跨度最多 7 天，valid_to 不早于当前 7 天、不晚于当前 5 分钟。
声明 complete 的序列跨度最多 10,000；更大的离线缺口只能声明非 complete。
服务端验证偏好有效区间、全部序列回执及事件发生时间后，才保留 complete；丢弃、拒收、重启、
时钟、未同步偏好、缺序列、存储问题或服务总开关均保留为 partial/unknown 等明确状态。
gap_reason 白名单为 none、queue_drop、invalid_time、unsupported_schema、preference_unsynced、
queue_pending、client_restart、storage_failure、event_rejected、sequence_gap、server_disabled。
响应为 `{accepted:true,coverage:…}`；同 observation_id 重试返回原核验结果，变更区间返回 409。

客户端将事件队列、序列和待确认覆盖放在同一个 0600 原子文件中，队列仍为 7 天/100 条。
关闭立即清空队列和行为标识，取消上传；迟到响应不能修改重新开启后的队列。覆盖声明必须等
事件收到回执后生成。无覆盖证据的窗口保持未知，不能把无事件直接解释为流失。
事件、序列回执及覆盖摘要按接收时间清理 90 天前记录；独立 /api/internal/reap 和本地 worker
均执行清理，无需等待下一个产品事件。偏好历史保留为服务版本，计费/付款账本不受遥测开关影响。

## GET /admin/metrics — 产品可靠性指标

`X-Admin-Token` 鉴权；范围默认 7 天、最大 90 天，可选 `variant=control|objective_v1`。
响应按分组聚合成功率、协议有效率、结果状态、深度、动作与 p50/p95，绝不返回设备令牌、题目、
答案或模型原文。

## GET /admin/cohorts 与 GET /admin/economics

管理员鉴权、no-store；只返回聚合数据、`definition_version=cohort-economics-v3`、完整 query
和 revision SHA-256，不返回 bearer、请求 HMAC 或内容。revision 标识输入事实与定义，不代表已归档。

共同参数为 cohort_from/to、as_of、可选 source、policy_version。使用 UTC ISO 时间或 UTC 日期
简写；非法日历、无时区或未来 as_of 拒绝。注册窗口为半开区间、最长 90 天，cohort_to≤as_of。
默认 as_of 为当前时间，cohort_from/to 为其前 60/28 天。source 只取明确自报记录，缺失为 unknown。
内部设备按查询时的可信管理员分类排除，分类修正会改变 revision。

cohorts 另支持 channel=official|custom_key|cli|mixed 和 profile=spi|reading_practice|general。
默认按三个通道分别返回，mixed 才跨通道按设备和 UTC 日期去重。source/policy 选择注册批次；
profile/channel 只筛选客户端 solve，不移除未激活/未付费注册设备。economics 拒绝 profile/channel，
始终包含该注册批次全部服务尝试，避免筛掉失败和辅助调用。

| 字段 | 定义与不确定性 |
|---|---|
| activation28 | 全部已满 28 天注册为分母；已确认可用交付为分子，下界解释。另列 confirmed_inactive、unknown_without_confirmed_activation、observed_only |
| repeat28 | 首次成功起 28 天半开窗口，至少 3 个不同 UTC 日期。注册至首次成功及后续窗口均需完整覆盖；列成熟、完整、partial、unknown、disabled、未成熟与首次成功来源未知；窗口结束再等 7 天进入 frozen 子集 |
| p28 | 同一成熟注册分母，含未耗尽免费额度者；窗口内确认付款截至 as_of 净额仍正才计分子。pending 退款不当作成功，全额退款/拒付/未知付款分列 |
| post_trial_exhaustion | 辅助视图，以 trial lot 真实结算时刻为准，列耗尽/注册人数、耗尽后付款及跟进时长，不能替代 P28 |
| operational_activation28 | 服务端已结算 solve 的独立确认事实，不能与客户端交付相加 |

每个比例含分子、分母、Wilson 95% 区间；空分母返回 null。发生时间归属窗口，接收时间决定
截至 as_of 是否已知。冲突的重复完成排除；无覆盖证据不当作流失，也不默认完整。

economics 按币种分行，最小货币单位与 micros 为十进制字符串，除法返回精确的
`{numerator,denominator}`。没有汇率记录时不合并币种；本服务已知 JPY/USD/CNY 最小单位规则，
其他币种的贡献在缺少单位规则时为 null，此规则不是外币换算。

推理成本包括 solve、explain、recover 和失败尝试。未知成本返回 null、已知小计、记录中缺失
比例及已预留预算上界；上界来源明确为 configured attempt reservation，不冒称厂商结算。
旧 usage 缺少币种时列 currency=null，不猜币种。旧账本未完整记录的尝试使 legacy 批次的完整
成本和上界保持未知。历史付款缺少退款资源关联时，确认收款仍列出，净收款保持未知。

`economics.unallocated_receipts` 独立汇总已签名、已付款但尚未归入订单的 Checkout 收据，
按实际收据投影时间 `[cohort_from, as_of]` 读取。同一 Checkout 或 PaymentIntent 的连通组只
算一组；与截止时间前的全账户订单及历史充值核对，不受当前注册批次筛选限制。已核验入账且
现有财务事实一致的收据排除；金额、币种、付款资源或设备归属冲突保持 unresolved。

- `cohort_uncredited`：身份确定且属于所选注册批次的待入账款项。
- `account_unassigned`：尚不能确认设备归属的账户级款项；即使注册分母为空也显示。不归入某个
  来源、政策或 P28，不能把各来源返回的账户池相加。
- 两组各列 `payment_groups / receipt_deliveries / conflicts / incomplete /
  legacy_timing_unknown_groups / unknown_currency_groups`，币种分行。`confirmed_gross_minor`
  只计证据完整且无冲突的毛收款小计；`unresolved_groups` 保留同币种未知部分；`net_minor`
  始终为 null，尚未核验相关退款与费用。内部设备已知款项排除，内部与外部身份冲突不能排除。
- `other_registered_devices_pending` 单列其他已识别设备的待核对组数；
  `credited_groups_excluded` 表示已入账排除组数。以上是收据核对窗口读数，不是新增订单收款。

已识别成熟设备的注册后 28 天内待入账付款只增加 P28 的未知设备数；已有确认正净额付款的设备
仍只计一次已确认分子。收据毛额不能加到订单现金或额度。所选批次及账户未分配池中的待核对
收据若可能影响某币种，贡献的 `incomplete_inputs` 包含 `unallocated_paid_receipts`，贡献及各
履约情景贡献保持 null；已分配订单的现金小计仍独立显示。币种冲突或缺失不能假定没有影响。

收据快照不读取当前可变的审核状态倒推过去。设备及 sealed purchase 只有在投递前已创建才能
用于归属；后来的投递不会改变更早 as_of 的事实。`checkout_deliveries.recorded_at` 由投影事务
写入，不沿用可能早于实际处理的 webhook 接收时间。现有 SQLite/Postgres 数据库启动时增量
加 nullable 列和索引；旧 NULL 行仅按 webhook 接收时间选入待核对范围，显式标记时间未知，
不回填时间或贡献已确认毛额。此迁移尚未在生产数据库执行。

paid remaining 由授予、截至 as_of 的 settled reservation 与退款撤回修订重建，包含 held，
不用当前总余额倒推。分别返回 0%、成熟 paid lot 历史消耗比例、100% 履约情景，附 lot/设备数；
历史比例只作描述性敏感性，不称最可能利润。trial 独立列出；legacy_unknown 给区间，无历史
lot 的设备使全量 paid 上界为 null。退款资源按截止时间前的最新 generation 计算，后续贡献不再
重复减退款。没有费用记录不是零；贡献只在同币种净收款、全部成本、付款费用和服务支出齐全时
计算，获客费用再独立扣除。这是运营估计，不是财务收入确认。

Postgres 使用 REPEATABLE READ / READ ONLY；SQLite 使用一致事务。超过 10,000 设备或任一
事实表 200,000 行返回 413，要求缩小注册批次，不截断后返回比例。详细记录按 90 天清理；注册
起始早于当前时间减 90 天的实时查询返回 410 / report_details_expired，历史读数须从已有归档检索。

## /admin/payments/finance — 费用与拒付资源核对

以下端点要求 `X-Admin-Token`，使用 no-store；Admin 未配置时 404。

- `GET /admin/payments/finance?reference=cs_...`：精确订单引用，返回 `job / revision`，尚无记录为
  null。job 包括 generation、通知 watermark、租约、下一次读取、尝试数及状态；revision 包括
  读取起始/记录时间、SHA-256、最小财务快照及 `dirty`，不返回客户、卡片、证据或 metadata。
- `POST /admin/payments/finance/reconcile`：最多 4 KiB，只接受 `{reference}`。读取供应商并经
  generation 核验后返回 `{applied,job,revision}`；活跃租约/不存在订单为 applied=false，不抢占
  其他 worker；读取或验证失败为 503。仅 Stripe 模式可执行，每分钟最多 12 次管理员重核。
  此接口不创建付款、不发退款、不提供自填金额或改写快照的入口。

`stripe-finance.ts` 按订单已有的 PaymentIntent 列出 Charges、Refunds、Disputes；只有 charge
绑定的历史订单直接读取 Charge，并按 charge 筛选后两个列表。Charges 展开 balance_transaction，
Refunds 展开 balance_transaction / failure_balance_transaction；Disputes 使用余额交易数组。
三个请求共用 8 秒期限，每个响应最多 1 MiB，严格 JSON/UTF-8、禁止重定向、结束或任一失败后取消
其他传输。每个列表最多 100 项且必须 has_more=false；缺页、未展开交易、资源/金额冲突均不能
作为完整读数保存。权限不足或超出上限会留下可重试/人工 review 的任务，不截断后冒称全量。

`finance_notices / finance_notice_links` 保存签名通知的最小身份、摘要与单调序列；
`finance_jobs` 保存订单级 generation、30 秒租约、重试及调度；`finance_order_links` 约束每个
Charge/Refund/Dispute/BalanceTransaction 只属于一笔订单；`finance_revisions` 追加不可变快照。
`finance_state` 只分配通知版本。新增表和索引在 SQLite/Postgres schema 初始化时创建，已在本机
测试，尚未生产迁移；没有回填猜测费用。SQL 资源关联每 250 项批量写入/核验，报表读取在原一致
事务内，最多 10,000 份快照、32 MiB 快照正文、200,000 个资源；超限返回报告 413。

新订单即使没有财务通知也会被发现。日常完整读取后 24 小时再核对；缺失/未决资源五分钟后重核；
失败一分钟后重试，第五次失败进入 review。新相关通知或管理员操作可再次启动；重复事件不会
增加版本或费用。开始读取时冻结通知 watermark，新通知在读取期间到达会把快照标 dirty，停止
完整净额与贡献，等待下一次读取。过期或被新 generation 替代的 worker 不得提交；强制重核中断
后按租约恢复，不沿用旧的每日等待时间。快照读取校验 digest，损坏记录不会静默进入报表。

v3 报告的 `finance_reconciliation` 列出已读取资源订单/全部订单、新通知待重核、退款账本不匹配、
未决拒付数及最近读取时间。只对该注册批次可归属的订单计算，内部设备继续排除。资源费用是
唯一 BalanceTransaction 的 fee，以及 reporting_category=fee 的独立费用本金；费用返还保留
负数。拒付本金仅取 lost 的 dispute/dispute_reversal 余额交易净撤出；won、warning_closed 或
prevented 应无剩余撤出，未决、缺交易、分类不明或币种不符保留未知。不会将 dispute 事件次数
当作多笔损失，也不会把拒付手续费再减入本金。

交易币种与订单币种不同的费用按实际结算币种单列，不推断汇率；完整订单贡献仍因缺换汇依据
而停止。旧 adjustments 在已覆盖资源快照前的观测不再重复相加；快照后到达的费用/拒付事实仍
使读数不完整。成功资源读取只覆盖所列关联资源，不代表账户级未关联费用或服务支出已对齐；
后者须经有依据的 expense-allocation / 真实账单核验，不能据关联交易推定为零。

资源列表发现既有退款账本缺项或状态不同，会排入本地 `finance.refund.reconcile` 队列（
`evt_finance_...` 明确为本地复核引用，不是 Stripe 签名事件）。独立退款 worker 先 claim 新
generation 再 GET 当前 Refund，之后沿用原冻结/撤回/部分退款审核规则。旧列表不会直接改
额度；两份资源状态仍不一致时，报告保留 `refund_ledger_mismatch` 和未知净额/费用。
回滚旧服务前须排空此类任务，确认无处理中持有，并保留新增财务表和修订；旧服务不认识新的
本地复核事件类型，不能带着未处理项直接回滚。所有本地任务与 Stripe 现金退款动作完全分开。

所需事件包括 `charge.succeeded / charge.updated / charge.refunded` 及
`charge.dispute.created / updated / closed / funds_withdrawn / funds_reinstated`，并保留已有
Checkout / refund.* 订阅。上线前用实际受限 key 验证 Charges、Refunds、Disputes 和展开
Balance Transactions 的 GET 权限、实际 API/Webhook 版本、这些事件订阅及独立恢复日志。
实现依据为 Stripe 的 [Dispute 对象](https://docs.stripe.com/api/disputes/object)、
[Dispute 列表筛选](https://docs.stripe.com/api/disputes/list)、
[Refund 对象](https://docs.stripe.com/api/refunds/object)和
[余额交易分类](https://docs.stripe.com/reports/reporting-categories)。

## /admin/reports — 报表页面与不可变归档

`GET /admin/reports` 是无数据的管理页面外壳，ADMIN_TOKEN 未配置时返回 404。页面不保存密钥到
浏览器存储；读取、归档 API 均要求 `X-Admin-Token`，并返回 no-store。页面使用固定脚本 SHA-256
CSP、同源连接、禁止嵌入与 no-referrer，所有报告文本通过 DOM textContent 渲染。

- `GET /admin/reports/data`：接受与 cohorts 相同的筛选，返回 `report` 和 `payload_sha256`。
  `report` 含总体 cohort/economics、各来源 cohort/economics、完整 query、定义版本和事实 revision。
  所有结果来自同一次事实读取；财务计算只接受来源/政策维度，客户端 profile/通道不会裁剪账本。
- `POST /admin/reports/archive`：仅接受 `query` 与 `expected_payload_sha256`，body 最大 4 KiB。
  query 使用已加载报告返回的精确 UTC 截止时间。服务端重新计算并核对摘要；结果变化返回
  409 / report_changed，超出明细保留期返回 410。不得通过此入口提交自填统计数字。
- `GET /admin/reports/archives`：`limit` 为 1–50，默认 20；可带上页 `next_cursor`。返回
  `items` 摘要及下一页游标；以创建时间和内容 ID 稳定降序分页，同毫秒归档不会漏项。
- `GET /admin/reports/archives/:id`：id 是规范内容的 SHA-256（64 位小写十六进制）；返回完整
  不可变快照。不存在返回 404，校验失败返回 500，不使用当前事实替换损坏的历史记录。

归档响应包含 `id / created_at / definition_version / query / revision / payload_sha256 /
status=immutable_snapshot / report`。内容按键名排序后序列化，最大 1 MiB。同内容并发保存只留一份，
保留首次创建时间；新事实或新定义形成新 ID。`report_archives` 不随 90 天明细清理，必须纳入
数据库备份。ID/摘要用于完整性检查，不是独立审核者的签名。

页面已提供成熟与观察覆盖、来源比较、成本与履约区间三个视图及保存/读取/JSON 下载。
财务页单列上述待入账与账户未分配收据；v1 历史快照缺少该字段时显示“没有待分配收据读数”，
不补零、不改写旧归档。新定义和收据事实均参与修订/内容摘要。
v3 新增支付资源核对覆盖。旧快照缺少 finance_reconciliation 时明确显示覆盖读数缺失；空订单
窗口显示“尚未读取”，不因日期为 null 导致整页失败。
R28 等待期已过的子集与已保存快照分开标示；归档不代表独立质量、灰度或市场闸门通过。
第四个独立质量视图通过页面链接进入 `/admin/quality/reports`，使用下述独立评测契约。

## /admin/quality — 独立评测与不可变质量记录

除只含表单的 HTML 页面外，全部端点使用 `x-admin-token` 鉴权并返回 `Cache-Control: no-store`；未配置 Admin 时为 404。

| 方法与路径 | 行为 |
|---|---|
| `POST /admin/quality` | 最大 2 MiB。接收 `QualitySubmission`，校验并重算聚合；返回 `{id,revision,created_at,report,withdrawal}`。相同内容重试返回首次归档；同 run ID 的执行元数据变化返回 409；字段/版本/复核摘要无效为 400 |
| `GET /admin/quality` | 返回 `{items,next_revision}`。`limit` 为 1–20（默认 20），`before_revision` 为正十进制 int64 游标；可选 `profile/kind/language/contract/scope_version/include_history`，未知参数拒绝 |
| `GET /admin/quality/:id` | ID 为 64 位小写 SHA-256；返回不可变记录及撤回元数据，缺失为 404 |
| `POST /admin/quality/:id/withdraw` | 最大 4 KiB，精确 `{reference,reason}`。固定撤回原因见 `QUALITY_WITHDRAWAL_REASONS`；相同审计引用与原因重试幂等，不存在/冲突为 409。保留原评分，不提供删除或恢复旧版 |
| `GET /admin/quality/reports` | 质量页面，默认筛选当前 `screen_query_v1` 与范围版本；无数据保持空值。密码不持久化；CSP 使用内嵌脚本摘要；支持筛选、历史修订、区间/分母展示及 JSON 下载 |

默认列表每个执行只读最新评分修订，即使该版本已撤回，也不会回退显示旧评分。`include_history=true` 显式包含历史。profile、题型和语言条件必须在同一个质量单元匹配。

输入类型及确定性摘要定义以 [`quality.ts`](../server/src/quality.ts) 为准，根字段精确为 `schema_version:1, run, declarations, cases, review`。原始题目、图片、标准答案和模型输出不属于该接口。允许 1–5,000 个计划样本，实际记录不足时单列缺失数，不能声明完整执行。`case_digest` 复核绑定规范化的 run/declarations/cases；摘要验证完整性，不认证复核人身份。签署材料仍须由发布流程核对。

归档只保留聚合和源摘要，不保存逐题 ID、family 摘要或逐题答案。度量含 V1 可用答案精确率、独立 fallback 精确率、完整可作答声明范围的覆盖率、Ready 精确率、Retake 召回、范围外/多目标识别、分母及 Wilson 95% 区间；未标注项令相关精确率未知。评测 HTTP p50/p95 不等价于用户完整查题时间。新增非 SPI 的 400 / 每题型 100 样本要求不计 SPI、未声明组合、未标注项及其他范围挑战。

历史回归仅接受 `objective_v1`、空声明和 `legacy_objective` profile；原摘要签署不能冒充逐题字节复核，也不能归属新增阅读场景。输入、离线核验和重试操作详见 [`quality-evidence.md`](quality-evidence.md)。任何 `thresholds_met` 仍是该记录的点估计和输入检查；候选绑定、固定基线比较、至少 80 个解释样本、软件及真实灰度闸门另行验收。

## POST /admin/devices/internal

管理员鉴权、no-store。仅接受 device_id 正整数、is_internal boolean、reference（1–100 个
字母/数字/下划线/短横）。同引用同内容幂等，未知设备或内容冲突返回 409；修改保留审计。
客户端不能自报此标记。

## POST /v1/device-source

Bearer 鉴权、no-store，正文上限 4 KiB；仅接受 source_group=spi_entry|reading_practice_entry|direct|unknown。
服务端将方式固定为 self_reported；首次选择固定，同值幂等，改值返回 409。跳过不必调用，不得
据此阻塞查题。新客户端引导默认“暂不回答”，只有前进时才提交选择，后退不记录；跳过只保存
本地状态，不发请求。非空选择先持久化，注册完成后按 host/device 绑定同步；暂时失败可重试，
409 停止重试且保持 unknown。401 不清除凭证，旧账号的迟到响应不能确认新账号的来源。
只有服务端已确认且当前绑定相符的选择才为新事件填写 self_reported；profile 和界面语言不参与推断。

## GET /spi — 同一产品的入口

`GET /`、`GET /spi`、`GET /reading-practice` 均支持 `?lang=zh|ja|en` 与 Accept-Language 协商，
切换语言保留当前入口路径。三页共用实时题包
目录、fixed30 新注册政策、`/dl` 分发及 App 内更新/购买路径；历史余额不重置。下载点击仅是点击。
页面不附加设备凭证、归因追踪脚本或自动安装识别。来源由安装后的可跳过选择另行自报。

阅读入口按当前 support catalog 显示 disabled 或内部 beta；尚无独立评测公开组合，不因页面存在
而放开 App 的新功能。无实测正确率、规模或节省时长承诺；单次有效答案按请求计费，可用不等于正确。
响应为 HTML、public max-age=300、Vary Accept-Language、no-referrer、nosniff，CSP 禁止脚本及嵌入框架。

反馈导出是本地操作，没有截图收件 API。客户端逐张预览/选择、可选标准答案、默认本次问题排查
用途和未选中的授权确认；用途或材料改变需重新勾选。`feedback-v2` 包保存完整反馈编号、最多 90 天
的授权及单独外部处理许可要求；图片摘要与完整解码校验通过后原子保存。收到的材料由离线工具
独立存放、审核、撤回和删除；正式收件条件及操作接口见 [反馈操作规程](feedback-operations.md)。

## POST /admin/economics/expense-allocation

管理员鉴权、no-store。字段：reference、kind=service|acquisition、currency、amount_micros
十进制字符串、cohort_from/to、coverage_through；可选 source、policy_version。输入是一个明确
批次的**已核对累计费用分摊快照**，不是逐张发票自动相加。引用应对应审计依据；缺数据不提交，
确认确为零才显式写 0。

同引用变更返回 409；新核对结果使用新引用，在行锁事务内递增 revision，同毫秒也按提交版本
选最新。报表只使用币种、注册批次、来源/政策完全匹配，且 recorded_at≤as_of≤coverage_through
的分摊。未匹配时贡献保持未知，不将全批次费用套到某一个来源上。

## POST /v1/purchase-sessions — 短期购买会话

新客户端先用 Bearer 创建购买会话；服务端按当前 `catalog_version` 锁定题包、金额和币种，返回
十分钟有效的 `purchase_url`。URL 只包含会话 id 和随机短 secret，不包含长期 `device_token`。
请求体上限 4 KiB，响应 no-store。同一设备及 `purchase_id` 的已鉴权重试恢复同一订单和原到期时间，
换发新的随机 256-bit secret，仅保存 hash；原短链接立即失效，不延长十分钟期限。题包/价格/语言
快照不同、已过期或已消费时返回 409，不能借同一 ID 创建另一笔订单。
浏览器提交 Stripe 后，webhook 按 Checkout Session 资源做幂等入账；价格目录变化会要求重新创建会话。
`webhook_inbox` 保存事件类型、资源 ID、时间、payload SHA-256、处理状态及重试时间，不保存原始
事件正文。`payment_orders` 保存服务端验证后的价格快照、设备 ID、Checkout/PaymentIntent/Charge
引用及付费 lot。订单、首次充值、lot、额度版本、购买会话 `consumed_at` 和事件完成状态在同一事务提交。相同事件 ID
携带不同正文或同一订单换设备会拒绝；不同付款事件指向同一 Checkout Session 不会重复入账。
入账前再次核对会话、设备、Checkout、题包、目录和金额快照；消费时间只写首次。已经创建的
Checkout 在短链接过期后仍可正常到账。旧版已入账但未记录消费关联的订单，验明相同快照后可在
重投时补齐关联与消费标记，不再授予额度。

`POST /purchase/checkout` 的请求体为短会话凭证 `session`，上限 4 KiB；使用稳定幂等键和
10 秒超时创建 Checkout，原子保存 Checkout ID 与 HTTPS URL。已保存 URL 时重试直接返回同一
地址，不再次调用 Stripe。未保存成功时可按相同幂等键恢复；付款到账后短链接和 Checkout
创建入口均为 410。网络错误不回显供应商内部信息。

`GET /purchase` 提供中、日、英购买页；金额按币种显示，CSP 绑定固定脚本摘要，no-store、
no-referrer、nosniff，长期设备凭证不进入页面。`GET /purchase/complete?lang=…` 为统一返回页，
提示返回 App 刷新余额；不会凭 `paid=1`、`canceled=1` 或 session 查询参数确认到账/未扣款。
新 Checkout 的成功/取消 URL 不携带会话 ID 或 secret；匿名返回页不查询任何设备或支付状态。

```json
{"pack_id":"pack300","catalog_version":"pricing-v1","purchase_id":"<client uuid>","lang":"zh"}
```

## POST /webhooks/stripe — 退款状态与额度

原始 body 验签后持久化 `refund.created`、`refund.updated`、`refund.failed`（兼容
`charge.refund.updated`）的收据，再通过只读 API 获取当前 `re_` 对象。事件秒级时间戳不参与
新旧排序；持久化 generation 防止较早的网络响应覆盖后来的核对。Provider 读取失败返回 503，
收据留待 Stripe 重试或独立分钟 worker 恢复。重启和多实例重叠不会丢失待处理收据。

- `payment_refunds` 每个 `re_` 一行当前状态，`payment_refund_revisions` 保留每次核对的状态事实。
- 只有 `succeeded` 的当前事实进入已退款金额；pending/requires_action/failed/canceled 分列。
  `charge.refunded` 仅作为汇总通知确认，不再另外计作一笔退款。退款金额与币种不能跨币种相加。
- 待处理退款冻结关联付费 lot 的未用额度；全额成功撤回未用额度；失败/取消恢复相应额度。
  已经开始的合法 capture 可以结束；释放的 hold 会在同一事务中完成退款撤回后才可能变为可用。
  已消费题数与成本保留，余额不为负。非该订单的 trial/goodwill/paid lot 不受影响。
- 部分退款保持冻结并等待所有者明确指定撤回题数，不按金额比例取整。审核绑定当前退款集合指纹，
  后续退款状态变化使过期审核失效。所有额度变化保留 `payment_quota_changes` 审计。
- 旧 aggregate 余额保持 `legacy_unknown`。历史订单缺少可归属的 paid lot 时列为 integrity review，
  不根据历史付款猜测当前未用额度，不改动旧余额。

这里仅核对退款并执行额度策略，没有发起现金退款的接口。生产上线须验证已有 API/事件版本、
退款订阅与受限 key 的退款读取权限。状态选择依据 [Stripe Refunds](https://docs.stripe.com/refunds)
及 [Webhook 顺序约定](https://docs.stripe.com/webhooks)。

## /admin/payments/checkouts — 异常付款核对

已验签且 `paid` 的 completed/async_payment_succeeded 事件先在独立事务保存收据和归一化
Checkout 快照，再进入入账事务。正常付款使用签名快照直接处理；金额/目录/归属冲突返回
`received: true`，同时保留待核对业务记录，不会静默丢弃或猜测充值题数。内部事务失败返回 503，
已提交收据仍可由独立恢复任务接管。重投不能绕过审查或退避期限。

`checkout_cases` 保存当前处理状态；`checkout_deliveries` 保存事件对应的最小快照；
`checkout_observations` 追加带 generation 的核对事实；`checkout_decisions` 追加已应用的审核。
均不保存原始 Stripe 正文、任意 metadata、题目、邮箱或长期设备 bearer。设备身份仅以 hash
做内部匹配。入账、付费 lot、余额、退款策略、购买会话消费标记及审核记录使用同一事务，
中途失败整体回滚。已付款先于本地 Checkout 绑定时，可按不可变购买快照原子补齐绑定。

以下端点均要求 `X-Admin-Token` 并返回 no-store，未配置管理员密钥为 404，错误密钥为 401：

| 端点 | 契约 |
|---|---|
| `GET /admin/payments/checkouts` | 可选 `state=queued/processing/review/credited`、`limit=1…100`（默认 50）、`before=cs_…`；返回 `items/next`，按资源 ID 字典序倒序分页，非时间顺序 |
| `GET /admin/payments/checkouts/:reference` | 返回签名快照、最近观察、原因、处理次数、已解析设备、已应用审核及当前 `fingerprint`；不存在为 404 |
| `POST /admin/payments/checkouts/:reference/recheck` | 空 body 或 `{}`，上限 4 KiB；读取当前 Stripe Checkout 并尝试按确定的购买规则入账；读取失败为 503，审查结果为 200。因此这是可能入账的操作 |
| `POST /admin/payments/checkouts/:reference/decision` | 上限 4 KiB，严格接受下列七个字段；重新读取 Stripe 并核验观察指纹，成功返回 `applied: true` 和 `record`；事实/审核不符为 409 |

审核字段为 `review_reference`、`fingerprint`、`evidence_sha256`、`device_id`、`questions`、
`pack_id`、`catalog_version`。前者为唯一审查引用；两个摘要为 64 位小写 SHA-256；设备为
正整数，题数为 1…1,000,000 的明确整数；引用、题包和目录各限 1…100 个字母、数字或 `_.:-`。
相同已应用审核精确重试不重新读取供应商或重复加题；引用不可用于另一笔付款或另一份审核。

操作顺序：从 review 列表取记录，执行 recheck 并检查 provider 当前观察；在授权运营记录中
核实受益设备、实际收款与应交付题数，保存该记录的 SHA-256；提交上述明确字段和刚读取的
fingerprint。提交时观察有变化必须重新核对。原始已知设备、不可变购买会话、现存订单及付款
资源归属不能被人工字段覆盖；金额/币种/已知 PaymentIntent 发生冲突也不会强行入账。
`metadata_invalid/unsupported_mode/not_paid/financial_mismatch/purchase_missing/purchase_mismatch/`
`device_missing/catalog_mismatch/conflicting_events/provider_unavailable/order_conflict/review_changed`
为固定原因。该流程不提供删除待付款、关闭现金义务或发起退款的接口。

API 中金额为币种最小单位的十进制字符串或 null，设备 hash 被移除，仅保留
`deviceIdentityPresent` 与可解析的 `resolvedDeviceId`。外部审核文件内容由运营保管，接口
只记录摘要；管理员密钥授权不等于独立复核声明。待分配收款仍保留在核对队列，尚未纳入
cohort 收入归属，不能将没有已记账订单解读成没有收款。

恢复读取固定 `GET /v1/checkout/sessions/:id`，超时 8 秒、正文上限 256 KiB、禁止重定向。
上线前核验实际 Stripe API/事件版本、Checkout Sessions read/write 与 Refunds read 权限、
订阅和独立调度日志；本地注入式测试不代表真实 Stripe 配置通过。
[Stripe Checkout 查询契约](https://docs.stripe.com/api/checkout/sessions/retrieve)。

## GET /admin/payments — 支付核对

`X-Admin-Token` 鉴权、no-store；返回最近 100 份订单和最多 1000 个退款资源及 `hasMore`，
不作为全量财务聚合接口。可用 `order_reference=cs_…` 查询特定订单及关联退款。明确展示当前现金
状态、审核原因、额度归属与待处理事件数，不返回设备 bearer 或支付正文。
金额字段使用币种最小单位的十进制字符串，未知值为 null；题数仍为整数。

## POST /admin/payments/refund-decision — 部分退款题数审核

同一管理员鉴权。字段为 `order_reference`、当前 `fingerprint`、整数 `questions` 和唯一
`decision_reference`。题数必须在 0 与订单原始授予题数之间。成功返回 `applied: true`；同审核
引用重复提交幂等，不同内容或过期指纹返回 409。该接口只接受当前处于 partial review 的订单，
不会执行 Stripe 现金退款。

## GET /topup?device=\<token\>&lang=\<zh|ja|en\> — 旧版兼容购买页

客户端用系统浏览器打开。页面完成支付后，客户端点「刷新」走 `/v1/account`。

运营：Stripe webhook `POST /webhooks/stripe` 必须同时订阅
`checkout.session.completed` 与 `checkout.session.async_payment_succeeded`（延迟通知类支付在
`completed` 时可能仍为 unpaid）。入账以 Checkout Session id 为幂等键。
另须订阅 `refund.created`、`refund.updated`、`refund.failed`，并启用独立恢复调度。

开发桩 `POST /topup/stub-complete` 只在本地显式 `ALLOW_STUB_TOPUP=1` 时存在；生产默认 404。

## GET /update — 最新版本

客户端检查更新。响应 `{ version, tag, notes }`，不暴露上游托管主机。

## GET /dl — 下载 DMG

客户端「前往下载」打开此地址；服务端流式代理内部产物源。

## 客户端行为摘要

- 额度拦截只作用于官方模式：本地已知题数 ≤ 0 时在截图前拦下；题数未知时放行，以服务端 `402` 为准。
- 自定义 API Key / 本机 CLI 不经过官方服务。
- 新安装引导内静默注册；老安装保持原通道。
