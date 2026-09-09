# 发布进度 · 2026-09-10

当前发布分支代码为 `402d2657590bf19987f04f48c27a9781fa1dbee3`。账号配置隔离修复已通过本地 Swift 与云端 CI，新包已重新公证、装订及 Gatekeeper 验证，62 个打包输入与该提交逐字节一致。仍未公开发布、未部署新版生产或启用新能力，原有正式验收门槛继续保留。

## 账号配置隔离修复

`402d265` 修复远端功能配置的账号/服务串用：旧缓存不含身份绑定，切换账号后旧请求还可能覆盖配置。新的 v2 缓存按服务地址和 token 的长度前缀 SHA-256 绑定，不落盘明文凭证；身份或 generation 变化立即取消旧任务、清除缓存并回到基础配置。返回时再次核验账号与请求所有权，旧任务结束不会清除新任务。运行中和磁盘恢复均核验 24 小时有效期，拒绝未来时间；旧 v1 缓存直接失效。HTTP 复用最多 64 KiB、拒绝重定向的账户读取实现，并设 8 秒请求超时。

新增 5 项真实 loopback HTTP 回归覆盖迟到响应、请求替换、账号/服务变更、缓存恢复/过期/未来时间、旧缓存迁移、超大正文与重定向凭证隔离。本地 warnings-as-errors 完整执行 302 项，2 项真实模型评测跳过，0 失败。[CI 34375451627](https://github.com/RotteSya/notch-SPI/actions/runs/34375451627) 对应同一提交，10/10 成功，完整日志已留存。生产模型质量、实机界面和上线观察不由这些软件测试替代。

## 已完成的修复与验证

实机新合约查题返回 `B`，点击“查看解释”后正文实际显示、账户余额保持不变，但标题仍永久停在“正在生成解释”。`3c7a0b7` 在成功完成回调中设置三语“解释已生成”；失败处理、原答案及已有上下文绑定检查保留。Swift warnings-as-errors 执行 297 项，2 项真实模型评测显式跳过，0 失败。修复后的完成文案尚缺实机观察，不能以代码检查冒充视觉验收。

首次 [CI 34373189927](https://github.com/RotteSya/notch-SPI/actions/runs/34373189927) 在调度器 npm audit 失败，其他九项成功。原因是 Miniflare 间接固定 sharp 0.35.2，被 [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) 拦下；修复版为 0.35.4。查询到的新 Miniflare 仍依赖 0.35.2，因此 `3dd61c1` 为 sharp 添加精确 override 并更新各平台可选原生包锁定，未按 audit 的建议强制降级整套 Wrangler。

本地重新安装后安全审计为 0 漏洞，Wrangler 4.129.1 类型生成核对、TypeScript、14 项调度器测试（含真实 workerd 定时入口）和 dry-run 构建全部通过。调度器运行源代码未改，当前 Cloudflare 部署仍保持暂停触发。最终 [CI 34374285999](https://github.com/RotteSya/notch-SPI/actions/runs/34374285999) 十项全部成功，覆盖 macOS、Node 22/24、PostgreSQL 16/17、Cloudflare、AL2023 原生资源和 Vercel Linux 包。完整日志确认 Node 22/24 各 509 项，PostgreSQL 16/17 × Node 22/24 四组各 630 项；macOS 297 项、2 项模型评测跳过、0 失败。

## 新合约与断线恢复实测

测试在隔离 QA App、临时 SQLite 和 localhost 服务中执行，服务使用真实路由/账本与受控 provider。没有厂商模型或支付调用。四次成功实际截图的捕获至编码耗时为 376.945、143.168、260.783、195.571ms；这四个样本不构成正式 p95 性能验收。

两个隔离账户各有一次旧协议预热和一次 `screen_query_v1` 查题，均 30→28、累计 2 题。第一账户的新协议答案和解释正文已通过辅助功能树核对；解释记录为 usable、released，无额外题目预留或扣费。

第二账户的新合约返回经过测试代理：先完整收取服务端已 settled 且带 DONE 的响应，再只向客户端发送不完整的 `FI` 增量并断开。客户端实际查询原请求状态，显示“本次已结算。可从设置菜单恢复答案，不另扣题”。菜单恢复操作已点击，真实 `/recovery` 请求完成，服务端记录为 `screen_query_v1`、parserPath=v1、usable、released，余额仍为 28。共 6 个请求记录（4 solve、1 explain、1 recover），只有 4 个 settled 题目预留，无 held。

恢复后的界面读取反复超时，未验证最终恢复答案显示，也未验证恢复后解释。两秒 App 采样显示主线程正常事件循环，不能据此排除异步或系统截图问题。原版实机框选还复现图片接口约 10 秒超时，没有新增请求/扣题；在已授权范围内重启当前用户 replayd 后，后续自动截图成功，但观察工具问题仍存在。不得将单次服务恢复当作平台稳定。

QA 用 SIGINT 停止，不计正常退出；localhost 服务正常关闭。依据启动时间、目录前缀、所有者及精确文件属性核对并删除 2 张本轮临时 JPEG，剩余 0。SQLite 完整性检查通过。

## 当前安装包

| 项目 | 证据 |
|---|---|
| 版本 / 构建 | 2.12 / 19，arm64，最低 macOS 14.0 |
| 文件 | `dist/NotchSPI.dmg`，3,056,302 字节 |
| SHA-256 | `54430911890d19efb0512fe5a2103f7a0da89abfe97ff0ef63f4e04f72475ee3` |
| Apple 公证 | `ef24b564-16ab-4986-82b6-b6c06c02eb5a`，Accepted |
| 本机验证 | 装订、hdiutil verify、只读挂载 strict codesign、Gatekeeper 全部通过 |
| 输入对应 | 62 项摘要匹配 `402d265` 的客户端、资源及打包输入 |

本次重新打包前的 `3c7a0b7` 安装包保留于 `.release-evidence/2026-09-10/pre-config-isolation-dist/`。更早的 `345d677` 安装包保留于 `.release-evidence/2026-09-09/pre-explanation-status-dist/`，不能将其作为包含新修复的当前包。

## 剩余发布条件

仍缺恢复/解释完成界面与整体运行稳定性验收、正式 400 题留出集和当前候选真实模型评测、80 份独立解释复核。公开候选题的 306 题准备状态继承 [题集获取记录](public-corpus-acquisition-2026-09-09.md)，未产生新的质量分数。模型评测 campaign 仍为累计 CNY 100，未重置。

生产旧写入隔离、停流备份/迁移与兼容回退、支付端到端对账、独立恢复定时触发、反馈删除演练和分档观察门槛仍待完成。CNY 20/日的生产预算待新版实际部署后生效，首周观察从真实上线时间起算。没有因本轮软件验证通过而扩大范围或切换生产。

本轮证据统一位于 `.release-evidence/2026-09-09/new-contract-ui/`（跨午夜继续同一次测试）：`runtime-validation.json`、`before-fix-validation.json`、客户端/代理日志、`cleanup.json`、Swift 日志、两次 CI 状态与日志、调度器修复前后审计/测试/构建、`notarized-artifact-manifest.json` 和 `release-input-compatibility.json`。原始 App 采样及临时文件清单为 0600 私有文件；测试服务和受控响应不进入发布 payload。

账号配置修复的证据单独位于 `.release-evidence/2026-09-10/config-isolation/`：`focused.log`、`swift-full.log`、`ci-status.json`、`ci.log`、`release-package.log`、`package-inputs.json`、`artifact-verification.log` 和 `notarized-artifact-manifest.json`。没有新增付费模型调用，也没有更改生产预算或触发器。

## 当前候选实机复验与观察环境阻断

对 `402d265` 的真实 DEBUG 二进制再执行两次隔离启动；受控 provider、生产请求路由/存储及故障代理在 localhost，未调用厂商模型或真实支付。首次启动第一张实际截图成功（捕获到编码 466.176ms），第二张图片接口在 10,392.761ms 超时，第三个计划触发因已有任务运行而未新增查题。账户保持 29 题、累计 1 题；正常退出快捷键生效，进程退出码 0。

按用户已有授权重启当前用户 replayd，第二次启动避开截图期间的界面观察，连续三张实际截图成功，耗时 451.149、221.125、169.714ms。前两次是旧协议预热和新协议查题，第三次为新协议已结算后故障代理断流。实际界面确认“本次已结算。可从设置菜单恢复答案，不另扣题”，设置菜单显示剩余 27 题与恢复操作；点击后真实 recovery 请求完成，余额仍为 27，累计主查题 3。共 5 个请求记录（4 solve、1 recover），只有 4 个 settled 额度预留，恢复为 usable/released，无 held。没有新增解释调用。

恢复结果界面读取再次长时间超时。保留的两秒 App 采样显示主线程处在正常事件循环；同时 replayd 的 connectionManagerQueue 持续执行集合插入和字典比较，与之前症状一致。这是相关诊断证据，尚不能判定是 App、界面观察工具或系统多客户端交互的根因。等所有观察调用明确结束后，仅重启截图服务并保留 App 的恢复现场；按 bundle ID 和准确 App 路径读取仍超时。故恢复答案可见性、修复后的解释完成标题和整体稳定性继续不通过。第二个 App 的正常退出工具请求亦未返回，最后为结束本轮测试发送 SIGINT，退出码 130，不能记作正常退出验收。

QA 与 localhost 服务均已停止，所有工具调用已终结。核对 uid、文件类型、大小及创建/修改时间后清理 1 张本轮遗留图，临时截图/题组文件合计 0；SQLite WAL 已 checkpoint，integrity_check=ok。证据位于 `.release-evidence/2026-09-10/final-ui/`，包括原始请求/捕获日志、断线辅助功能记录、两份私有采样、重启记录、`runtime-validation.json` 和 `cleanup.json`。这些样本不构成 p95 性能或全部设备配置通过。

下一步实机验收需要恢复可靠的系统/观察环境。仅重启截图服务尚未奏效；可在保存工作后重启整台 Mac，或改用另一台已授权测试 Mac。整机重启会影响所有应用，区别于已授权且执行过的截图服务重启，尚未执行。题集复核和其他独立准备可以继续，生产新能力仍不放行。

## 题库统一复核入口

为现有 306 题生成私有 `public-corpus/REVIEW-INDEX.md` 与 `unified-review-index.json`，逐行关联题图/材料、来源标准答案、原始记录 SHA-256、候选家族和优先待审事项。424 张输入图片全部重新解码并匹配既有摘要，434 个 Markdown 本地链接均存在。单选/多选/短填各 100、排序 6；保守家族候选 215，仍待题源关系核验。所有独立复核者字段为空、正式 holdout 标志为 false，没有把索引生成或图片完整性检查当成真值验收。源码和安装包未变，无需以文档更新重新打包。

## 排序题与多目标风险材料补充

后续补充 2017—2019 年 STA 正式数学原卷/评分标准的 DERA 档案 9 份，完整性与版权尾页核验完成。4 道真正要求序列输出的题已逐题目视对照答案，并完成 3 张完整单题区域的视觉检查；整数降序、分数、小数和 kg 单位均保留。复核队列现在为 310 题、428 张输入图片，排序 10 道，距离排序计划仍差 90。原有 306 条统一记录未改变。

额外准备 3 个真实 PDF 双题同屏风险变体，待核验预期为 `no_result / multiple_targets`；它们与对应单题绑定同一家族，不计为新增独立题。统一索引和风险索引共 448 个本地链接已验证。详细来源、答案、截图和归属证据见 [公开题集记录](public-corpus-acquisition-2026-09-09.md)。仍无正式独立签署或模型质量分数，本轮付费模型调用 0。产品代码、公证包和 CI 对应关系保持 `402d265`；只增加评测准备与文档，无需重新编译或打包。

尚未收到整机重启确认，未再启动 GUI 测试或重启整机。实机环境、正式留出集/解释复核及生产放行条件继续保留。


## 隔离候选部署与受保护评测入口

- 已将产品代码 `402d2657590bf19987f04f48c27a9781fa1dbee3` 的 CI `34375451627` Linux 产物部署为受保护 **Preview**，部署 ID `dpl_3FHcw9x9bXGBsPYDoebnLuDhJEwC`，状态 READY。唯一部署地址 `https://notchspi-ckatjw33a-rottesyas-projects.vercel.app`；专用别名 `https://notchspi-reading-eval-20260910.vercel.app`。
- 551 个函数文件的长度和 SHA-256 全部匹配 CI manifest；归档 SHA-256 `253e756f6c62af113af7441db250d51b13d7ec6e6e7760207e49f3246687bc22`。仅 `robots.txt` 静态公开，线上源码和测试路径均 404。生产部署仍为 `dpl_BStwrGFdwhRC7FP3g2m6snSpcgfC`，未切流、未公开新版安装包。
- 发现全局 preview 原本继承生产 Postgres/Stripe 凭证，部署前以本次部署专属变量覆盖清空。使用已有独立 EVAL Neon 项目 `quiet-fog-35366490`，新建空库及账号 `notchspi_eval_20260910`；账号无建库/建角色/管理员/复制/绕过 RLS 权限，不属于其他角色。已验证能在自己库内执行事务，不能切换管理员，不能读取原有 EVAL 表。没有使用生产库副本或真实客户数据。
- 专用 HMAC、管理员及恢复凭证仅存私有 0600 文件和部署变量；只继承现有 Anthropic 模型凭证。候选两路均配置 `claude-opus-4-8`，4096 输出上限；配置修订 `candidate-402d265-reading-20260910`，仅隔离候选开放 reading_practice 合约和解释。CNY 20/日、上海零点、单次保守预留 CNY 10；评测仍必须受原有 CNY 100 整轮账本准入，未重置账本。
- 实际未登录访问唯一地址与别名均 302 到 Vercel SSO；授权健康检查 200、Postgres、Anthropic 两路健康、payments=disabled。Checkout、stub 和 webhook 均 404。注册重试返回同一个设备和 30 题；SQL 在新库核对 1 设备、1 lot、1 初始 ledger，capture/model_attempts/attempt_costs/budget_windows/usage/topups 全为 0。鉴权 `/api/internal/reap` 实际 200、无待处理任务。
- 补齐 `evaluation-access.mts` 并接入 Objective、legacy、reading 三个执行器：15 秒交换期限、响应取消、单 origin Cookie、有效期检查、拒绝跨域与重复/无效 Cookie、错误不泄漏凭证。reading 的健康/账户/配置准入和答案/解释调用均使用它。4 项访问边界测试，加 1 项完整受保护阅读执行/归档无凭证测试；针对性 25/25、完整服务端 514/514、TypeScript 通过。未改 App 或服务端生产模块，因此当前公证 DMG 与产品候选仍对应 `402d265`。
- 前置命令曾因 preview 不支持 `--skip-domain` 被 CLI 拒绝，移除仅适用于 production 的参数后 dry-run/deploy 通过；首轮恢复探针路径误写 `/internal/reap` 得到 404，改用实际 `/api/internal/reap` 后通过。两次原始失败记录保留，没有把它们计为产品运行失败或隐去。

本轮未请求模型、未扣测试题、未发起支付。READY 与上述检查只证明候选部署/存储/鉴权/配置可用，尚未证明供应商实际回答、完整图片解码、准确率或延迟。正式评测仍缺完整已复核题集、独立签署、绑定候选的有效成本上界和完整计划准入；当前测试账号仅 30 题，未提前授予批量额度。候选定时恢复尚未自动调度，付费跑题前须接好专用调度并验证实际到期恢复；生产 Cloudflare 调度继续暂停。实机截图的最终 UI 验收仍待系统环境恢复，整机重启未擅自执行。

原始证据保存在本机 `.release-evidence/2026-09-10/candidate-deployment/`：`artifact-integrity.json`、`candidate-db-provisioning.json`、`deployment-plan.json`、`preview-health.json`、`preview-verification.json`、`alias-protection.json`、`access-reading-tests.log`、`node-full.log`、`typecheck.log`。`private/` 中的数据库连接、访问 Cookie/token 和 CLI 原始响应不得上传 Git 或发布资产。
