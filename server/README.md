# NotchSPI 官方服务（服务端 · 题数额度制）

实现 macOS 客户端契约 [`../docs/official-api.md`](../docs/official-api.md) 的后端：代持模型厂商
密钥、代理调用、按题计量（1 次成功问答 = 1 题）、扣减题数、出售题包。客户端只持有一个匿名设备令牌，永远拿不到
厂商 Key。

> 配套主 App 在仓库根。两者通过 `docs/official-api.md` 对接，独立部署。开发与发版流程见 [`../CLAUDE.md`](../CLAUDE.md)。

## 技术栈

- **Node.js ≥ 22.5 + TypeScript**（Node 直接跑 `.ts`，无构建步骤）
- **Fastify** HTTP 框架
- **存储**：生产 = Vercel Serverless + Postgres（Neon）；本地默认 SQLite；未配库的 Serverless 回退内存。选择逻辑见 `src/storage.ts`（动态 `import()`）
- 依赖只有 `fastify` + `pg`

## 快速开始

```sh
cd server
npm ci
DB_PATH=':memory:' OFFICIAL_PROVIDER=mock ALLOW_STUB_TOPUP=1 npm start
# 或 npm run dev    # --watch 热重载
```

启动后：

```sh
# 注册设备（试用额度随机 100–180，见 TRIAL_MIN/MAX_QUESTIONS）
curl -s -X POST localhost:8787/v1/devices -H 'content-type: application/json' \
  -d '{"platform":"macos","app_version":"2.9"}'

# 截图问答（SSE）
curl -N -X POST localhost:8787/v1/captures -H "Authorization: Bearer dev_…" \
  -H 'content-type: application/json' \
  -d '{"system":"你是老师","task":"讲解","image_base64":"<JPEG base64>","image_media_type":"image/jpeg"}'
```

`npm test` 跑单元 + HTTP 集成测试（通过数以命令输出为准）。
存储层默认测 SQLite 与内存。生产用的 `PostgresStore` 需要一次性库（会 TRUNCATE，库名必须含 `test`）：

```sh
TEST_POSTGRES_URL='postgres://…/notchspi_test?sslmode=disable' npm test
```

`npm run typecheck` 做类型检查。

## 端点

客户端契约端点的请求/响应只写在 [`../docs/official-api.md`](../docs/official-api.md)，此处不重复。

| 方法 | 路径 | 鉴权 | 说明 | 代码 |
| --- | --- | --- | --- | --- |
| GET | `/` | 无 | 产品落地页 | `routes.ts` `app.get('/')` |
| GET | `/dl` | 无 | 流式代理 DMG（产品面零 GitHub） | `app.get('/dl')` |
| GET | `/update` | 无 | 版本中继，给客户端检查更新 | `app.get('/update')` |
| GET | `/stats` | 无 | 下载按钮点击计数 | `app.get('/stats')` |
| GET | `/healthz` | 无 | 健康检查（自报 provider / db / payments） | `app.get('/healthz')` |
| POST | `/v1/devices` | 无 | 匿名注册，随机赠试用题 | 契约 |
| GET | `/v1/account` | Bearer | 剩余题数 + 累计用量 | 契约 |
| POST | `/v1/captures` | Bearer | SSE 问答，成功扣 1 题 | 契约 |
| GET | `/topup` | 无 | 题包购买网页 | 契约 |
| POST | `/topup/checkout` | 无 | 创建 Stripe Checkout Session | `app.post('/topup/checkout')` |
| POST | `/webhooks/stripe` | Stripe 签 | 支付入账（幂等） | `app.post('/webhooks/stripe')` |
| POST | `/topup/stub-complete` | 无 | **仅开发桩**，`ALLOW_STUB_TOPUP=1` 才存在 | `app.post('/topup/stub-complete')` |
| GET | `/admin` | `ADMIN_TOKEN` | 管理台（未配 token 则整段 404） | `app.get('/admin')` |
| POST | `/admin/grant` | `ADMIN_TOKEN` | 手动加题 | `app.post('/admin/grant')` |
| GET | `/admin/activity` | `ADMIN_TOKEN` | 最近注册 / 充值 | `app.get('/admin/activity')` |
| POST | `/admin/cli` | `ADMIN_TOKEN` | 按设备开关本机 CLI 通道 | `app.post('/admin/cli')` |

SSE 事件序列见契约：`delta` × N → `usage` → `[DONE]`；流出错发 `error` 且不扣题。

## 配置与生产接缝

全部环境变量见 [`.env.example`](.env.example)。生产部署步骤见 [`DEPLOY.md`](DEPLOY.md)。

- **厂商密钥**：`OFFICIAL_PROVIDER=anthropic`（或 `openai`）+ 对应 Key。缺 Key 时回退 mock，但 `/healthz` 会 503 并带 `provider_error`。
- **支付**：设 `STRIPE_SECRET_KEY` 即切到 Stripe Checkout（`src/stripe.ts`）。开发桩默认关闭，本地联调才设 `ALLOW_STUB_TOPUP=1`。
- **管理台**：必须设 `ADMIN_TOKEN`，否则 `/admin*` 全部 404。

## 目录

```
server/
  api/index.ts          Vercel Serverless 入口
  vercel.json           Fluid compute + 全路径 rewrite 到 /api
  src/
    index.ts            Fastify 引导（buildApp 供测试/Vercel 复用）
    config.ts           环境配置（全部默认值安全）
    routes.ts           上表全部路由
    auth.ts             Bearer + 遥测三头（x-app-version / x-onboarded / x-client-event）
    http.ts             错误体 + SSE 帧
    storage.ts          按环境动态加载存储后端
    db.ts               Store 接口
    db-postgres.ts      生产 Postgres（动态 import）
    db-sqlite.ts        本地 SQLite（动态 import）
    db-memory.ts        Serverless 回退（动态 import）
    pricing.ts          题包目录解析
    payments.ts         PaymentProvider + 充值页 HTML
    stripe.ts           Stripe Checkout + webhook 验签
    site.ts             产品落地页
    admin.ts            管理台 HTML
    rateLimit.ts        注册/并发限流
    providers/          anthropic / openai / mock
  test/                 单元 + HTTP 集成测试
```

## 部署形态

生产是 **Vercel Serverless（Fluid compute）**：`api/index.ts` + `vercel.json`。
仓库根是 `native/`，所以 Vercel Root Directory = **`server`**（不是 `native/server`）。
SSE 长连接依赖 Fluid；`/healthz` 自报 `provider` / `db` / `payments`。
