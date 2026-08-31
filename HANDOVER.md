# NotchSPI 工程交接

## 1. Authority / 阅读规则

| 字段 | 值 |
|---|---|
| `role` | 本仓库唯一工程交接 SSOT |
| `audience` | 人类开发者、Codex、Claude、其他 AI Agent |
| `repo_root` | `$REPO_ROOT`，用 `git rev-parse --show-toplevel` 取得 |
| `conflict_policy` | 文档与可执行代码冲突时，以测试和代码为现状，再修文档 |
| `no_remote_mutation` | AI 不得自行 push、部署、或改 Stripe / Vercel / Postgres |

`AGENTS.md` 与 `CLAUDE.md` 只指向本文件。产品介绍见 [README.md](README.md)。

## 2. 5 分钟快速启动

| 字段 | 要求 |
|---|---|
| Prerequisites | macOS 14+、Apple Silicon、Xcode/Swift 5.9+、Node ≥22.18.0、npm |
| Bootstrap | [`./scripts/bootstrap.sh`](scripts/bootstrap.sh) |
| Run | [`./scripts/dev.sh`](scripts/dev.sh) |
| Expected server state | `GET /healthz` 为 mock provider、sqlite 或 memory、payments 为 stub 或 disabled |
| Side effects | `npm ci`、Swift debug build、本机临时服务；不碰生产、不写真实 Keychain（`NSPI_QA_EPHEMERAL=1`） |
| Stop | 退出客户端后，dev script 用 trap 关闭服务端 |

`./scripts/dev.sh --server-only` 只起服务，供无 GUI smoke。本地开发不读取 `server/.env`；`npm start` 也不会自动加载它。

## 3. 系统地图

两个组件：Swift macOS 客户端；Node/Fastify 官方服务。

唯一入口：

- 客户端：`Sources/NotchSPI/App/main.swift`
- 本机监听：`server/src/index.ts`（`buildApp()` + `isMain` listen）
- Vercel：`server/api/index.ts`（Root Directory = `server`，相对 `$REPO_ROOT`）

单次问答：热键 → 捕获 JPEG → `Prompts.build` → 通道路由（官方 / 自定义 Key / 本机 CLI）→ provider SSE → 合成 → 刘海 UI。官方通道在请求前 `reserveQuestions`，成功结算、失败退回。

Objective V1 打开时：`ClientConfigService` 冻结远端分组 → 三通道使用同一 `CapturePrompt` → `ObjectiveResultStreamFilter` 隐藏机器行 → `ObjectiveResultParser` 统一映射 `ready/review/retake`。官方服务以冻结请求的 `result_protocol` 选择 control 或 Objective treatment Provider，并只在 route 层解析完整输出、决定结算或释放；Provider 不拥有协议与计费语义。匿名事件经 `ProductTelemetry` 的 7 天/100 条本地队列上传到 `product_events`；事件永不包含截图、题目、答案、Prompt 或模型原文。

存储选择（`server/src/storage.ts` 动态 `import()`）：Postgres（`POSTGRES_URL` / `DATABASE_URL`）→ Serverless 上的 memory → 本地 SQLite。

外部边界：模型厂商、Stripe Checkout、Postgres、GitHub Release（`/dl` 与 `/update` 的内部产物源）、Vercel Fluid（SSE 长连接）。公开生产源是服务根路径；客户端默认 `OfficialAPI.defaultBaseURL`。

## 4. Single-Source Ownership Map

| 事实 | 唯一权威源 |
|---|---|
| 产品支持范围与开发命令 | 本文件 |
| App 版本 / build | [`VERSION.env`](VERSION.env) |
| Swift target / platform | [`Package.swift`](Package.swift) |
| Node 版本 / 依赖 / 命令 | [`server/package.json`](server/package.json) + lockfile |
| 环境变量默认值 | [`server/src/config.ts`](server/src/config.ts) |
| 环境变量示例与风险说明 | [`server/.env.example`](server/.env.example) |
| HTTP 客户端契约 | [`docs/official-api.md`](docs/official-api.md) |
| 实际路由集合 | [`server/src/routes.ts`](server/src/routes.ts) |
| 数据接口 | [`server/src/db.ts`](server/src/db.ts) |
| fixture / 阈值 | [`Tests/Fixtures/Personality/manifest.json`](Tests/Fixtures/Personality/manifest.json) |
| Objective 协议 / fixture / 闸门 | [`server/src/objective-result.ts`](server/src/objective-result.ts) + [`Tests/Fixtures/objective-v1/manifest.json`](Tests/Fixtures/objective-v1/manifest.json) + [`Tests/Fixtures/objective-v1/RUNBOOK.md`](Tests/Fixtures/objective-v1/RUNBOOK.md) |
| 发布产物流程 | [`scripts/package.sh`](scripts/package.sh) |
| 回归闭环 | [`scripts/verify.sh`](scripts/verify.sh) |

## 5. 不可破坏的不变量

- `INV-BILL-001`：成功问答扣 1 题；真实失败不扣。
- `INV-BILL-002`：并发预扣不得产生负余额。
- `INV-AUTH-001`：瞬时 401 不得自动销毁付费额度唯一凭证（设备令牌）。
- `INV-STREAM-001`：SSE 正常序列为 `delta`×N → `usage`×1 → `DONE`。
- `INV-CAPTURE-001`：Release 永远排除本 App 软件截图；DEBUG 仅显式 QA 开关可放开。
- `INV-DEPLOY-001`：服务端新增契约字段必须先于客户端部署。
- `INV-STATE-001`：自动模式、人格连续题、截图缓存的生命周期边界不得互相泄漏。
- `INV-SECRET-001`：厂商 Key、管理员 Key、数据库凭证不得写入 Git 或日志。
- `INV-RESULT-001`：Objective 机器协议不得进入可见正文、剪贴板或辅助功能朗读。
- `INV-RESULT-002`：`ready/review` 必须具有可用答案；`retake` 与无可用结果不得扣题。
- `INV-TELEM-001`：产品事件只允许固定键与枚举，不得携带截图、题目、答案、Prompt 或模型原文。
- `INV-TELEM-002`：关闭匿名可靠性数据后，客户端必须立即删除队列且不得生成或上传新事件。
- `INV-PROVIDER-001`：未携带 `result_protocol` 的 control/旧客户端流量只走 `OFFICIAL_PROVIDER`；`objective_v1` 才可走独立 treatment Provider，任一 slot 失败不得向另一组泄漏或扣题。

热键定义在 `Sources/NotchSPI/Settings/Settings.swift`：`⌘⇧1` 讲题、`⌘⇧2` 上下文追问、`⌘⇧9` 人格测试、`⌘⇧0` 自动模式、`⌘⇧Space` 显隐。`⌘⇧3–6` 是系统截图键，不要占用。

## 6. 变更影响矩阵

| 改动 | 必须同步跑 |
|---|---|
| HTTP body / SSE | 契约文档 + Swift `OfficialAPI` tests + Node API/SSE tests |
| Store 接口 / schema | memory + sqlite；有 `TEST_POSTGRES_URL` 时再加 postgres（库名必须含 `test`，会 TRUNCATE） |
| Prompt / protocol | golden fixtures + personality composition tests |
| UI / 热键 | Swift tests + DEBUG visual QA |
| 版本 / 打包 | `VERSION.env` + repo-health + plist / codesign / notary |
| 环境变量 | `config.ts` 与 `.env.example` 对齐（repo-health） |

## 7. 兼容性账本

删除门槛（三项同时满足才可另立任务）：所有者明确最低支持版本 + 生产遥测证明旧版本归零 + 至少跨过两个正式版本。

| ID | 位置 | 保护对象 | 状态 |
|---|---|---|---|
| `MIG-KEY-001` | `Settings.swift` `apiKey(for:)` | UserDefaults 明文 API Key → Keychain | live |
| `MIG-TOK-001` | `OfficialAPI.swift` `deviceToken` | 设备令牌 → Keychain；丢失则已购额度不可恢复 | live |
| `MIG-PER-001` | `PersonaStore.swift` init | 单 persona 字段 → persona library | live |
| `MIG-FONT-001` | `Theme.swift` `legacyAnswerFontSize()` | `answerSize` 三档 → 连续字号 | live |
| `MIG-WIRE-001` | `OfficialAPI.swift` + `routes.ts` | `image_base64` 单图；`images_base64` 存在时仍带最后一张 | live |
| `MIG-STOR-001` | `APIProvider.swift` | Anthropic/OpenAI 的 `storageKey` 仍为 `claude` / `codex`；DeepSeek 使用独立 `deepseek` | live |
| `MIG-DB-001` | `db-postgres.ts` / `db-sqlite.ts` | lazy columns：`topups.note`、`devices.cli_enabled`、`onboarded`、`hotkey_presses` | live |
| `MIG-OBJ-001` | `ObjectiveResult.swift` / `routes.ts` | 未携带 `result_protocol` 的客户端继续使用旧 Prompt、旧解析与 `MIN_BILLABLE_CHARS` 计费 | live |
| `MIG-PROV-001` | `config.ts` / `providers/index.ts` / `routes.ts` | Objective treatment Provider 缺省继承 control；旧客户端不因实验模型配置而迁移 Provider | live |

`db-postgres.ts` / `db-memory.ts` / `db-sqlite.ts` 由 `storage.ts` 动态加载。`recordCount` 是 `@testable` 测试观测面。`Resources/NotchSPI.png` 供未打包 `swift run` 的更新对话框图标。

## 8. 验证与发布

- 本地：[`./scripts/verify.sh`](scripts/verify.sh)。Swift 测试必须串行（共享 UserDefaults / Keychain）。
- 付费 personality 闸门：[`Tests/Fixtures/Personality/RUNBOOK.md`](Tests/Fixtures/Personality/RUNBOOK.md)。阈值只在 `manifest.json`。
- 付费 Objective 闸门：[`Tests/Fixtures/objective-v1/RUNBOOK.md`](Tests/Fixtures/objective-v1/RUNBOOK.md)。普通 CI 只验证 240 张 manifest、SHA-256 与解析器；正式运行必须显式设置 `NSPI_RUN_OBJECTIVE_EVAL=1`。
- DeepSeek Objective r5 的 240 题绝对闸门与同模型 legacy 相对闸门均已自动通过并由 RotteSya 以独立 attestation 签署：准确率 96.57%、V1/状态/retake 100%、平均 Token +5.92%、p95 -43.58%。脱敏归档、比较与签署见 Runbook。安全灰度保持 control `OFFICIAL_PROVIDER=anthropic`，以 `OBJECTIVE_RESULT_V1_PROVIDER=deepseek` 隔离 treatment，并从 `OBJECTIVE_RESULT_V1_BPS=0` 开始。
- 打包：`./scripts/package.sh qa` → `dist-qa/NotchSPI.app`；`./scripts/package.sh release` → `dist/NotchSPI.dmg`（Developer ID + 公证 + staple）。无证书的 release 必须显式 `--unsigned`。
- Owner-only：push、tag `v${APP_VERSION}`、GitHub Release 上传 DMG、Vercel 部署、Stripe webhook 配置。
- 服务端契约新字段先于客户端发版（`INV-DEPLOY-001`）。

支付运营：Stripe webhook 必须同时订阅 `checkout.session.completed` 与 `checkout.session.async_payment_succeeded`。`ALLOW_STUB_TOPUP=1` 只在本地显式开启。`amount_cents` 是币种最小单位（JPY 为日元整数，CNY/USD 为分）。

Postgres TLS 默认 `verify-full`。`ADMIN_TOKEN` 为空则全部 `/admin*` 为 404。

## 9. 故障定位顺序

1. 工具链 / `./scripts/bootstrap.sh`
2. `GET /healthz`（provider / db / payments / webhook）
3. `./scripts/dev.sh` 本地 mock
4. 通道路由（官方 / 自定义 Key / CLI）
5. Screen Recording 权限与捕获排除
6. 厂商 / 支付 / 数据库
7. 生产只读核验由所有者执行

## 10. Definition of Done

- `./scripts/verify.sh` 全绿
- 文档链接与权威映射通过 `scripts/repo-health.mjs`
- 无 tracked 生成物（`.build`、`node_modules`、`dist`、`.eval-results`、数据库、`.env`）
- `git status --short` 干净
- 无未解释的兼容删除
- 所有外部副作用由所有者确认
