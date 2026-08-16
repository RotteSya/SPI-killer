# 官方服务 — 当前生产配置与重建清单

当前生产：**https://notchspi-api.vercel.app**（Vercel 项目 `notchspi-api`，
team `rottesyas-projects`，framework 识别为 Fastify，Fluid compute，SSE 已验证）。
客户端默认连此地址（可用 `defaults write com.rottesya.notchspi official.baseURL <url>` 覆盖）。

随时核实现状：

```sh
curl https://notchspi-api.vercel.app/healthz
# 健康时应为 {"ok":true,"provider":"anthropic","db":"postgres","payments":"stripe","webhook":"configured"}
# mock / memory / disabled 表示对应接缝未配或已降级
```

## 当前生产接缝（已上线；改密钥在 Vercel → Settings → Environment Variables，然后 Redeploy）

### 模型

| 变量 | 值 |
|---|---|
| `OFFICIAL_PROVIDER` | `anthropic` |
| `ANTHROPIC_API_KEY` | Anthropic API Key（console.anthropic.com） |

### 数据库

推荐 Vercel Marketplace → Neon，用 **pooled** 连接串：

| 变量 | 值 |
|---|---|
| `POSTGRES_URL` | 提供商的 pooled 连接串（`DATABASE_URL` 是同义别名） |

表结构首次访问自动创建。`/healthz` 的 `db` 字段：`postgres` = 已接库；`memory` = 未配库（数据易失）。

**TLS：默认校验数据库证书**（`verify-full`）。Neon / Supabase 用 Node 公共根即可。
仅在提供商证书无法被公共根验证时才设 `POSTGRES_CA_CERT_FILE` 或 `POSTGRES_CA_CERT`。
`POSTGRES_SSL_MODE=require` 是「加密但不校验」的逃生开关，默认不要用。

### 支付（Stripe Checkout）

1. Stripe Dashboard → Developers → API keys → 创建 **Restricted key**（只勾 Checkout Sessions: Write）。
2. Developers → Webhooks → Add endpoint：
   - URL: `https://notchspi-api.vercel.app/webhooks/stripe`
   - 事件: `checkout.session.completed`
   - 复制 Signing secret（`whsec_…`）。
3. 环境变量：

| 变量 | 值 |
|---|---|
| `STRIPE_SECRET_KEY` | `rk_live_…`（restricted key） |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
| `CURRENCY` | 与 Stripe 账户结算币种一致（`JPY` / `CNY` / `USD`） |
| `PACKS_JSON` | 题包目录，金额单位为该币种最小单位（JPY 无小数：`680` = ¥680） |

设 `STRIPE_SECRET_KEY` 后支付切到 Stripe。支付宝/微信在 Stripe Dashboard → Payment methods 开启即可。

### 管理台

| 变量 | 值 |
|---|---|
| `ADMIN_TOKEN` | 管理台密钥。**不配则 `/admin*` 全线 404** |

## 安全设计（已内置）

- webhook 按原始字节验签（HMAC-SHA256 + 5 分钟时间戳容差），签名不符一律 400。
- 入账以 Checkout Session id 为幂等键——Stripe 重复投递不会重复加题。
- 实付金额/币种与题包目录逐字段核对，不符则记日志且**不入账**。
- 支付失败/取消零费用；答题失败不扣题。
- 开发桩端点（stub-complete）在生产默认 404，Stripe 模式下强制关闭。

## 域名

产品站就是服务根路径 `/`。若绑定自有域名：Vercel 项目 → Domains，再视需要改客户端 `defaultBaseURL` 并发版。

## 重新部署代码

仓库根是 `native/`。Vercel Git 集成的 **Root Directory = `server`**（相对仓库根，不要再套一层外层文件夹名）。
push `main` 上的服务端改动会自动部署。灾难恢复时按上面三组变量重建即可。

## 本地开发

```sh
cd server && npm ci
DB_PATH=':memory:' OFFICIAL_PROVIDER=mock ALLOW_STUB_TOPUP=1 npm start
npm test
npm run typecheck
```
