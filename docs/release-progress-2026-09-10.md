# 发布进度 · 2026-09-10

当前发布分支代码为 `3dd61c1f8092858641e2b91eef4be241a28a5323`。客户端修复提交 `3c7a0b7`，其后只调整调度器开发依赖；两提交的 62 个客户端/资源/打包输入摘要完全一致。新包已公证，CI 10/10 通过，仍未公开发布、未部署新版生产或启用新能力。任务范围及原有门槛继续遵循批准蓝图。

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
| 文件 | `dist/NotchSPI.dmg`，3,050,523 字节 |
| SHA-256 | `951584ba17a6e47d2aef879f8c61905461adb2ab198b3d03256a978c7a8c2b0e` |
| Apple 公证 | `2621bb94-afcf-4ff4-aab4-c6337815dd6b`，Accepted |
| 本机验证 | 装订、hdiutil verify、只读挂载 strict codesign、Gatekeeper 全部通过 |
| 输入对应 | 62 项摘要匹配客户端提交及最终调度器修复提交 |

旧 `345d677` 安装包保留于 `.release-evidence/2026-09-09/pre-explanation-status-dist/`，不能将其作为包含新修复的当前包。

## 剩余发布条件

仍缺恢复/解释完成界面与整体运行稳定性验收、正式 400 题留出集和当前候选真实模型评测、80 份独立解释复核。公开候选题的 306 题准备状态继承 [题集获取记录](public-corpus-acquisition-2026-09-09.md)，未产生新的质量分数。模型评测 campaign 仍为累计 CNY 100，未重置。

生产旧写入隔离、停流备份/迁移与兼容回退、支付端到端对账、独立恢复定时触发、反馈删除演练和分档观察门槛仍待完成。CNY 20/日的生产预算待新版实际部署后生效，首周观察从真实上线时间起算。没有因本轮软件验证通过而扩大范围或切换生产。

本轮证据统一位于 `.release-evidence/2026-09-09/new-contract-ui/`（跨午夜继续同一次测试）：`runtime-validation.json`、`before-fix-validation.json`、客户端/代理日志、`cleanup.json`、Swift 日志、两次 CI 状态与日志、调度器修复前后审计/测试/构建、`notarized-artifact-manifest.json` 和 `release-input-compatibility.json`。原始 App 采样及临时文件清单为 0600 私有文件；测试服务和受控响应不进入发布 payload。
