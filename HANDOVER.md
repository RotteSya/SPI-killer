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

单次问答：热键 → 捕获 JPEG → `Prompts.build` → 通道路由（官方 / 自定义 Key / 本机 CLI）→ provider SSE → 合成 → 刘海 UI。官方通道由 `CaptureService` 绑定请求 ID，`BillingStore.begin/finish` 原子持有、结算或释放；旧 Store 方法保留为兼容适配。

Objective V1 打开时：`ClientConfigService` 冻结远端分组 → 三通道使用同一 `CapturePrompt` → `ObjectiveResultStreamFilter` 隐藏机器行 → `ObjectiveResultParser` 统一映射 `ready/review/retake`。官方服务以冻结请求的 `result_protocol` 选择 control 或 Objective treatment Provider，并只在 route 层解析完整输出、决定结算或释放；Provider 不拥有协议与计费语义。匿名事件经 `ProductTelemetry` 的 7 天/100 条本地队列上传到 `product_events`；事件永不包含截图、题目、答案、Prompt 或模型原文。`ObservationJournal` 将队列、同意版本与覆盖游标原子持久化；`/v1/device-observation` 同步偏好与核验摘要。关闭时立即删队列并停止行为上传，仅同步最小偏好。服务端通过唯一序列回执验证 complete，缺口不得默认完整；事件、回执、覆盖按 90 天清理。

存储选择（`server/src/storage.ts` 动态 `import()`）：Postgres（`POSTGRES_URL` / `DATABASE_URL`）→ 开发 Serverless 上的 memory → 本地 SQLite。正式模式要求持久存储，缺少必要模型预算、价格或恢复配置会拒绝启动。注册采用 fixed30 政策，历史余额保留；首次访问旧余额时建 `legacy_unknown` lot。

旧余额 lot/ledger 与迁移检查点同事务提交；SQLite 整批扩展事务和 Postgres 按 schema 加锁防止半迁移及冷启动竞态。`quota_migration_control` 让兼容实例共享暂停状态，已有结算与恢复继续。`scripts/migrate-quota.mjs` 只接受显式数据库，按设备核对历史充值/用量摘要、lot/ledger/余额，恢复要求最新余额版本全部校验。所有命令含 schema 初始化，status 也可能执行 DDL。生产先排空并退出旧写入实例；禁止回退到 7ba96db 直接改新库。流程与本地验证边界见 [迁移与兼容回退](docs/quota-migration.md)。

SQLite 在切换 WAL 时可能绕过 busy handler 直接返回 SQLITE_BUSY；初始化仅对该幂等操作使用 5 秒单调时钟总预算、25ms 让出间隔，成功后恢复普通写事务的 busy_timeout。所有初始化错误统一关闭连接。该竞态由 Linux 四进程旧库冷启动测试发现。

注册重试同时受 token 与注册凭证的唯一性约束。SQL 插入处理两个唯一索引的并发冲突后，按 token 锁定并核验原凭证绑定，只在实际插入时创建 trial lot/ledger；Memory 执行同一不可重绑检查。冲突不能新发试用额度，也不能返回其他凭证所属设备。

2.12 / build 19 是尚未发布的候选。题组、区域选择、解释、恢复及新合约仍受放行开关控制；完整蓝图进度与未完成闸门见 [发布进度记录](docs/release-progress-2026-09-06.md)。不得将本地软件测试通过视为新场景模型评测或生产灰度通过。

SPI 与阅读练习页面分别为 `/spi`、`/reading-practice`，三语共用实际定价与下载；未完成评测的阅读范围明确显示未开放/内部测试。引导新增可跳过的自报来源：先本地持久化、再绑定当前 host/device 同步，只有确认后标记 self_reported，跳过保持 unknown。它不改变题目模式、额度或功能。

问题反馈先逐张预览/选择，再明确用途与授权，本地导出 `feedback-v2` JSON 及私有材料文件夹；不会自动发送。离线 `scripts/manage-feedback.mjs` 处理独立收件、审核、撤回与到期删除。正式收件须先配置授权成员、受控邮箱/备份清理及每日任务并做真实演练，详见 [反馈操作规程](docs/feedback-operations.md)。当前导出授权不允许外部模型处理。

新合约主查题、解释和恢复在预扣前通过 `image-validation.ts` 完整验证静态 JPEG/PNG。sharp 固定版本随 lockfile 安装，正式部署须带上目标平台的 optional 原生包；不能仅复制 Mac 的 node_modules。16MP、每进程两个解码任务、每图 libvips 处理超时和禁用操作缓存共同限制资源；仍须验证真实部署平台。

`CaptureService` 在鉴权前监听连接关闭，在解码、预算、持有及尝试记录之后检查取消。三种操作共用准入和并发清理；持有提交回执丢失时，用仅由服务端生成的 requestId 回查归属，禁止释放其他执行者的同 ID 请求。确认未调用模型才释放预算并把已有尝试记为零调用；已启动但 usage 未知保留成本上界。清理事务不可用时记录待核对，持有仍依赖独立恢复任务兜底。

客户端官方 SSE 的唯一读取实现为 `OfficialStreamDecoder`：按字节分帧、严格 usage 类型和顺序、明确 DONE、有限正文及流大小。截断或非法事件不算成功；已收到的结算回执与完整收到答案分开处理，中断只查询原请求状态。新账号/服务地址不接收旧请求的余额。原始内容不进入诊断日志。

`OfficialAPI.run` 的 delta、usage、401、状态补查及最终成功回调在主线程执行时重新检查取消和请求所属账号/地址。`CaptureEnvironment.live` 连接真实 URLSession 与账户镜像，测试可用独立账户状态运行同一请求实现。status 只接收最多 64 KiB JSON，并匹配请求 ID/operation；结束或提前拒绝时取消对应传输任务。`OfficialCaptureMaterials` 在编码前限量读取普通文件，拒绝符号链接/管道，保留原字节与页序；该步骤不代替服务端完整图片解码。

官方捕获 JSON 上限为 4 MiB，为已核验的 Vercel 4.5 MB 入口保留余量；self-hosted 服务的 16 MiB 上限不能作为官方客户端的传输承诺。材料读取按 base64 编码长度与兼容字段重复题图计入预算，序列化不展开斜杠，发送前复核完整 JSON；不降低图像质量、不静默丢页。平台或服务 413 映射为三语框选/减少材料提示，不自动重发。服务端在 Vercel 模式使用 4,500,000 字节 parser 上限，413 返回 payload_too_large。目标平台原生解码/内存验证入口为 `scripts/verify-linux-runtime.mjs`，须在 Node 24 Linux x86_64、1 GiB cgroup 中运行，模拟器耗时不代表生产 SLA。

`OfficialAccountState` 是官方凭证与本地镜像的同步所有者；默认仍使用原 Keychain service/account 和 UserDefaults 键。Keychain 读取区分 missing 与 unavailable，后者不能触发注册或覆盖旧凭证。旧明文仅在 Keychain 确认无项目时迁移，写入失败保留恢复副本；新注册先持久化随机 retry credential，正式 token 保存核验后才清除它。重置必须确认 retry credential 与 token 删除成功后才可重新领取，失败保留账户镜像并在界面报错。

账户缓存以服务地址/令牌摘要绑定；服务、设备或已观察到的身份 generation 变化后，旧注册/刷新/SSE/充值链接不能修改当前镜像。刷新按请求序列与 balance_version 整体应用余额、CLI 权限和服务端总量，旧版本响应不能单独覆盖总量/权限。注册、刷新、购买交接只读取最多 64 KiB JSON，拒绝重定向；购买链接在实际打开前再次核验绑定。镜像变更在解锁后发通知，允许观察者同步读取。原生 NotchController 父请求与题组联动仍须后续验收。

服务端 `BillingStore.accountSnapshot` 在同一设备锁和事务内读取 devices 的余额/版本/累计用量/CLI 权限及 quota lots；Memory 无 await 地复制同一状态。`GET /v1/account` 完成鉴权诊断与恢复任务后使用该快照，不拼接鉴权时较早的 Account。注册响应的余额与版本也取自同一个 quota 快照。非法或无法精确表示的计数拒绝输出，缺失/读取失败不回退至较早账户镜像；接口字段和 schema 不变。三存储并发、过期恢复及旧行重开测试通过。

结算 `finish` 也在原事务内返回完整账户快照。SSE usage、status 和重复请求元数据增加 `account_totals:{questions,input_tokens,output_tokens}`，与同一 `balance_version` 绑定。客户端按身份和版本整体替换累计镜像，不再累加逐次 usage，避免刷新后重复计入、乱序漏计及解释 token 混入口径。累计范围沿用服务端 solve 计数；辅助尝试费用仍单独入账。旧服务缺少累计快照时保留现有计数并执行有界账户刷新，启动与返回均核验原账户身份；新服务端字段先上线。重复/乱序/旧服务兼容和三存储事务测试已通过。

`CaptureRequestBinding` 冻结目标、模式、所选通道及官方账号/base/generation，自定义 Key/endpoint/model 或 CLI 变化也改变材料 scope；scope 使用长度前缀编码后的 SHA-256，不含可读密钥。`NotchController` 在异步边界和回调校验绑定；账户通知、周期检查及明确清理取消当前官方任务和补查、关闭区域选择并使旧 generation 失效。解释/恢复复用父请求账号；`reconcileCaptureStatus` 用冻结凭证补查并在原账号仍有效时更新完整累计镜像。首次注册在本次查题截图前完成；只有未注册、同选择且未过期的材料组可绑定至本次成功确认的账号，以保留先存正文再查题的流程。上述核心/HTTP/文件测试通过，真实 AppKit 交互仍待解锁验收。

恢复答案解释仍走原收费 solve 的 `/explanation`，用可选 `answer_capture_id` 指向该 solve 明确关联、已完成且可用的直接恢复结果。路由核验材料/答案/版本，Store 在同一设备事务内再核验父链并占用原 solve 的唯一解释名额；两份答案共用一次限制和原父 15 分钟截止，不延长期限、不新增扣题。capture 元数据保存选择的答案 ID，成本父关联和原表主键不变；没有 DDL。Swift 分别保留收费 capture 和可见答案 capture，仅在完整交付及明确 capability 后开放解释，回执与正文完成分开判断。三存储并发/失败/期限、真实 HTTP selector 和解码测试已通过，真实 UI 验收仍未完成。

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

- 本地：[`./scripts/verify.sh`](scripts/verify.sh)。Swift 测试必须串行；verify 为普通迁移测试启用 `NSPI_QA_EPHEMERAL=1`，避免读写用户真实密钥。账户集成测试显式使用独立随机 service 的真实 Keychain，并在结束时删除测试项目和独立 defaults suite；默认 `.live` 联动使用隔离的全局凭证后端。
- CI 在 main、PR 和 `codex/product-update-2-12` 验证分支运行；覆盖 Node 22.18/24.20、Postgres 16/17、macOS 串行 Swift 与原生 AL2023 1 GiB 资源探针。验证分支的 Vercel Git 自动部署已在配置中关闭；CI 不携带生产凭证。原生 CI 结果必须实际通过，模拟器的整文件进程退出不能按重跑成功抹去。
- 付费 personality 闸门：[`Tests/Fixtures/Personality/RUNBOOK.md`](Tests/Fixtures/Personality/RUNBOOK.md)。阈值只在 `manifest.json`。
- 付费 Objective 闸门：[`Tests/Fixtures/objective-v1/RUNBOOK.md`](Tests/Fixtures/objective-v1/RUNBOOK.md)。普通 CI 只验证 240 张 manifest、SHA-256 与解析器；正式运行必须显式设置 `NSPI_RUN_OBJECTIVE_EVAL=1`。
- DeepSeek Objective r5 的 240 题绝对闸门与同模型 legacy 相对闸门均已自动通过并由 RotteSya 以独立 attestation 签署：准确率 96.57%、V1/状态/retake 100%、平均 Token +5.92%、p95 -43.58%。脱敏归档、比较与签署见 Runbook。安全灰度保持 control `OFFICIAL_PROVIDER=anthropic`，以 `OBJECTIVE_RESULT_V1_PROVIDER=deepseek` 隔离 treatment，并从 `OBJECTIVE_RESULT_V1_BPS=0` 开始。
- 打包：`./scripts/package.sh qa` → `dist-qa/NotchSPI.app`；`./scripts/package.sh release` → `dist/NotchSPI.dmg`（Developer ID + 公证 + staple）。无证书的 release 必须显式 `--unsigned`。
- Owner-only：push、tag `v${APP_VERSION}`、GitHub Release 上传 DMG、Vercel 部署、Stripe webhook 配置。
- 服务端契约新字段先于客户端发版（`INV-DEPLOY-001`）。
- Vercel 静态输出只允许 `server/public/robots.txt`；`outputDirectory=public` 防止默认静态打包公开 src/test。`scripts/verify-vercel-output.mjs` 检查真实构建包的公开清单、目标原生模块、动态 SQL 导入及入口 HTTP/SSE；CI 用固定 CLI 59.11.7 在 AL2023 构建后于断网容器执行。macOS 生成的 sharp 包只能做宿主诊断，不能交付 Linux。Fluid 当前计费模式忽略函数 memory 设置，1 GiB 测试是保守资源约束，不是生产内存配置证明。具体证据和边界见 [Vercel 函数包核验](docs/vercel-bundle-verification.md)。
- 过期请求通过独立 `GET /api/internal/reap` 调度恢复，使用独立 `CRON_SECRET`。2026-09-07 已只读核验 notchspi-api 使用 Node 24.x，所属团队为 Hobby；当前每分钟 Vercel cron 配置超出该套餐能力，会阻断部署。生产须落实已有外部分钟调度，或经费用授权升级支持分钟调度的套餐，再验证实际恢复日志。调度方案待确认，进程内计时器不能替代它。已收费请求的恢复失败或 worker 终止均只补偿一次 goodwill。

支付运营：Stripe webhook 必须同时订阅 `checkout.session.completed`、`checkout.session.async_payment_succeeded` 及 `refund.created` / `refund.updated` / `refund.failed`。受限 key 需要 Checkout Sessions read/write 和退款对象 read 权限，无需发起退款权限。订单入账与额度同事务；退款先读当前资源再按持久化 generation 应用，全额成功撤回未用 paid lot，处理中冻结，失败恢复。部分退款需 `/admin/payments/refund-decision` 的明确题数和当前指纹；历史 `legacy_unknown` 不猜测归属。`GET /admin/payments` 为受限核对视图，不能代替全量财务聚合。细节见 API 文档和发布记录。

购买恢复：`purchase-session.ts` 与共享 SQL 事务实现三存储一致语义。同一已鉴权 purchase ID 重试只换发随机短 secret、恢复原订单及期限；原短链接失效。Checkout ID/URL 持久化，丢失响应可恢复同一页面；已付款会话在充值事务中写 `consumed_at` 后禁止再次使用。过期短链接不阻断已经创建的 Checkout 延迟到账。`purchase-page.ts` 提供三语言购买/返回页，返回页仅提示回 App 核对余额。

异常付款：`checkout-reconciliation.ts` 统一最小快照、不可变归属与明确审核规则；Memory/共享 SQL 队列先提交签名收据，再应用额度事务。依赖缺失和 Stripe 读取失败延后重试，五次后交人工；财务冲突停在 review。`/admin/payments/checkouts` 提供分页查询、重核和带指纹/证据摘要/明确题数的审核 API，审核与额度同事务，不能重绑已知设备或购买归属。独立 reaper 每次最多取 3 个 Checkout；进程内支付恢复禁止重叠，并在关闭存储前等待结束。真实 Stripe 权限、版本、生产迁移与对账核验仍待完成。

未入账收款：`reporting-receipts.ts` 将签名 Checkout 投递按 Checkout / PaymentIntent 联合去重，并与截止时间前的全账户订单及历史充值核对。`cohort-economics-v2` 单列本批次已识别设备待入账、账户级身份未分配及冲突/缺失信息；后者不按来源分摊。确定已入账的收据排除；收据毛额不增加订单现金或 P28 分子，不改变额度。未核验净额保持未知，相关币种贡献停止计算。内部与外部归属冲突保留在账户冲突池，不能被内部设备排除隐藏。

`checkout_deliveries.recorded_at` 记录收据投影实际提交时间，防止延后处理的旧 webhook 回填到历史 as_of。SQLite/Postgres 启动增量加 nullable 列；旧行保留 NULL，不编造接收时间，报表列为历史时间未核验且不计入已确认毛额。查询仍使用同一一致事务及有界批次；旧 v1 归档没有收据字段时明确显示未知。

财务资源核对：`payment-finance*.ts` 维护通知序列、租约任务、资源唯一归属和不可变修订；`stripe-finance.ts` 只执行有界 GET。新订单自动发现，签名通知要求重核；正常核验每日更新，信息不完整每五分钟再查，读取失败一分钟后重试、五次转 review。独立 reaper 每次最多处理三笔，管理员可经 `/admin/payments/finance/reconcile` 重核。成功读取不代表所有费用或净额完整；`cohort-economics-v3` 展示核对覆盖、待重核、退款账本缺项及未决拒付。余额交易本金与费用分开，唯一交易不跨订单或多笔拒付重复计算；未知或未经核验的外汇转换阻断完整贡献。

财务通知另需订阅 charge succeeded/updated/refunded，以及 dispute created/updated/closed/funds_withdrawn/funds_reinstated；受限 key 需具备 Charges、Refunds、Disputes 及展开 Balance Transactions 的 GET 权限。完整事件名和 HTTP 读取见 API 文档，真实账户配置仍须核验。

财务发现漏记退款时，按明确的本地 `finance.refund.reconcile` 来源批量加入既有退款队列，由 worker 重新读当前 Stripe Refund 后更新原状态机；不发现金退款、不直接用早先快照改额度。回滚到不认识该本地事件类型的旧服务前，必须先排空这些待处理项并核验持有；保留新增财务表和归档。当前仅本机三存储、协议、页面验收通过；真实 Stripe 权限/资源、生产迁移、账户费用覆盖和汇率证据仍未核验。

`ALLOW_STUB_TOPUP=1` 只在本地显式开启。`amount_cents` 是币种最小单位（JPY 为日元整数，CNY/USD 为分）。

Postgres TLS 默认 `verify-full`。`ADMIN_TOKEN` 为空则全部 `/admin*` 为 404。

批次/经济查询：`/admin/cohorts`、`/admin/economics` 使用 `reporting.ts` 的定义与三存储一致快照，按 UTC 发生时间、同意覆盖、付款资源修订和历史 lot 计算；金额为十进制字符串，未知不是零，币种不隐式相加。`/admin/devices/internal` 维护可信内部设备排除；`/v1/device-source` 只记录自愿来源；`/admin/economics/expense-allocation` 保存有审计引用的累计分摊快照。

`/admin/reports` 提供成熟/覆盖、来源比较和成本/履约区间三个视图，以及不可变快照的保存、分页读取和 JSON 下载。页面不持久化密钥，数据端点均使用 Admin 鉴权。`/admin/reports/data` 从同一份事实快照生成各来源读数；保存接口重新核对已查看内容的 SHA-256，事实变化返回 409。`report_archives` 不随详细事件清理，读取时校验内容；90 天明细期外的实时查询返回 410，须读取此前保存的快照。归档是当时读数，不自动宣称质量/放量闸门通过。

`/admin/quality/reports` 提供第四个独立评测视图；`/admin/quality` 接收严格白名单的已评分逐题摘要，服务端只保存不可变聚合、源文件摘要和复核声明。相同 run 不能重绑执行版本，评分修订追加记录；撤回不删除审计，也不恢复旧评分。V1、fallback、范围覆盖和风险阻断分别计算，未知家族/真值保持未知。历史 240 题仅用 `legacy_objective`，不声明新支持范围；非 SPI 400 / 每题型 100 的样本要求仅计已声明组合中的已标注客观题。离线历史核对、上传及审查边界见 [质量记录操作说明](docs/quality-evidence.md)。

`run-reading-eval.mjs` 按完整授权 manifest 经隔离官方服务运行新合约，使用同一 100 CNY 累计预算；每题冻结 UUID、保留失败，立即抽取解释及无答案入口拒绝检查。`prepare-reading-quality.mjs` 限量逐文件重读原始响应、重算评分、核对执行顺序和独立复核摘要；答案与解释成本/判断分别归档，禁止自动重试、补签或把部分运行称为完整。详见 [阅读评测操作说明](docs/reading-evaluation.md)。执行适配器已实现；真实授权 holdout、模型结果、至少 80 个解释复核、准确候选同模型基线及完整财务收尾仍待完成。

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
