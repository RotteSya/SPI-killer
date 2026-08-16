# NotchSPI — 项目单一真理源
> 本文件是本仓库唯一权威说明。README.md 只面向终端用户。
> 任何与本文件冲突的文档以本文件为准；发现冲突请修文档，不要修代码去迁就文档。

## 1. 30 秒认知
- macOS 刘海 AI 解题助手：NSPanel + ScreenCaptureKit，热键截屏并流式讲解。
- 双组件：Swift 客户端（本仓库根）+ Node 服务端（`server/`）。
- 当前版本：看 `scripts/make-dmg.sh` 的 `VERSION`（约 :13）与 `CFBundleVersion`（约 :49）。不要把数字抄到别处。
- 生产服务：https://notchspi-api.vercel.app

## 2. 仓库拓扑
```
~/Developer/AppleApps/notch-SPI/     ← 外层文件夹，不是 git 仓库
└── native/                          ← ★ git 仓库根 = git@github.com:RotteSya/notch-SPI.git
    ├── Package.swift
    └── server/                      ← ★ Vercel Root Directory = "server"
```
git 仓库根 = `native/`，不是 `notch-SPI/`。Vercel Root Directory = `server`（不是 `native/server`）。

## 3. 60 秒跑起来
### 客户端
```sh
swift build -c release && .build/release/NotchSPI
```
### 服务端（零密钥，mock provider）
```sh
cd server && npm ci
DB_PATH=':memory:' OFFICIAL_PROVIDER=mock ALLOW_STUB_TOPUP=1 npm start
```
### 指向本地服务端
```sh
.build/debug/NotchSPI -official.baseURL http://localhost:8787
```

## 4. 架构与依赖拓扑
### 4.1 客户端
| 目录 | 职责 | 关键文件 |
|---|---|---|
| App/ | 启动、L10n | main.swift, AppDelegate.swift, L10n.swift |
| Notch/ | 刘海面板、流水线、性格会话 | NotchController.swift, NotchView.swift, TutorModel.swift |
| UI/ | Aurora、引导零件 | AuroraBackgroundView.swift |
| Cloud/ | 官方额度、引导窗 | OfficialAPI.swift, OnboardingWindow.swift |
| Settings/ | 设置、热键、人物像、Keychain | Settings.swift, MainSettingsWindow.swift |
| Capture/ | SCK→JPEG、上下文图缓存 | ScreenCapture.swift, ScreenshotCacheManager.swift |
| CLI/ | 自定义 Key / 本机 CLI、提示词 | Prompts.swift, APIKeyRunner.swift |
| Update/ | `GET /update` + `GET /dl` | UpdateChecker.swift |

### 4.2 服务端
| 文件 | 职责 |
|---|---|
| src/index.ts | Fastify 引导；`buildApp` 供测试/Vercel 复用 |
| src/config.ts | 环境配置（全部有安全默认） |
| src/routes.ts | 全部 HTTP 路由 |
| src/auth.ts | Bearer + 遥测三头 |
| src/http.ts | 错误体 + SSE 帧 |
| src/db.ts | Store 接口 + token 哈希 |
| src/db-postgres.ts | 生产存储（动态 import） |
| src/db-sqlite.ts | 本地开发存储（动态 import） |
| src/db-memory.ts | Serverless 回退（动态 import） |
| src/storage.ts | 按环境选择存储 |
| src/pricing.ts | 题包目录 |
| src/payments.ts | 充值页 + PaymentProvider |
| src/stripe.ts | Checkout + webhook 验签 |
| src/site.ts | 产品落地页 |
| src/admin.ts | 管理后台 HTML |
| src/rateLimit.ts | 注册/并发限流 |
| src/providers/index.ts | 厂商选择 |
| src/providers/types.ts | Provider 接口 |
| src/providers/anthropic.ts | Anthropic 代理 |
| src/providers/openai.ts | OpenAI 代理 |
| src/providers/mock.ts | 无密钥 mock |
| api/index.ts | Vercel 入口 |

### 4.3 一次问答
热键 → `OfficialAPI.warmUp()`（发 `x-client-event: hotkey`）→ ScreenCapture（SCK→临时 JPEG）
→ `Prompts.build` → `OfficialAPI.capture`（SSE）→ `auth.ts`（遥测三头）
→ `routes.ts` `reserveQuestions` 预扣 → provider → SSE `delta`
→ `settleReservation` / `releaseReservation` → AnswerComposer → NotchView

### 4.4 依赖
Swift = 零第三方。Node = `fastify` + `pg`。

## 5. 三条应答通道与计费
| 通道 | 何时用 | 扣题 |
|---|---|---|
| 官方服务 | 默认 | 预扣—结算，失败不扣 |
| 自定义 API Key | 设置 → 高级 | 不经官方，不扣题 |
| 本机 CLI | 默认关，`POST /admin/cli` 按设备码开 | 不经官方，不扣题 |

完整契约：[`docs/official-api.md`](docs/official-api.md)。
不变量：一次成功问答 = 1 题；失败不扣；并发靠预扣不会扣成负数。
热键定义在 `Settings.swift`：
- `⌘⇧1` 讲题
- `⌘⇧2` 上下文追问（带上上次 ⌘⇧1 截图）
- `⌘⇧9` 性格测验
- `⌘⇧0` 自动连答
- `⌘⇧Space` 显隐

## 6. 发版流程
1. 改 `scripts/make-dmg.sh` 的 `VERSION` 与 `CFBundleVersion`。
2. 同步 `Sources/NotchSPI/Update/UpdateChecker.swift` 的 `devFallbackVersion`。
3. 同步 `scripts/make-qa-app.sh` 的 `VERSION` / `CFBundleVersion`。
4. commit + `git push origin main`（服务端改动会触发 Vercel 自动部署）。远端 git 操作交还所有者，AI 不得自行 push。
5. `bash scripts/make-dmg.sh` — 构建 + Developer ID 签名 + 公证 + staple；默认上传夸克网盘（`PUBLISH_QUARK=0` 可跳过）。产物是 `dist/NotchSPI.dmg`（`scripts/publish-quark.sh` 独立重传读这个文件）。
6. `git tag vX.Y && git push origin vX.Y`
7. `gh release create vX.Y dist/NotchSPI.dmg`（内部存储；产品面不出现 GitHub）。
8. 验证：`curl https://notchspi-api.vercel.app/update` → 版本号已更新。

★ 服务端契约的新字段必须先于客户端部署（前向兼容）。

## 7. 测试与验证
- `swift test` — 客户端单元测试，无网络无密钥。通过数以命令输出为准。
- `cd server && npm test` — 单元 + HTTP 集成。
- `cd server && npm run typecheck`
- 性格测试发版闸门（要真实模型，要花钱）：阈值在 `Tests/Fixtures/Personality/manifest.json` 的 `thresholds`；跑法与二人复核见 [`Tests/Fixtures/Personality/README.md`](Tests/Fixtures/Personality/README.md)。评测 JSONL 落在 `.eval-results/personality/`（已 gitignore）。跑闸门时测试会按需重建 `docs/evals/personality/` 写脱敏 Markdown，那是产出不是现状。

## 8. 视觉 QA 钩子
DEBUG only。截屏必须同时设 `NSPI_VISUAL_QA=1`（否则 `sharingType=.none` 拍不到）。`NSPI_QA_EPHEMERAL=1` 保护真实 Keychain。

| 参数 | 作用 | 定义 |
|---|---|---|
| `--qa-regular` | 以常规 App 运行 | `App/main.swift` |
| `--qa-onboarding` | 强制显示引导 | `Notch/NotchController.swift` |
| `--qa-onboarding-page N` | 跳到引导第 N 页 | `Cloud/OnboardingWindow.swift` |
| `--qa-settings-page N` | 打开设置第 N 页（0–5） | `App/AppDelegate.swift` |
| `--qa-settings-autoplay` | 设置窗自动轮播 | `App/AppDelegate.swift` |
| `--qa-appearance light\|dark` | 强制外观 | `App/AppDelegate.swift` |
| `--qa-notch <state>` | 把刘海钉在指定状态 | `App/AppDelegate.swift` |
| `--qa-capture [N]` | 程序化触发 N 次截图问答（间隔 6s） | `App/AppDelegate.swift` |
| `--qa-auto-mode` | 直接进入自动连续截图 | `App/AppDelegate.swift` |

QA 环境变量：`NSPI_QA_EPHEMERAL` `NSPI_VISUAL_QA` `NSPI_QA_AUTOCLAIM` `NSPI_QA_AUTOPLAY` `NSPI_QA_BALANCE` `NSPI_QA_GIFT` `NSPI_QA_NOTCH` `NSPI_QA_PERSONAS` `NSPI_QA_RECORDING` `NSPI_QA_REDUCE_MOTION` `NSPI_QA_SLOW_NAV` `NSPI_QA_THEME` `NSPI_SLOW_MORPH`。
评测类 `NSPI_EVAL_*` / `NSPI_RUN_*` 见 `Tests/Fixtures/Personality/README.md`。

## 9. 已知陷阱 / 反幻觉清单
- ⌘⇧3–6 是 macOS 系统截图死键，永远不要占用（性格测验在 ⌘⇧9，自动连答在 ⌘⇧0）。
- 面板 `sharingType = .none`，普通截屏拍不到 App 自己的窗口。
- Vercel 日志只保留一个多小时，事后查不到。
- `legacy` / `retired` / `migrate` 是装机量迁移路径，不是技术债：UserDefaults API Key→Keychain（`Settings.swift`）、device token→Keychain（`OfficialAPI.swift`，删了已购题数归零）、单人物像→人物像库（`PersonaStore.swift`）、`answerSize` 三档→连续字号（`Theme.swift`）、`image_base64` 单图兼容（`routes.ts`）、`"claude"`/`"codex"` 旧 storageKey（`APIProvider.swift`）。
- `x-app-version` / `x-onboarded` / `x-client-event` 三个请求头驱动全部经营数据（`auth.ts`）。`recordHotkeyPress` 只由 `x-client-event: hotkey` 触发。
- `db-postgres` / `db-memory` / `db-sqlite` 是动态 import，静态搜不到引用。
- 大单文件 + 文件私有类型是刻意设计，「只在本文件引用」不等于死代码。
- 默认试用额度是 `[TRIAL_MIN_QUESTIONS, TRIAL_MAX_QUESTIONS]` 随机（`routes.ts`），180 只是对外宣传上限。

## 10. 本仓库的改动约束
- 不装任何全局依赖；不改系统设置、不碰生产（Vercel / Stripe / Postgres / 夸克）。
- 改动前先跑 §7 建基线，改完必须回到同一通过数。
- 远端 git（push / push --delete / 改远端分支）一律交还所有者。
- 文档与代码冲突时：修文档。
- 不拆 `MainSettingsWindow.swift` / `NotchController.swift` / `routes.ts`；不移动 `native/` 或 `server/`。
