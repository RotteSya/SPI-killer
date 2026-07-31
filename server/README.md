# NotchSPI 官方服务（服务端 · 题数额度制）

实现 macOS 客户端契约 [`../docs/official-api.md`](../docs/official-api.md) 的后端：代持模型厂商
密钥、代理调用、按题计量（1 次成功问答 = 1 题）、扣减题数、出售题包。客户端只持有一个匿名设备令牌，永远拿不到
厂商 Key。

> 这是 [`RotteSya/notch-SPI`](../) 主 App（Swift/macOS）配套的服务端；两者通过 `docs/official-api.md`
> 契约对接，独立部署、独立进程。

## 技术栈

- **Node.js ≥ 22.5 + TypeScript**（用 Node 内置类型剥离直接运行 `.ts`，无构建步骤）
- **Fastify** HTTP 框架
- **SQLite**（Node 内置 `node:sqlite`）经 `Store` 接口封装，生产可整体替换为 Postgres
- 零原生依赖，`npm install` 只拉 Fastify

## 快速开始

```sh
cd server
npm install
npm start          # 默认 mock 厂商 + 本地 SQLite，开箱即跑，无需任何密钥
# 或 npm run dev    # --watch 热重载
```

启动后：

```sh
# 注册设备（领 180 题试用额度）
curl -s -X POST localhost:8787/v1/devices -H 'content-type: application/json' \
  -d '{"platform":"macos","app_version":"2.0"}'
# → {"device_token":"dev_…","balance_questions":180}

# 截图问答（SSE）
curl -N -X POST localhost:8787/v1/captures -H "Authorization: Bearer dev_…" \
  -H 'content-type: application/json' \
  -d '{"system":"你是老师","task":"讲解","image_base64":"<JPEG base64>","image_media_type":"image/jpeg"}'
```

`npm test` 跑单元 + HTTP 集成测试（112 个用例，覆盖题包目录、SSE 解析、扣题原子性与并发双花、
401/402/503、充值恢复、厂商 Key 缺失时拒绝服务）。

存储层测试默认只跑 SQLite 和内存两个后端。生产用的 `PostgresStore` 需要一个真实数据库，
指向一个**一次性**库即可让同一套用例也跑在它上面（该套件会 TRUNCATE 所有表，库名必须含 `test`）：

```sh
TEST_POSTGRES_URL='postgres://…/notchspi_test?sslmode=disable' npm test
```
`npm run typecheck` 做类型检查。

## 端点（对齐契约）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/devices` | 无 | 匿名注册，赠 `TRIAL_QUESTIONS`（默认 180）题 |
| GET | `/v1/account` | Bearer | 剩余题数 + 累计用量 |
| POST | `/v1/captures` | Bearer | SSE 流式问答，成功扣 1 题；题数 ≤ 0 前置返回 402 |
| GET | `/topup?device=<token>&lang=<zh\|ja\|en>` | 无 | 题包购买网页（三语） |
| POST | `/topup/stub-complete` | 无 | **仅开发桩**：网页按钮直接入账（生产用签名 webhook 替换） |
| GET | `/healthz` | 无 | 健康检查 |

SSE 事件序列：`data: {"type":"delta",…}` × N → `data: {"type":"usage",…}`（含
`questions_charged`/`balance_questions`）→ `data: [DONE]`；流中出错发 `{"type":"error",…}` 后结束（不扣题）。

## 上线前要填的两个「接缝」

1. **厂商密钥**：设 `OFFICIAL_PROVIDER=anthropic`（或 `openai`）并注入对应 API Key（环境变量）。
   缺 Key 时会自动回退到 mock 并打印告警，服务始终能启动。模型、题包目录（`PACKS_JSON`）、`max_tokens` 全部 env 可配。
2. **支付**：仓库只带一个**开发用支付桩**。该桩端点无认证、可任意充值，因此**默认禁用**
   （生产安全）；本地联调充值流程时显式设 `ALLOW_STUB_TOPUP=1`。接入 Stripe / 支付宝 / 微信时，
   实现 `src/payments.ts` 里的 `PaymentProvider` 接口、在支付成功的签名回调里调用
   `store.credit(...)` 入账即可，其余代码无需改动。

所有配置见 [`.env.example`](.env.example)。

## 目录

```
server/
  src/
    index.ts            Fastify 引导（buildApp 供测试复用）
    config.ts           环境配置（全部默认值安全）
    routes.ts           四个端点 + 统一错误处理
    auth.ts             Bearer 令牌校验
    http.ts             错误体 + SSE 帧工具
    db.ts               Store 接口 + SQLite 实现（原子扣费、令牌存哈希）
    pricing.ts          题包目录解析与校验（纯函数）
    payments.ts         PaymentProvider 接口 + 开发桩
    providers/
      types.ts          Provider 接口 + 厂商 SSE 解析
      anthropic.ts      Anthropic Messages API 代理
      openai.ts         OpenAI Chat Completions 代理
      mock.ts           无密钥 mock（默认）
  test/                 单元 + HTTP 集成测试
```

## 部署形态

常驻长进程（本项目选型），SSE 长连接与计费事务最稳，可部署到任意 VPS / 容器 / Railway 等。
生产建议：把 `Store` 换成 Postgres 实现、置于反向代理之后（保留 `X-Accel-Buffering: no` 以免缓冲
SSE）、`OFFICIAL_PROVIDER` 指向真实厂商、接入真实支付并 `ALLOW_STUB_TOPUP=0`。
