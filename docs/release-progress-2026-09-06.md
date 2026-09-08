# 2.12 / build 19 实施与发布进度

状态：**2026-09-08 候选已完成 Developer ID 签名、Apple 公证及 DMG 装订，尚未公开发布。** Cloudflare 恢复 Worker 已部署但暂停；CNY 20/日预算配置已写入 Vercel 并回读，新服务部署后生效。最新进度见 [2026-09-08 发布记录](release-progress-2026-09-08.md)。以下为历史周期记录；其中缺少授权、公证及预算的结论已被新记录取代。

## 实际 Vercel 打包检查补充

2026-09-07 对 `90e368e` 执行真实 Vercel CLI 构建，发现默认静态输出包含 115 个源码/测试文件。对现网两条路径的 HEAD 检查也返回 200；没有读取正文。新增 `outputDirectory=public` 与实际 robots.txt 后，本地构建静态清单仅有该文件，打包入口的三语页面、鉴权恢复、30 题注册、SSE 单次结算、动态 SQL 导入与原生图片校验通过。旧快照重新构建后被新增产物检查明确拒绝，保留失败日志。

后续 [CI 34069961702](https://github.com/RotteSya/notch-SPI/actions/runs/34069961702) 对 `a797ef18c8d2ce7c808e240e25c93dc8b2563041` 的 9 个任务全部通过：两个 Node 版本各 507/0/0；四个 Postgres 16/17 × Node 22.18/24.20 组合各 627/0/0；Swift 273 执行、2 个显式模型评测跳过、0 失败，warnings-as-errors 与 arm64 Release 编译通过。严格 TypeScript 和生产依赖审计通过。原生 1 GiB 资源探针与新增 Vercel 函数包任务均通过。

函数包由 CLI 59.11.7 / @vercel/node 12.0.1 在 AL2023、Node 24.20.0、x86_64 上生成，551 个函数文件、23,007,333 字节；加上路由配置和 robots.txt 共 553 个文件。下载后逐文件 SHA-256 和公开资产内容核对通过；归档 SHA-256 为 `c47fb6c770beed5b90c59d30a186f18950eba71e8d243896a3ad69a33b9590b0`。诊断方法、产物检查和生产边界见 [Vercel 函数包核验](vercel-bundle-verification.md)。Swift 源码及已签名 QA 二进制未变化。此修复尚未部署，现网静态源码暴露尚未消除。

生产环境只读配置审计确认缺少 `MODEL_DAILY_BUDGET_MICROS`、`ATTEMPT_BUDGET_UPPER_MICROS` 与 `CRON_SECRET`，新能力所需 HMAC 密钥也未配置。Vercel 将 provider/model、数据库和 Stripe 敏感值返回为遮蔽标记，不能用这些标记执行有效配置或权限核验；价格注册表可见，但未能与被遮蔽的实际模型核对。私有临时文件已删除，没有启动候选服务或数据库迁移。现有 100 CNY 授权只适用于评测，生产预算需批准的运营基线。

Apple 公证只读预检退出 69：发行脚本默认钥匙串 profile `notchtutor` 不存在。未提交公证任务，未生成正式 DMG。生产仍是原 deployment `dpl_BStwrGFdwhRC7FP3g2m6snSpcgfC` / READY；Hobby 分钟调度方案、Stripe 重新认证、真实 UI/质量数据、备份迁移和分档观察仍待完成。

## 基线与授权

Git 基线为 `7ba96db7408b8e203adfb133947535a604806fb0`。接手时已有 46 个 tracked 文件修改和一批新增的结算、题组、区域选择、评测预算文件；保留并在其上集成，不将这些先存改动冒称本轮从零实现。工作区尚未形成最终发布提交。

用户本轮明确授权实现、依赖处理、打包和部署，故不把仓库常规 owner-only 提示作为重新索取发布授权的理由。实际部署仍必须满足蓝图的技术、独立评测及分档观察门槛。本轮未读取或改写生产数据库，未调用真实付款或模型服务。

## 本轮完成的加固

| 组件 | 最终行为 | 证据 |
|---|---|---|
| 恢复请求与补偿 | 成功子请求保存自己的结果状态、解析路径和答案 HMAC；父请求仍只扣 1。失败或 worker 死亡由同一结算路径补偿 1 goodwill，重复 reaper/迟到回调不重复补偿或撤销补偿 | memory/SQLite/Postgres 行为测试及 HTTP/SSE 测试 |
| 辅助调用响应 | explain/recover 终态报告 `not_required`、charge=0；持久化完成后发送结果及 usage；数据库终态不可确认时关闭流并要求核对 | 双存储 HTTP 契约；Swift 终态验证 |
| 官方预算 | control/treatment 与 solve/explain/recover 共用官方每日预算；预算持有绑定设备；其他设备不可消费、释放或结算。真实超支保留，unknown 保持上界 | 三存储并发、超支、所有权与重复终态测试 |
| 生产启动闸门 | fixed30、真实 provider、已知价格/版本/币种、有限预算及 Serverless 恢复凭证缺失时拒绝启动 | `production-admission.test.ts` |
| 独立恢复入口 | `GET /api/internal/reap` 使用独立调度凭证；限定批量与批次间时间预算；可与其他 worker 安全并发 | 两存储认证及重叠 sweep 测试；`server/vercel.json` |
| 诊断协议 | malformed/mixed no-result 归为 failed/no_usable_result，不伪装有效范围拒绝；数组不可冒充原因字符串 | Node/Swift 诊断与逐字符过滤测试 |
| 输入与遥测 | 大图 base64 校验避免正则重复分组栈耗尽；schema 2 枚举拒绝可强转字符串的数组/对象 | 2 MiB 编码输入及白名单测试 |
| 余额版本 | SQLite 以 bigint 读取并以十进制字符串输出，客户端按整数语义比较，超过 2^53 不舍入 | SQLite 实库测试、Swift 版本比较测试 |
| 客户端材料隔离 | 覆盖 3 张参考＋末尾问题图、容量拒绝、15 分钟失效、换通道/窗口隔离、文件租约及 0600 权限；补材料、框选和 adopt 的旧回调不结束新请求 | 新增 `QuestionSessionTests.swift`；串行 Swift 回归 |
| 客户端恢复动作 | 断线后可查询原请求并明确选择“恢复本次答案”，重传冻结材料、不重新截图、不自动复制恢复候选；解释任务保留取消句柄 | 编译与协议测试通过，真实 DEBUG 点击路径待解锁验收 |
| 版本和包装 | `VERSION.env` 更新为 2.12 / 19；arm64 QA 包使用 Developer ID 和 hardened runtime 签名，plist、签名和图标摘要通过 | 本地产物及 manifest |

## 构建与测试结果

| 执行 | 结果 | 本地日志 |
|---|---|---|
| 接手基线 `./scripts/verify.sh` | Node 172 通过；Swift 172（2 跳过，0 失败）；Release 编译通过 | `.release-evidence/2026-09-06/verify-baseline.log` |
| 最终 `./scripts/verify.sh` | Node 207 全通过；Swift 179（2 跳过，0 失败）；repo-health、TypeScript strict、隔离服务 smoke、warnings-as-errors Swift 测试、arm64 Release、差异空白检查通过 | `.release-evidence/2026-09-06/verify-final.log` |
| 隔离 Postgres 全套 Node | **231 全通过，0 跳过，0 失败**。包含旧 Store 套件和新 billing 套件；后者在独立随机 schema 内运行 | `.release-evidence/2026-09-06/node-postgres.log` |
| `./scripts/package.sh qa` | Developer ID 签名与 strict 验证通过 | `.release-evidence/2026-09-06/package-qa.log` |
| plist/资产验证 | 2.12 / 19、macOS 14.0、原 bundle ID 正确；图标与源资源一致；4 个 bundle 文件有 SHA-256 | `.release-evidence/2026-09-06/artifact-manifest.json` |
| 离线评测 preflight | 退出 2，表示评测条件不满足；既有 240 图 SHA 全匹配；新增模型调用 0 | `.release-evidence/2026-09-06/evaluation-preflight.log` |

测试 Postgres 为本轮安装的本机 PostgreSQL 17，临时集群位于被忽略的 `.release-evidence/2026-09-06/postgres`，数据库 `notchspi_release_test`，仅监听 `127.0.0.1:18793`。未使用生产连接；测试后已停止进程，未配置开机服务。本地 TLS disabled 仅用于这一回环测试，生产仍按既有 TLS 验证规则。

签名 QA 产物：`dist-qa/NotchSPI.app`。上表对应初始候选；最新重建产物与摘要见下方输入解码与流协议故障验证周期。该产物不是正式发布 DMG，不能将 Developer ID 签名等同于 Apple 公证或运行验收。日志与产物被 Git 忽略，不进入源码发布提交。

## 退款实现周期补充

本周期完成了退款主状态机，尚未将本地工程通过等同于生产发布。

- 新增 `payment-ledger.ts`、`payment-ledger-memory.ts`、`payment-ledger-sql.ts`。同一事务提交订单、唯一 topup、paid lot、余额版本和付款事件完成状态；全局支付行锁先于设备行锁，capture 仅持设备锁，退款与扣次共用设备余额事务。
- 退款按 `re_` 资源保存当前状态与不可覆盖的核对修订。Webhook 原始正文只用于验签和摘要，不持久化正文或设备 bearer。每次核对先取得持久化 generation，读取 Stripe 当前退款对象后再验证 generation；乱序事件、相同秒级时间戳和迟到网络响应不会覆盖新事实。
- pending/requires_action 冻结关联 paid lot；succeeded 全额撤回未用额度，failed/canceled 恢复；现有 capture hold 可结束，失败释放时先完成退款撤回。已消费题数、服务成本和其他额度来源保留。部分退款需管理员指定题数及当前退款集合指纹，禁止按金额比例自动取整。
- 新增 `/admin/payments` 和 `/admin/payments/refund-decision`，使用现有管理员鉴权和 no-store。查询是受限核对视图，显式 `hasMore`，支持特定订单；全量财务聚合仍由后续 B20 实现。旧 aggregate 余额保持 legacy_unknown，无法追溯 paid lot 的历史订单单列审核，不能猜测撤回数量。
- 独立分钟恢复入口和本地 worker 均可重试读取失败/进程中断的退款收据。只调用退款读取 API，没有创建现金退款的接口或实操。
- 新 Checkout 创建采用稳定购买会话幂等键、超时、禁止 HTTP 跳转和 HTTPS 返回 URL 校验；供应商错误只返回受控错误码。生产受限 key 新增退款对象读取权限要求，保留既有 API 版本设置并在部署前核验实际事件版本和订阅。

| 验证 | 结果 | 日志 |
|---|---|---|
| 完整 `verify.sh` | Node 230 通过；Swift 179 执行、2 跳过、0 失败；TypeScript strict、repo-health、隔离 smoke、warnings-as-errors 和 arm64 Release 通过 | `.release-evidence/2026-09-06/verify-payments.log` |
| 最后服务端回归，含隔离 PostgreSQL | **266 全通过，0 跳过，0 失败**；包含新增 3 个 Stripe transport 校验，及三存储资金与退款测试 | `.release-evidence/2026-09-06/node-payments-postgres-final.log` |
| 支付事务与 Webhook 专项 | 47 全通过；含 SQLite 中途失败后回滚/重启、历史 aggregate 迁移、不重复充值、跨设备和退款归属冲突、Webhook 503 重试、管理员审核鉴权 | `.release-evidence/2026-09-06/payment-final.log` |

最后补充金额传输契约：管理支付 API 的金额按最小币种单位返回十进制字符串，未知为 null；变更后 TypeScript strict 和支付/HTTP/传输专项 41 项全通过，日志为 `.release-evidence/2026-09-06/payment-wire-final.log`。最终 repo-health 与差异空白检查通过，临时 PostgreSQL 已停止。

本周期没有改动 Swift 源码；已有签名 QA 包仍对应相同客户端源码，未重复公证或宣称新增 UI 运行验收。TypeScript 校验及仓库健康/空白规则均通过；仓库没有另行配置 ESLint。实际 Stripe API、Webhook 订阅和生产 RAK 权限尚未在线验证，测试通过的是隔离传输和真实本地 HTTP/数据库行为。

## 观察覆盖与客户端同意版本周期

本周期贯通 B19 的观察偏好、覆盖证据与上传生命周期；来源目前明确为 unknown，自报入口随 B21 完成。尚未用这些记录宣称 R28 或生产观察已通过。

- 服务端新增 `ObservationStore`，memory、SQLite、PostgreSQL 共用同一语义。偏好按 `(device_id,consent_epoch)` 不可覆写，生效时间有序；`product_event_receipts` 约束同设备/版本/序列唯一，并核对事件指纹。事件和回执同事务写入，冲突不会制造覆盖。
- `/v1/device-observation` 使用 bearer/no-store 和持久化写入频率限制。complete 只有在偏好有效、序列齐全、发生时间落在区间内且无缺口时成立。未同步偏好、丢弃、重启、时钟和服务关闭均保留不完整状态；覆盖 ID 重试固定返回原核验结果。
- `ObservationJournal` 将 7 天/100 条队列、序列、掉队计数与待确认覆盖原子写入 0600 文件。超过 10,000 序列的离线缺口可作为 partial 推进游标；不会永久停止观察，也不能声称完整。90 天事件、回执和覆盖由独立恢复入口及本地 worker 清理，保留最小服务偏好。
- 关闭共享立即删队列并取消上传，只同步偏好；重新开启生成新版本。上传 UUID 与账号范围校验阻止旧响应删除新队列；丢失本地记录时先恢复服务端 opt-out，开启状态另起序列版本。跨关闭/重开版本的完成回调被丢弃，未补发退出行为。
- schema 2 完成事件必须显式填写可用性和完成类别；hint、personality、explain/recover、no_result 不增加 usable solve。冻结同意版本和题组 ID，取消框选/本地错误记录一次终结；客户端去重集合有界。UUID 大小写不会绕过幂等和完成去重。
- 官方 screen_query 的 usage 现在带完整已提交终态；服务端拒绝把 pending 作为完成回执，新客户端校验请求 ID、终态、计费与可用性组合。账单事实与客户端看到合法答案仍分开，异常官方流的完整故障注入验收继续列在 B23。
- 三语隐私说明明确记录的类型、关闭后的偏好同步和必要账本保留，去掉“可靠性事件可发现错误答案”的无依据说法；真实窗口排版和辅助功能验收仍待 Mac 解锁。

| 验证 | 结果 | 日志 |
|---|---|---|
| `./scripts/verify.sh` | **Node 246 通过；Swift 189 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离 smoke、warnings-as-errors、arm64 Release、空白检查通过 | `.release-evidence/2026-09-06/verify-observation.log` |
| 最终 Node，含隔离 PostgreSQL | **284 通过，0 跳过、0 失败**，含最后 UUID 规范化变更 | `.release-evidence/2026-09-06/node-observation-final-postgres.log` |
| 观察存储及 HTTP，含 PostgreSQL | 18 通过；覆盖序列缺口、冲突、关闭、乱序偏好、清理、鉴权与独立调度 | `.release-evidence/2026-09-06/observation-postgres.log` |
| Swift 队列与 URLSession 专项 | 10 通过；真实 URLSession/URLProtocol 注入迟到回执，覆盖上传中关闭/重开和旧任务收尾 | `.release-evidence/2026-09-06/swift-observation-final.log` |
| 最后 HTTP/结算专项 | 39 通过，TypeScript strict 通过 | `.release-evidence/2026-09-06/observation-wire-final.log` |
| QA 重新打包 | Developer ID、hardened runtime、strict codesign、arm64、plist 和图标完整性通过 | `.release-evidence/2026-09-06/package-qa-observation.log`；`artifact-manifest-observation.json` |

最新客户端可执行文件 SHA-256：`64977713ca5775df9c4d7a5279e83068ac67351056cd603147ad97444c3950c5`。版本保持未发布候选 2.12 / 19。临时 PostgreSQL 已停止；未公证、未生成正式 DMG、未 push/部署或访问真实支付/模型。仓库未配置独立 ESLint，所述静态验证为 TypeScript strict、仓库健康规则及差异空白检查。

## 批次与经济查询周期

本周期实现 B20 的数据读取与计算核心，使用持久账本和用户允许的观察记录。内部四视图与长期冻结归档仍未实现，不能将 API 通过视为完整 B20 或真实批次验收通过。

- 新增 `reporting.ts`、`reporting-sql.ts`、`reporting-memory.ts` 与 `Store.reporting`。Postgres 使用 REPEATABLE READ / READ ONLY，SQLite 使用一致事务；memory 保留 lot 撤回与退款历史供同口径核验。最多读取 10,000 个注册设备、每张事实表 200,000 行，超限拒绝而不是截断分母。
- `/admin/cohorts` 以成熟注册为 A28/P28 分母，以 UTC 日期和半开 28 天窗口计算 R28。完整观察必须覆盖注册至首次成功与之后窗口，缺口/关闭/首次成功来源未知分列；窗口结束再等 7 天进入 frozen 子集。Wilson 区间、空分母 null、客户端确认与服务端结算分列。新增真实 trial 耗尽时刻及跟进时长的辅助指标。
- `/admin/economics` 包含所属设备全部已记录模型尝试，失败、解释和恢复均保留。按 as_of 读取成本修订、退款 generation，并从授予、结算和撤回历史重建 paid remaining。最小货币单位与 micros 采用字符串整数，有理数保留分子/分母，没有隐式换汇。
- 退款只在净收款中扣一次；unknown 不是零。缺少退款资源关联的历史订单保留确认收款并将净收款设为未知；旧 usage 缺币种单列，旧时期没有完整记录的尝试不能补造为“零成本”。legacy_unknown 没有历史 lot 时不输出精确付费上界。
- 输出 0%、成熟 paid lot 历史消耗比例、100% 三种履约敏感性；附样本 lot/设备数，历史比例只作描述，不称最可能利润。费用缺失时贡献为 null；有已核对费用时才计算，并明确是运营贡献估计。
- `/admin/devices/internal` 提供有审计引用的可信内部分类；`/v1/device-source` 仅记录可跳过的明确自报，客户端不能自报内部标记。来源选择界面仍归 B21。
- `/admin/economics/expense-allocation` 保存指定批次/来源/政策的已核对累计费用分摊快照。同引用不可改写，新核对记录用持久化递增 revision，同毫秒写入不会靠字符串排序决定新旧；不能把整个批次的费用套到一个来源。
- 顺带修复旧 `/admin/metrics` 对同 capture UUID 的跨设备成本串组问题。新增设备/发生时间、模型尝试、订单、reservation、退款 lot 修订索引，并将批次/费用读取后的重复全表扫描改为按标识索引。

| 验证 | 结果 | 日志 |
|---|---|---|
| 完整 `verify.sh` | **Node 265 通过；Swift 189 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离 smoke、warnings-as-errors、arm64 Release 与空白检查通过 | `.release-evidence/2026-09-06/verify-reporting.log` |
| 完整 Node，含隔离 PostgreSQL | **307 通过，0 跳过、0 失败**，包含历史 lot/成本/退款重建、金额精度与跨设备归属 | `.release-evidence/2026-09-06/reporting-all-final-postgres.log` |
| 最后报表与 HTTP 专项 | **23 通过**，含最终 query wire、区间、费用索引变更和三存储；TypeScript strict 通过 | `.release-evidence/2026-09-06/reporting-wire-final.log` |
| 本地规模检查 | 合成测试输入 1,000 设备、30,000 事件、6,000 覆盖摘要；聚合 **153 ms**、进程峰值 RSS **236 MiB**，R28 分子/分母均符合预设。仅为本机单次检查，不是生产 cohort 或数据库 SLA | `.release-evidence/2026-09-06/reporting-scale.log` |

本周期未修改 Swift 源码，现有 2.12 / 19 Developer ID QA 包仍对应相同客户端源码，未重复公证。临时 PostgreSQL 已停止；未部署、未读取或写入生产数据库、未调用真实支付或模型。完整副作用与发布授权保持不变；工程仍可继续推进，不把外部评测等待标成整个目标无进展。

## 报表界面与不可变快照周期

本周期继续 B20，交付三个运营视图和聚合版本归档。独立质量数据入口及第四个 profile×题型×语言视图仍未完成，未把合成 UI 数据或旧模型评测作为新版本放行证据。

- `GET /admin/reports` 提供成熟/观察覆盖、来源 A28/R28/P28 比较、已发生成本/未用题包履约区间，以及报告保存、分页读取和 JSON 下载。窗口、来源/政策、profile/通道、定义和事实修订均明确展示；成本不随客户端 profile/通道裁剪。比例显示分子、分母和 Wilson 95% 区间，零分母显示空值，小样本提示不确定性。
- `report-archive.ts` 与 SQL 实现接入三存储；一次事实读取生成各来源的 cohort/economics。规范内容 SHA-256 同时作为不可变归档 ID，同内容并发重试返回首次创建时间；新事实/定义生成新版本。归档内容仅为聚合，不含设备凭证、请求 HMAC、题目或答案。
- 保存接口只接受已经查看的 query 与摘要，不接受自填指标。服务端重算不一致返回 409；明细保留期之外的实时查询返回 410，不能在事件清理后用缩小的历史数据重述指标。归档读取不依赖剩余详细事件，校验失败关闭该读数；分页使用创建时间＋ID，覆盖同毫秒排序。
- 页面使用固定脚本摘要 CSP、同源请求、no-store/no-referrer，密钥只留在当前页面；报告值通过 textContent 渲染。筛选或密钥改变会取消在途查询、隐藏失效结果并停用保存/导出，旧回调不能覆盖新选择。金额用 BigInt 格式化，JSON 保留精确 micros/有理数，未知成本与净收款保持未知。
- 三存储测试覆盖并发保存、独立修订、详细事件清理、调用方对象修改、分页和缺失 ID；SQLite 还验证重启持久化与篡改负载后的校验拒绝。费用分摊在 memory 的幂等比较改为按字段值，避免对象键顺序差异。
- 收尾修复 SQL 空注册批次的费用遗漏：已核对的批次支出在零设备时仍返回，每设备贡献保持 null；memory、SQLite、PostgreSQL 均补充回归，包含相同分摊的乱序字段重试。

| 验证 | 结果 | 日志/证据 |
|---|---|---|
| 完整 `verify.sh` | **Node 272 通过；Swift 189 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离 smoke、warnings-as-errors、arm64 Release、差异空白检查通过 | `.release-evidence/2026-09-06/verify-report-archive.log` |
| 最终完整 Node，含隔离 PostgreSQL | **317 通过，0 跳过、0 失败**，包含最后空批次费用修复、页面字段、键盘焦点和 CSP 脚本内容；TypeScript strict 通过 | `.release-evidence/2026-09-06/report-archive-all-final-postgres.log` |
| 归档 / 报表存储 / HTTP 专项 | **18 通过**，三种存储均运行 | `.release-evidence/2026-09-06/report-archive-final-postgres.log` |
| 实际浏览器，隔离本地服务 | 空状态、保存/读取、来源筛选、明细过期提示、无效密钥、刷新后重新认证、金额精度和三场景图表通过；1280/390 像素页面宽度均无整体横向溢出；可聚焦表格按右键后 scrollLeft=40，clientWidth=330 / scrollWidth=406 | `.release-evidence/2026-09-06/report-browser-checks.md` 与普通视口截图 |

浏览器非空图表使用单独 SQLite 中的 **qa-ui-synthetic** 合成归档：已知推理 1.2 USD、3 次交付、5 题未用已购额度，三场景分别显示 0/1/2 USD；`9007199254740993` 最小单位显示未丢精度。它只验证 UI 与数据接口，不是用户、利润或灰度证据。长截图工具发生拼接重复，未用于排版验收，采用普通视口截图及实际 DOM 尺寸。

本周期未改 Swift 源码，版本仍为未发布 2.12 / 19，现有签名 QA 包仍对应相同客户端源码。未重新公证、生成正式 DMG、提交/推送或部署；未访问生产数据库、真实 Stripe 或付费模型。临时 PostgreSQL 与本地报表服务在本周期结束时关闭。仓库未配置独立 ESLint，静态检查指 TypeScript strict、repo-health 与空白规则。

## 独立质量录入与第四视图周期

本周期完成 B20 的独立质量记录接口、三存储归档和第四个 profile×题型×语言视图，并用既有真实 240 题归档核对离线转换。未执行新模型评测，历史数据不属于当前阅读场景留出集。

- `quality.ts` 只接收有版本的已评分逐题摘要；根字段和枚举严格校验，不接收题目、图片或答案。计划/实际/缺失样本分别报告，逐题复核摘要绑定 run、声明和评分；完整执行、授权及家族隔离等声明不能由缺失字段推断。旧 attestation 只绑定原比较摘要，不冒充对新文件的逐题签署。
- 服务端重算独立 V1/fallback 精确率、范围覆盖、Ready/Retake、范围外和多目标识别、风险阻断及 Wilson 95% 区间。未标注精确率、未知家族、缺失时间/token 保留未知。新增非 SPI 的 400 / 每题型 100 样本要求仅计已声明客观题组合中已标注项目；SPI、其他范围挑战、未声明组合和未标注项不补足这些样本。
- Memory、SQLite、PostgreSQL 保存不可变聚合及源摘要；同内容并发重试返回首次记录，相同 run 不能重绑执行版本，评分修订追加新版本。最新已撤回时不恢复旧评分；撤回保留原因及唯一审计引用。原题/逐题 ID/family 摘要不进入持久化聚合，详细产品事件清理不影响质量归档。
- `GET /admin/quality/reports` 默认当前新合约与范围版本；没有当前证据时显示空值。支持同一单元的 profile/题型/语言筛选、历史修订、指标分母与区间、复核边界和 JSON 下载。密钥仅在页面中使用；输入变更取消在途请求并清空旧结果，严格脚本摘要 CSP 与 textContent 渲染。
- `prepare-legacy-quality.mjs` 离线核对实际 attestation、comparison、两组 summary、当时提交中的 manifest 及两组各 240 条逐题结果，重新评分并核对统计量。历史 treatment 保持 App 2.10、原提交/模型、`legacy_objective`、空支持声明、未知家族及 `legacy_summary_only`；不推断材料授权或独立真值审查。
- `upload-quality-report.mjs` 要求显式目标与环境凭证，先校验再发送，拒绝重定向、限制体积/超时并校验返回的确切内容摘要；无默认生产目标或自动重试。此周期只上传到本机隔离 SQLite，未发起生产写入。

| 验证 | 最终结果 | 日志/证据 |
|---|---|---|
| 完整 `verify.sh` | **Node 288 通过；Swift 189 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离 smoke、warnings-as-errors、arm64 Release 与差异空白检查通过 | `.release-evidence/2026-09-06/verify-quality-final.log` |
| 最终完整 Node，含隔离 PostgreSQL | **332 通过，0 跳过、0 失败**；包含最后非 SPI 样本量及 fallback 状态校验 | `.release-evidence/2026-09-06/quality-all-hardened-postgres.log` |
| 质量 HTTP / 三存储 / 历史导入 | 包含在上述完整套件：并发幂等、执行版本冲突、评分修订、撤回/分页、同单元筛选、事件清理、源文件摘要/逐题篡改拒绝、真实历史重算及本机 HTTP 上传回执 | `quality*.test.ts`、`legacy-quality-import.test.ts`、`reporting-store.test.ts` |
| 实际浏览器 | 1280 像素视口/document 均为 1280，12 单元矩阵；日语排序筛选精确为 20 题/14÷17；整体 197/204，范围覆盖未知；历史撤回明确展示；最终非 SPI 样本为 0；无效密钥、刷新后重新认证、当前候选空状态通过 | `.release-evidence/2026-09-06/quality-browser-checks.md`、`quality-desktop.png`、`quality-matrix.png` |

当前本机归档修订 3 为 `9b03012f0c3ea43774c827652acf0446cf3bafdd2cb42d4ece25effcb007e345`。开发时修订 1 曾错误推断历史支持声明，已在隔离数据库记录撤回；最终转换器拒绝此类推断。原始 2026-08-31 评测和签署文件未修改。此处 96.57% 是历史运行重算，不是当前候选质量。

本周期只改服务器与工具/文档，现有签名 QA App 的客户端源码未变；仍未公证、生成正式 DMG、提交/推送或部署。无生产数据库、Stripe 或付费模型访问。临时 PostgreSQL 和本机质量服务在收尾关闭。仓库未配置独立 ESLint，未报告虚构 lint 结果。操作契约及剩余适配器/评测缺口见 [质量记录操作说明](quality-evidence.md)。

## 购买会话恢复与到账终态周期

本周期推进 B18 的用户购买路径，完成短链接重试、Checkout 地址恢复、到账消费终态和三语言返回页。异常付款人工核对仍列为未完成，未把这一子路径通过当作支付系统全面验收。

- `purchase-session.ts` 统一输入、快照匹配与 256-bit 随机 secret/hash 规则；SQLite/PostgreSQL 改用共享 `SQLPurchaseSessions` 事务。相同已鉴权设备/purchase ID 恢复原订单，换发短 secret、使原链接失效，并保留首次到期时间。不同快照、过期或已消费不能重用同一 ID；并发重试只有最终换发的 secret 有效，不产生多笔购买记录。
- `purchase_sessions` 新增 `checkout_url/consumed_at`，兼容迁移为 null。Checkout 资源只能属于一个购买会话，保存 URL 后可恢复丢失响应；尚未保存的调用继续使用原稳定幂等键。相同资源换 URL/订单、过期或已消费的附件写入被拒绝。
- `PaymentLedger.pay` 在额度事务内再次核对精确购买快照，并将订单、付费 lot、首次充值、事件状态与 `consumed_at` 一起提交。晚到 paid 事件不受短链接过期影响，消费时间保留首次值；原先已记账但缺消费关联的订单在核验后补齐关联，不再加题。
- 修复缺失的 `/purchase/complete` 路由；成功/取消 URL 不携带会话凭证或标识。返回页不查询余额，也不凭查询标记宣称已到账或未扣款。购买页及错误/重试提示覆盖中、日、英，金额按币种格式化；使用静态脚本摘要 CSP、no-referrer/no-store、文本状态和键盘可见焦点。创建/Checkout 请求体限制为 4 KiB。
- PostgreSQL 专项发现并修复了 Date 经 `String` 转换丢失毫秒的到期时间映射。一次本机 PostgreSQL 启动未指定测试端口，导致连接拒绝；确认该隔离进程监听 5432 后已停止并用指定 18793 端口重启，未改生产配置。失败日志保留，最终套件全部重跑通过。

| 验证 | 最终结果 | 日志/证据 |
|---|---|---|
| 完整 `verify.sh` | **Node 297 通过；Swift 189 执行、2 跳过、0 失败**；TypeScript strict、repo-health、隔离 smoke、warnings-as-errors、arm64 Release 与空白检查通过 | `.release-evidence/2026-09-06/verify-purchase.log` |
| 最终完整 Node，含隔离 PostgreSQL | **344 通过，0 跳过、0 失败** | `.release-evidence/2026-09-06/purchase-all-postgres.log` |
| 支付专项，三存储 | **59 通过，0 失败**：并发重发、唯一 Checkout、不变期限/毫秒、精确快照、消费重投、旧关联补齐、晚到付款、事务故障及重启恢复 | `.release-evidence/2026-09-06/purchase-targeted-postgres-fixed.log` |
| HTTP 与实际浏览器 | HTTP 覆盖创建失败后重试、6 次并发同一 Checkout、已存 URL 不再调用 provider、unpaid 不入账、两种 paid 通知只加一次、到账后 410、匿名返回页不授予额度。浏览器覆盖三语言价格/错误状态、1280 与 390 宽度、最终返回页 | `.release-evidence/2026-09-06/purchase-browser-checks.md` 与普通视口截图 |

浏览器使用独立本机服务、临时凭证和注入的支付不可用结果；没有创建真实 Stripe Checkout、扣款或现金退款。测试证明的是本地行为，不代表真实支付配置或真实到账验证。客户端源码和既有签名 QA App 未变化，仍未公证、生成正式 DMG、提交/推送或部署。临时服务与 PostgreSQL 在收尾关闭。

## 异常付款持久化与人工核对周期

本周期继续 B18，交付已验签付款的持久化待处理队列、独立恢复及管理员审核 API。没有调用真实 Stripe 或写生产数据库；全部付款、退款和审核证据来自隔离测试。

- `checkout-reconciliation.ts` 固定最小 Stripe 快照、财务/设备/购买身份规则、审查原因、指纹和明确交付题数。原始事件正文、邮箱、任意 metadata 和长期设备 bearer 不落库；接口移除内部设备 hash，金额使用十进制字符串。
- `checkout-memory.ts` 与 `checkout-sql.ts` 统一 `queued/processing/review/credited` 生命周期。四张新增表分别保存当前案例、签名事件快照、追加观察和已应用审核。先提交收据，再执行入账事务；异常付款的 HTTP 确认意味着核对队列已经接管，不等于充值完成。
- 提取共享 `creditPaidOrder` 事务体，使正常付款、人工交付、lot/余额、退款策略、购买会话绑定/消费、事件完成及审核记录原子提交。处理 Checkout 先于本地绑定到达和旧订单补记消费关联，两者均不会重复增加额度。已知 PaymentIntent、设备、购买会话和既有订单不能被人工字段重新分配。
- `/admin/payments/checkouts` 提供有鉴权的分页读取、单条读取、当前 Stripe 重核和明确审核提交；指纹绑定最近一次供应商观察，提交时再次读取并核对。唯一审查引用、证据 SHA-256、设备、题数、题包及目录共同构成已应用审核；精确重试幂等，旧指纹、跨设备、重复引用及变化的财务身份被拒绝。该 API 不执行现金退款。
- `retrieveStripeCheckout` 只读取验证过的 `cs_` 资源，8 秒超时、256 KiB 正文上限、禁止跳转、固定字段归一化。分钟恢复接口每次最多处理三个 Checkout；缺依赖/读取失败延后 60 秒，五次后停在 review。自动处理权在事务内重新检查退避期限；显式管理员重核可重新尝试。进程内支付恢复禁止重叠，关闭存储前等待当前支付任务完成。
- 全量 PostgreSQL 并发测试发现并修复了“旧扫描结果绕过新退避期限”的竞态；加入确定性过期扫描回归，并验证两个恢复请求只产生一次实际处理/失败计数。审核写入故障会回滚充值与消费标记，但保留先提交的签名收据；SQLite 重启后可继续恢复。

| 验证 | 结果 | 本地日志 |
|---|---|---|
| 支付链路定向回归，含三存储 | **95 通过，0 跳过、0 失败**；正常/异常支付、旧订单、归属保护、并发恢复、退款、HTTP 鉴权和供应商读取 | `.release-evidence/2026-09-06/checkout-integrated-postgres.log` |
| 最终完整 `verify.sh` | **Node 321 通过；Swift 189 执行、2 跳过、0 失败**；TypeScript strict、repo-health、隔离 smoke、warnings-as-errors、arm64 Release 及空白检查通过 | `.release-evidence/2026-09-06/verify-checkout.log` |
| 最终完整 Node，含隔离 PostgreSQL | **377 通过，0 跳过、0 失败** | `.release-evidence/2026-09-06/checkout-all-postgres.log` |

仓库没有单独 ESLint 配置，不能把类型检查称作独立 lint 通过。Swift 两项跳过为需显式运行/复核的模型评测，不是运行时故障。客户端及 QA 包源码本周期未改，既有签名 QA 包保持有效；本周期未生成公证发布 DMG、提交、push 或部署。当前人工核对交付为 API 操作流程，详细契约见 `docs/official-api.md`。真实 Stripe read/write 权限、事件版本、订阅、生产迁移、未分配收款的财务汇总与真实对账仍未验证。

## 来源、入口与反馈周期（2026-09-07）

本周期落实 B21 的本地工程路径；公开阅读组合仍为空，正式反馈征集尚未开放。没有真实收件、发送邮件、调用付费模型或修改生产数据。

- 新增 `DeviceSourceSelection` 和引导来源页。默认跳过，首次前进才记录选择；跳过只留本地状态。非空来源持久化后按服务地址与设备凭证摘要绑定同步，注册可晚于选择，网络失败可重试；并发同步只发一个请求，409 停止、401 不清凭证，旧账号的迟到响应不能确认或转移来源。只有当前绑定下已确认的记录才给新事件填写 self_reported，其他为 unknown；语言和题目模式不影响来源。`/v1/device-source` 新增 4 KiB 上限。
- `/spi` 与 `/reading-practice` 共用三语页面、实际题包目录及 `/dl`，切语言保持入口路径。新注册一次性 30 题、保留历史余额、单请求有效答案计费及可用不等于正确均明确说明。阅读入口读取 support catalog，显示未开放或内部 beta；下载不会打开未发布功能。删去未经验证的隐身、公证或规模承诺及模拟答案/余额，页面展示真实操作说明。页面 CSP 禁止脚本和嵌套框架，no-referrer、nosniff；元描述也携带当前未开放范围。
- 新增反馈预览：逐张查看/选择图片，可打开本机原图，核对完整答案并填写可选标准答案；用途默认仅排查本次问题。授权初始未勾选，改变图片、用途或标准答案会要求重新确认；小屏提供滚动容器。保存面板说明 JSON 与材料文件夹须一起提交，保存本身不会发送。
- `feedback-v2` 保存明确用途、权利确认、90 天期限、反馈 UUID、用户自行删除本地原件及外部处理需另行同意。导出逐文件限制读取、拒绝链接、核对 SHA/字节数/尺寸/真实图片完整解码，只复制选中材料；独立 0700 目录、0600 文件和原子 manifest 替换确保失败清理且原文件保留。允许用户明确选择纯文本反馈，旧导出仍由用户管理。
- 新增离线 `FeedbackVault` / `manage-feedback.mjs`：仓库外私有存放、精确授权/字段/路径/大小/摘要校验、幂等收件、审核证据摘要、质量用途准入、撤回和到期清理。删除先落 `purge_pending` 阻止使用，中断后可重试；不能恢复已撤回编号。最小元数据不含题目或答案，无效 JSON 不把正文写入错误输出。原件、审核记录与用途分开，不接入产品遥测或模型执行器。
- [反馈操作规程](feedback-operations.md) 定义成员权限、实际独立审核、收件冗余副本/邮箱/备份的删除、每日清理、失败处理及锁恢复。CLI 的 reviewer 是声明字段，不构成身份认证；工具只证明自己的存档删除，不能代替邮箱或其他受控副本的删除证明。生产权限、真实演练和每日调度证据缺失时继续暂停正式征集。

| 验证 | 结果 | 日志 / 证据 |
|---|---|---|
| 完整 `verify.sh` | **Node 332 通过；Swift 200 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离服务 smoke、warnings-as-errors、arm64 Release 和空白检查通过 | `.release-evidence/2026-09-06/verify-source-feedback.log` |
| 完整 Node，含隔离 PostgreSQL | **388 通过，0 跳过、0 失败**；覆盖三存储原有支付、观察、报表及新增反馈/入口接口 | `.release-evidence/2026-09-06/source-feedback-all-postgres.log` |
| 来源相关 HTTP / 页面 / 离线反馈专项 | **22 通过**；缺授权、未知字段、符号链接、摘要变化、删除中断、期限到达、重复操作及实际 CLI 调用均覆盖 | `.release-evidence/2026-09-06/source-feedback-node.log` |
| 浏览器与最终文案 | 三入口 × 三语言 × 两视口（390/1440）共 18 组无横向溢出；实际切语言、切入口、展开隐私 FAQ 通过。最终三语隐私说明另做 390 宽度复核，日语标题和隐私截图人工查看 | `source-browser-checks.json`、`source-browser-interactions.json`、`source-browser-final-copy.json` 及 `source-*.png`，均在同一证据目录 |
| QA 重建、签名、资产 | **2.12 / 19，arm64，macOS 最低 14.0**；Developer ID + hardened runtime、strict codesign、bundle ID/plist、图标与源文件一致，通过 | `.release-evidence/2026-09-06/package-qa-source-feedback.log`、`codesign-source-feedback.log`、`artifact-manifest-source-feedback.json` |

本周期 QA 可执行文件 SHA-256：`dc75027fbdfde89e0f6aacdbfdfd48512d86255e0f888a2497072cf904eb377d`。该包替换此前观察周期的 QA 包；版本仍未发布。Swift 两项跳过是需显式评测的模型项目；它们没有被计作模型质量通过。仓库没有独立 ESLint；离线 JS 工具通过 `node --check` 与运行时测试，其内部不是 TypeScript 校验对象。

本周期未完成真实 AppKit 点击、各屏幕/语言/辅助功能验收：桌面此前锁定，未自动解锁，也未将浏览器截图冒称客户端运行证据。页面观察使用隔离本地 mock 服务，未请求下载或访问真实支付；缓存页面通过本地 QA 查询参数刷新后核对最终文案。服务、测试 PostgreSQL 与浏览器测试页已关闭，视口已恢复。未公证、生成正式 DMG、提交、push、部署或放量。

## 输入解码与流协议故障验证周期（2026-09-07）

本周期推进 B23 / AC05–06 的输入和传输边界，修复了文件头校验不足以及客户端忽略非法 SSE 后仍可能接受成功终态的问题。完整蓝图及实际生产发布仍未完成。

- 新增 `image-validation.ts`，为 `screen_query_v1` 主查题及解释/恢复做静态 JPEG/PNG 的完整解码。先检查规范 base64、大小、格式、PNG chunk/CRC、JPEG 扫描及结束边界，再检查实际元数据和所有像素；拒绝动画、拼接、截断、损坏像素和超过 16MP 的图片。SHA-256 仍取原始文件字节，既有指纹不因转码改变。校验失败发生在预扣、预算持有和厂商尝试之前，HTTP 返回受控错误，不暴露底层解码报错。
- sharp 固定为 0.35.4；禁用 libvips 操作缓存、每请求按图片顺序处理、进程内最多两个任务，超出直接 503 `rate_limited`。原生处理时限每图 5 秒，不含 libuv 排队，因此不是 HTTP 整体时限承诺。按[构造参数](https://sharp.pixelplumbing.com/api-constructor/)、[缓存接口](https://sharp.pixelplumbing.com/api-utility/)及[处理超时](https://sharp.pixelplumbing.com/api-output/#timeout)落实这些限制；完整解码明确执行 raw 输出，没有把 metadata 检查当作像素验证。
- 原 screen-query 测试使用的 1px PNG 无法真实解码。已以独立 zlib/CRC 生成的有效 PNG 替换，并专门构造容器与 CRC 正确但像素压缩损坏的反例。新增最大尺寸、实际 JPEG/渐进 JPEG/PNG、动画、错误 MIME、拼接、容量回收、页序及额度前置拒绝测试。旧合约格式接收和旧指纹语义保持兼容；新增严格解码没有被宣称覆盖所有 legacy 输入。
- 新增 `OfficialStreamDecoder`，替换生产中的宽松逐行解析器，并删除其闲置旧实现。按字节/空行分帧，正确处理 UTF-8、BOM、CR/LF/CRLF、注释和多行 data。严格核对基础 usage 数值类型、收费、ID、操作、余额版本及新合约终态；拒绝非法 JSON、未知事件、重复回执、错序正文/错误和提前 DONE。单事件 512 KiB、整流 4 MiB、解码正文 64 KiB，超限失败而不截成成功答案。
- 有效 usage 仍可更新账本镜像，答案传输完成需另外收到 DONE。截断或协议失败只查询原 capture 状态，不重新 POST；取消以及账号/地址变化不把旧请求的余额转移到当前状态。HTTP 409 补查也检查取消和账号范围。修复英文 upstream 错误文案中无依据的未扣费断言，并使本机累计计数溢出时饱和而不崩溃。
- Fastify 从 5.10.0 升级到 5.12.3，处理依赖审计命中的维护者公告：[根值强转](https://github.com/fastify/fastify/security/advisories/GHSA-w2qp-rph6-63g4)、[代理转发头](https://github.com/fastify/fastify/security/advisories/GHSA-3m5p-2c4r-xxw2)。最终 `npm audit` 为 0 条已知漏洞，完整旧 API 回归通过。

| 验证 | 结果 | 日志 / 证据 |
|---|---|---|
| 输入与新合约专项 | **37 通过**；两种本机存储验证损坏参考图未预扣、未调用模型、同 ID 修正后可正常请求，损坏解释材料不追加尝试 | `.release-evidence/2026-09-06/image-decoder-targeted.log` |
| 既有受控图片 | **240 / 240 完整解码且原始 SHA 匹配**，约 575ms；仅是本机夹具验证，新增模型调用 0 | `.release-evidence/2026-09-06/image-decoder-baseline.log` |
| Swift 协议 / 实际 HTTP 专项 | **22 通过**，包括 12 个解码器/边界测试、2 个真实回环 HTTP 测试及现有客户端契约测试。枚举所有截断前缀；网络每 3 字节分块；收到结算后 socket 关闭不算传输成功 | `.release-evidence/2026-09-06/stream-decoder-swift.log` |
| 完整 `verify.sh` | **Node 340 通过；Swift 213 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离 smoke、warnings-as-errors、arm64 Release、空白检查通过 | `.release-evidence/2026-09-06/verify-image-stream.log` |
| 最终 Node，含隔离 PostgreSQL | **396 通过，0 跳过、0 失败** | `.release-evidence/2026-09-06/image-stream-all-postgres.log` |
| 最后取消检查补丁 | 完整串行 Swift **213 执行、2 跳过、0 失败**，之后重编译 Release 并签名 QA 包 | `.release-evidence/2026-09-06/image-stream-swift-final.log`、`package-qa-image-stream.log` |
| 依赖审计及跨平台安装 | npm audit **0**；独立 `npm ci --ignore-scripts --omit=dev --os=linux --cpu=x64 --libc=glibc` 安装成功，sharp/Linux 与 libvips 包存在，主原生包为 ELF x86-64。**没有在 Linux 执行该库** | `.release-evidence/2026-09-06/image-decoder-audit-final.json`、`linux-decoder-install.log` |
| QA 包及资源 | 2.12 / 19、arm64、最低 macOS 14.0、Developer ID/hardened runtime、strict codesign、plist/bundle ID及图标一致性通过；manifest 绑定本次客户端源文件摘要 | `.release-evidence/2026-09-06/artifact-manifest-image-stream.json`、`codesign-image-stream.log` |

最新 QA 可执行文件 SHA-256：`a65c1997a338258ee970f7025d34d68d36d1865b30d59cfd7ea0c1a89399b439`。未发布、公证或部署。Swift 两个跳过项目仍为显式模型评测；没有把软件测试、受控图像解码或 HTTP 分块测试当作新场景正确率或真实 AppKit UI 验收。仓库无独立 ESLint；静态检查为 TypeScript strict、repo-health 及空白规则。

剩余验收须覆盖整个 OfficialAPI.run 的状态补查/账号变化/取消与 UI 联动，服务端解码和预扣之间的断线窗口及预算清理、真实旧数据迁移/回退、Linux 实际运行/并发资源，以及所有目标屏幕与辅助功能。独立恢复与资金状态机已有测试不能代替这些端到端验收。回环服务由测试关闭，隔离 PostgreSQL 已停止，未创建真实付款或模型请求。

## 请求准入与断线清理验证周期（2026-09-07）

本周期修复 B23 中服务端校验、预算、额度持有与模型启动之间的取消窗口。此前主查题的预算预留位于 `try/finally` 外，事务抛错会遗留设备并发位；补充请求的预算/持有抛错也没有统一清理。连接关闭监听在持有后才安装，断线还可能发生在 `startAttempt` 等待中，导致对已取消请求继续调用模型。

- `CaptureService.connected` 在鉴权前安装关闭监听，贯穿图片解码、数据库等待和模型调用；结束时移除监听。校验之后、预算之后、持有之后、尝试记录之后分别检查取消，已关闭的请求不会进入下一次模型调用。这里覆盖 Fastify 已完成 body 解析后的业务处理，不宣称改变上传层、入口 body limit 或 sharp 原生解码的抢占能力。
- solve/explain/recover 共用 `admitted` 处理设备并发位、预算预留、持有和兜底清理。预算拒绝、回滚、提交回执丢失、取消及回调抛错均进入 finally。每次执行单独生成内部 requestId；`BeginCapture` 将其写入既有持有记录，无 schema 变更。持有结果不确定时回查并匹配该标识，防止取消另一执行者的同 ID 请求；该标识不从 HTTP body 读取。
- 明确记录模型是否实际启动。确认未调用供应商时，若尝试记录已提交，终态记 failed、tokens/费用为 0，并释放预算；这不是把未知 usage 写成零。实际调用后断线或报错仍保留未知 tokens/费用及预算上界；迟到回调不得更改终态。同步抛错也进入 Promise 拒绝路径，避免 deadline 在清理时产生未处理拒绝。
- 创建成功的恢复子请求最终失败时，仍以原有事务语义至多补偿一次 goodwill；原收费记录保留。清理事务或归属回查持续不可用时记录待核对，不能声称即时清理成功，独立恢复器与费用核对仍须在生产落实。

| 验证 | 结果 | 日志 / 证据 |
|---|---|---|
| 真实回环 HTTP 及原路由专项 | **110 通过，0 失败**；覆盖四个取消暂停点、三种事务的回滚/提交回执丢失、他人同 ID 持有保护、同步 provider 错误、调用后断线及迟到回调 | `.release-evidence/2026-09-06/capture-admission-targeted.log` |
| 新增故障矩阵 | 每存储 **37 项**；memory / SQLite / 隔离 PostgreSQL 合计 **111 项通过**。使用实际存储事务与真实 HTTP 断线，供应商为仅测试内的受控实现，真实模型调用 0 | 同专项及 PostgreSQL 日志 |
| 完整 `verify.sh` | **Node 414 通过；Swift 213 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离 smoke、Swift warnings-as-errors、arm64 Release 和空白检查通过 | `.release-evidence/2026-09-06/verify-capture-admission.log` |
| 最终 Node，含 PostgreSQL | **507 通过，0 跳过、0 失败** | `.release-evidence/2026-09-06/capture-admission-all-postgres.log` |
| QA 包一致性 | 客户端源码清单/摘要及全部 bundle 文件与上一轮签名产物一致，strict codesign 再次通过；本轮仅服务端实现变化，无需重包客户端 | `.release-evidence/2026-09-06/artifact-validation-capture-admission.json`、`codesign-capture-admission.log` |

当前 QA 仍为 **2.12 / 19**，可执行文件 SHA-256 `a65c1997a338258ee970f7025d34d68d36d1865b30d59cfd7ea0c1a89399b439`。未公证、生成正式 DMG、提交、push、部署或放量。两个 Swift 跳过项目仍是需要评测输入及显式运行开关的模型评测，不作为通过项。无独立 ESLint；静态检查实际为 TypeScript strict、repo-health 和空白检查。测试服务由夹具关闭，隔离 PostgreSQL 已停止。桌面复查仍锁定，未完成 AppKit 交互验收。

本周期没有完成整个 `OfficialAPI.run` 状态补查/账号切换/取消的端到端联动、真实生产故障注入、旧数据迁移回滚、Linux 运行与负载、新阅读质量评测、正式发布或灰度观察。后续工程继续这些明确的差距。

## 客户端完整请求与账号归属验证周期（2026-09-07）

本周期直接验证生产 `OfficialAPI.run` 的文件读取、HTTP 请求、SSE 消费、错误分支、原 ID 补查和主线程回调，推进 B23 的客户端传输验收。发现并修复迟到 401 无条件修改当前账户标记、补查之后遗漏取消检查以及成功回调入队后账号变化的窗口。

- 新增 `CaptureAccount` / `CaptureEnvironment` 明确依赖。默认 `.live` 仍连接真实 URLSession、Keychain 读取及账户镜像；测试提供独立账户状态与 ephemeral session，运行同一个 `OfficialAPI.run`。delta、usage、401、补查余额及最终成功判断均在主线程实际执行时检查取消和冻结账号/地址。取消前置检查阻止文件读取和 HTTP；非法辅助操作或缺少新合约时不默认发起恢复。
- status 改为按字节最多读取 **64 KiB**，检查 JSON Content-Type、请求 ID 和 operation，并保留终态一致性判断。流截断仍只 GET 原 ID，不重复 POST；服务端已结算不能使不完整答案成功。SSE/status 在结束或提前退出时取消对应网络任务，错误响应在开始补查前停止传输。依据 Apple 的 [AsyncBytes.task](https://developer.apple.com/documentation/foundation/urlsession/asyncbytes/task) 和 [cancel](https://developer.apple.com/documentation/foundation/urlsessiontask/cancel()) 接口，不将取消当成同步阻止所有迟到回调的保证。
- 新增 `OfficialCaptureMaterials`，在 base64/JSON 分配前通过已打开的文件描述符确认普通文件，每文件 **6 MiB**、原始字节总计 **9 MiB**；逐块读取时检查取消和实际增长。`O_NOFOLLOW` 拒绝链接，`O_NONBLOCK` 使替换成 FIFO 的路径可被检查而不阻塞。最后仍检查 JSON **12 MiB** 上限。保存原始字节与页序；完整图片像素校验仍由既有服务端解码器负责。
- 账户页合计输入/输出 tokens 时使用已验证的饱和加法，避免两个合法大计数相加溢出。

| 验证 | 结果 | 日志 / 证据 |
|---|---|---|
| Swift 请求/材料/协议专项 | **43 执行，0 失败**。新增 16 项完整 run 测试及 4 项材料测试；包含真实回环 HTTP、请求 body/鉴权/页序、截断、409、当前及迟到 401、账号/地址切换、取消、状态等待、错误 ID/operation/终态/MIME/JSON/超限、legacy/explain/recover、缺凭证和文件拒绝 | `.release-evidence/2026-09-06/official-run-targeted.log` |
| 完整 `verify.sh` | **Node 414 通过；Swift 233 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离 smoke、Swift warnings-as-errors、arm64 Release 与空白检查通过 | `.release-evidence/2026-09-06/verify-official-run.log` |
| PostgreSQL 历史证据适用性 | 本轮没有修改服务端实现；上轮 **507 通过，0 失败** 的三存储记录继续适用。核对上轮准入实现及测试摘要一致，本轮 manifest 另外收录完整服务端源文件清单与摘要 | `.release-evidence/2026-09-06/capture-admission-all-postgres.log`、`artifact-manifest-official-run.json` |
| QA 重新打包 | **2.12 / 19**、arm64、最低 macOS 14.0、Developer ID/hardened runtime、strict codesign、plist/bundle ID 和图标一致性通过 | `.release-evidence/2026-09-06/package-qa-official-run.log`、`codesign-official-run.log`、`artifact-manifest-official-run.json` |

当前 QA 可执行文件 SHA-256：`49ffc51676c39ac302084204e858af32c167b2792226b2b6de6013e4ca19fe22`。新增测试仅使用本机 HTTP 对端、独立账户状态和临时材料，没有读取真实设备凭证、调用外部模型或启动 AppKit。测试对端验证的是客户端协议和生命周期，不冒称真实厂商或生产服务器；可辨认材料字节用于验证序列化，实际图像有效性由前述 JPEG/PNG 测试覆盖。所有临时服务/session/材料均由测试清理，本轮未启动 PostgreSQL。两个 Swift 跳过项目仍是显式模型评测；仓库无独立 ESLint。

未公证、生成正式 DMG、提交、push、部署或放量。还需真实账户/Keychain与全局余额镜像并发、NotchController 的补查/恢复/解释 UI 联动，以及旧数据迁移回滚、Linux 运行/资源测试和新阅读质量证据。桌面最近一次检查仍为锁定；本周期未再次调用自动解锁，实际桌面状态应在原生验收前复查。

## 阅读评测执行与独立复核验证周期（2026-09-07）

本周期完成 B22 的新阅读 manifest 执行/评分适配器及解释复核入口。交付的是已验证的工程工具链；未取得授权 holdout、真实候选或独立模型质量签署，因此新范围仍未放行。

- `reading-evaluation.mts` 校验严格 manifest、家族隔离、独立授权与外部模型处理许可、声明组合样本量和完整图片。相同材料/scope 不重复计样本；路径越界、符号链接、损坏图片和摘要变化均拒绝。调用前重新核对每题材料；生产图片、scope、协议合成和答案匹配逻辑直接复用。
- `run-reading-eval.mjs` / `reading-runner.mts` 使用隔离官方设备 token，先核对真实 account/config/health HTTP，再冻结候选及部署核验原件、成本政策、完整题集顺序和每题 UUID。共享原有 100 CNY 累计预算，完整计划检查后逐次事务占用，不重置、不自动重试。每次调用先写 dispatch，后落盘原始响应及摘要；异常调用仍保留费用上界，普通失败保留在分母，授权/候选/输入或预算失效停止后续调用。
- 严格读取 SSE 的完整终止、ID/operation、结算及数值类型；实时评分和离线重算共用 MIME 语义。修复真实 DeepSeek 候选被准入误排除的问题；非法 UTF-8 会关闭响应流并保留未知费用占用。单响应 2 MiB、事件 512 KiB、原文 64 KiB，离线重算逐文件处理，不同时积存全题集原文。
- 每题型按冻结顺序抽取前 N 个真值 answerable 的实际可用父请求，立即绑定原材料/答案调用一次解释；不按答案是否判对挑选，不因解释失败另抽替代。首次 retake/no_result 分别验证解释入口 409 binding_mismatch。解释的 ready/review/fallback 覆盖如实统计，未出现的路径保持缺口。
- `prepare-reading-quality.mjs` / `reading-quality.mts` 在无网络、无模型凭证的情况下核验源文件、计划、原始响应、调用顺序、费用上界和完成状态，重算每题后再与 draft/subject 比对。隐藏/孤立 dispatch、响应篡改、跳过解释和伪造评分不能进入正常复核输出。独立答案及解释签署分别绑定实际文件；身份不同、时间有效和摘要匹配只是完整性检查，不冒充身份认证。
- 解释正确性、一致性、无关推断、材料泄漏、静默改写及严重矛盾由真实独立复核提供；未复核为 null/证据不足。报告计算四题型/路径覆盖、准确性和 Wilson 95% 区间；严重矛盾/泄漏/静默改写必须为 0。答案/解释/入口拒绝的成本上界分别报告，不混入旧 240 题单调用比较，不冒充真实账单或使用率加权贡献。

| 验证 | 结果 | 日志 / 证据 |
|---|---|---|
| 阅读及共享预算专项 | **30 通过，0 失败**；包含 20 项新阅读测试与 10 项预算测试，覆盖授权/隔离/价格/图片、完整和部分运行、普通传输失败、超界停机、拒绝入口、篡改、重算、独立评审和 CLI | `.release-evidence/2026-09-06/reading-evaluation-targeted.log` |
| 真实服务路由 | memory / SQLite 上执行实际 Fastify HTTP、生产 CaptureService 和 HMAC/额度结算：5 个主请求、3 次解释、2 次拒绝检查；ready/review/fallback/retake/no_result 均可离线重算，余额 30→27、持有为 0。供应商只在测试中受控，真实模型调用 0 | 同专项日志，两个真实路由集成测试 |
| 完整 `verify.sh` | **Node 435 通过；Swift 233 执行、2 跳过、0 失败**；repo-health、TypeScript strict、隔离服务 smoke、Swift warnings-as-errors、arm64 Release、空白检查通过 | `.release-evidence/2026-09-06/verify-reading-evaluation.log` |
| CLI 静态/实际执行 | 三个阅读执行/转换/预检 `.mjs` 通过 `node --check`；带临时合成证据的离线检查和转换已实跑，缺启用开关时不发请求 | 专项日志、`reading-evaluation-validation.json` |
| 真实评测预检 | 退出码 **2（条件未满足）**；240 张旧题图片 SHA 全匹配；授权阅读 manifest、隔离官方设备 token、候选核验及成本上界缺失；共享账本未创建、累计预算尚未使用 | `.release-evidence/2026-09-06/reading-evaluation-preflight.json` |
| QA 与历史服务证据 | 客户端完整源码、服务端源码及 QA bundle 文件摘要与上一轮记录一致；strict codesign 通过。本轮修改评测脚本及测试，没有改生产 Store/schema，无需重包；既有三存储 **507 通过**记录继续适用于未变的服务端代码 | `.release-evidence/2026-09-06/reading-evaluation-validation.json`、`codesign-reading-evaluation.log`、`capture-admission-all-postgres.log` |

当前 QA 仍为 **2.12 / 19**、arm64、最低 macOS 14.0；可执行文件 SHA-256 `49ffc51676c39ac302084204e858af32c167b2792226b2b6de6013e4ca19fe22`。本周期未公证、生成正式 DMG、提交、push、部署或放量，未启动 PostgreSQL 或 AppKit；本机 HTTP 对端与临时数据库均由测试清理。Swift 两个跳过项目是显式模型评测，未计作模型质量通过；仓库无独立 ESLint，实际静态检查如上。

完整输入契约和复核流程已写入 [阅读评测操作说明](reading-evaluation.md)。工具链不能替代真实候选的同模型 240 题比较、授权 ≥400 新题、≥80 解释独立评审、原生 UI/辅助功能、生产平台及灰度/经济观察，所有本地输出保留 `release_ready=false`。

## 未分配收款与注册并发修复周期（2026-09-07）

本周期完成 B20 的未入账签名收据读取、去重、归属与财务页面，报告定义升级为 `cohort-economics-v2`。同时修复完整 PostgreSQL 回归实际暴露的注册并发缺陷。手续费/拒付资源对账、真实资金核验和正式发布仍未完成。

- `reporting-receipts.ts` 按 Checkout 与 PaymentIntent 联合去重，检测跨资源、金额、币种和设备归属冲突。与截止时间前的全账户订单及历史充值核对后，已核验入账款项排除；不受所选注册批次是否为空影响，也不重复增加订单现金或 P28。只有完整、无冲突的收据进入毛额已知小计；净额始终未知，不改动额度。
- `reporting-sql.ts` 在同一一致事务内有界读取收据，按最多 250 个参数批量查设备、sealed purchase 及关联订单，避免全账户设备/订单扫描。Memory 使用同一纯归属与聚合逻辑。设备或购买会话在投递后才创建时不能倒推归属；内部/外部设备相互矛盾的收据保留在账户冲突池。
- 修复历史截止时间泄漏：过去先收到 webhook、后来才提交 Checkout 投影时，新 `checkout_deliveries.recorded_at` 记录实际投影时间。SQLite/Postgres 增量增加 nullable 列及索引，旧行不回填时间；仅按旧 webhook 时间进入待核对范围，明确标记 `legacy_timing_unknown`，不算已确认毛额。后来的事件或可变审核标记不改写更早 as_of 的收据事实。
- 本批次已识别设备的待入账付款只增加 P28 的未知设备数，账户未分配池不分摊至来源。相关币种贡献和履约情景贡献保持 null，`incomplete_inputs` 明确包含 `unallocated_paid_receipts`；金额/币种冲突不能被当成零。账户池在各来源报告重复展示时不可相加。
- 财务页区分本批次待入账、账户身份未分配、财务/归属冲突、信息缺失及历史时间未核验。旧归档缺字段显示“不能据此断言为零”；当前 v2 报告仍通过真实归档接口重算摘要、保存及读取。
- PostgreSQL 完整重跑曾出现 `23505 / idx_registration_key`：注册 INSERT 只处理 token 唯一索引，两个唯一索引下的并发重放可能从注册凭证索引抛错。现改为处理全部唯一冲突，再按 token 锁定并核验不可变凭证绑定；只有实际 INSERT 才授予 trial lot/ledger。Memory 同步凭证唯一与不可重绑规则。采用的是 PostgreSQL 官方支持的 [ON CONFLICT DO NOTHING 语义](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT)，没有吞掉任意数据库错误或无限重试。

| 验证 | 最终结果 | 日志 / 证据 |
|---|---|---|
| 收据聚合专项 | **9 通过，0 失败**；覆盖双资源去重、传递冲突、金额/币种/时间缺失、设备归属、内部冲突、P28、贡献及真实 SQLite 旧 schema 增量迁移 | `.release-evidence/2026-09-06/receipt-reporting-groups.log` |
| 注册修复三存储专项 | **36 通过，0 失败**；每种存储 16 轮×8 个并发注册，验证同一设备、消费后的余额不重置；凭证冲突不会重绑、泄露其他账号或重发试用 | `.release-evidence/2026-09-06/receipt-registration-fix-targeted.log` |
| 完整 `verify.sh` | **Node 452 通过；Swift 233 执行、2 跳过、0 失败**；repo-health、strict TypeScript、隔离服务 smoke、Swift warnings-as-errors、arm64 Release、空白检查通过 | `.release-evidence/2026-09-06/verify-receipt-reporting.log` |
| 完整 Node＋PostgreSQL | **549 通过，0 失败**；包含 memory/SQLite/Postgres 的签名投递、历史 as_of、订单去重、sealed purchase/内部归属与注册修复 | `.release-evidence/2026-09-06/receipt-reporting-all-postgres.log` |
| 保留的故障证据 | 修复前一次完整运行 **545 通过、1 失败**；失败位置为并发注册，不是收据聚合。诊断后执行上述专项及完整重跑，未删除失败证据 | `.release-evidence/2026-09-06/receipt-reporting-postgres-registration-failure.log` |
| 本机浏览器 | 实际管理页面/路由/SQLite 归档完成财务视图、v2 保存、v1 缺字段兼容读取；DOM 核对待核对组数、冲突、按币种毛额及未知净额，桌面视口截图无表格重叠 | `.release-evidence/2026-09-06/receipt-reporting-ui-dom.txt`、`receipt-reporting-ui.png`、`receipt-reporting-ui-legacy-dom.txt`、`receipt-reporting-ui-legacy.png` |
| QA 产物一致性 | 客户端完整源码清单和 bundle 文件与现有签名 QA 包一致，strict codesign 通过；服务端及测试摘要重新记录 | `.release-evidence/2026-09-06/receipt-reporting-validation.json`、`codesign-receipt-reporting.log` |

浏览器只使用隔离回环服务、内存 SQLite 与明确的合成财务事实；验证 UI 和真实归档行为，不代表实际 cohort、Stripe 收款或利润。测试页面、HTTP 服务及本机 PostgreSQL 已关闭。没有启动原生 AppKit 或执行新的原生屏幕/可访问性验收。仓库无独立 ESLint；Swift 两个跳过项目仍是需显式执行的模型评测。

QA 版本仍为 **2.12 / 19**，arm64、最低 macOS 14.0，可执行文件 SHA-256 `49ffc51676c39ac302084204e858af32c167b2792226b2b6de6013e4ca19fe22`。本周期没有调用真实模型、付款或退款，没有读取/迁移生产数据库、公证、正式 DMG、提交、push 或部署。100 CNY 共享评测预算未发生新支出。

真实 Stripe 连接返回 `oauth_token_invalid_grant`，已请求用户重新连接；尚未核验真实资源和权限。公开官方 [变更日志](https://docs.stripe.com/changelog) 当前列出 `2026-08-26.dahlia`，不能据此推定账户/Webhook 使用该版本；本周期未改 Stripe API 版本。官方 [Balance Transaction](https://docs.stripe.com/api/balance_transactions/object) 的费用、净额及换汇字段需要独立资源事实，与收据毛额分开。后续继续完成手续费/拒付的持久化核对和按截止时间修订，不把 observed webhook 事件当成最终损失或费用。

## 手续费、退款与争议资源核对周期（2026-09-07）

本周期完成 B20 的订单财务资源读取、持久化重核、不可变修订和运营报表接入，定义升级为 `cohort-economics-v3`。B18 的恢复任务同时接入资源核对与漏记退款修复。本机代码和协议验证通过；真实 Stripe 权限、资金准确性、生产迁移及发布闸门仍未通过。

- `payment-finance.ts` 与 Memory/共享 SQL 实现新增通知序列、租约任务、资源唯一归属和不可变修订。读取前冻结 generation 与通知 watermark；同毫秒到达的新通知仍要求重核，过期 worker 不能覆盖新读取。跨订单交易或同一余额交易绑定多个财务父资源均被拒绝，SQL 以有界批次保存资源并原子校验归属。
- `stripe-finance.ts` 只执行 Charges、Refunds、Disputes 的有界 GET，并读取展开的 Balance Transactions。单次读取共用 8 秒截止时间、每响应最多 1 MiB，严格 JSON/UTF-8/资源身份/金额/币种；分页未读完或超过资源限量会延后核对，不能截断后宣布完整。仅保留最小财务字段，丢弃客户、卡片及争议证据内容。
- 手续费按唯一余额交易和实际结算币种汇总，分别处理独立费用、退费、退款失败冲回、争议扣款与返还。争议本金与费用分开；未决状态、缺失交易、异常本金、通知晚到或未经核验的汇率均阻止完整净额/贡献。当前覆盖订单所关联的资源图；账户未关联费用及服务支出仍需实际账单和分摊证据，不能据此断言全账户费用齐全。
- 新订单无需等待 webhook 即可被发现；正常读取每日更新，信息不完整五分钟重查，失败一分钟重试、五次进入 review。签名通知或管理员可触发重新核对。独立 reaper 每次最多三笔，进程 worker 共用既有支付恢复互斥和关闭等待。管理员 GET/POST 接口均鉴权、no-store，重核另有限流与租约保护。
- 资源读取发现漏记/不同状态退款时，批量生成明确的本地 `finance.refund.reconcile` 项进入原退款队列。原 worker 再次读取当前 Refund 后才应用额度状态机；该来源不冒充 Stripe 签名事件，不发起现金退款。快照与退款账本不一致时，报表继续显示未知。回滚至不认识该本地类型的旧服务前，必须排空相关待处理项并核验持有，保留新表和修订。
- `reporting-finance.ts` 与报表一致事务按 as_of 选择最新不可变修订，核验摘要与资源通知，避免后来的可变状态污染历史结果。v3 页面增加订单覆盖、待重核、退款缺项及未决争议；旧 v2 归档明确缺少覆盖读数，空订单窗口显示“尚未读取”。正常归档保存和摘要校验继续使用实际接口。
- 专项测试暴露 PostgreSQL 旧财务调整使用数据库 NOW、其余财务事实使用应用 UTC 时钟的差异；受控时钟下，较晚调整未正确使费用变为未知。现显式写入应用 UTC recorded_at，与三存储其他事实一致；不修改旧行时间，保留修复前失败日志。这是测试验证的时钟来源差异，未据此宣称发生过生产资金事故。

| 验证 | 最终结果 | 日志 / 证据 |
|---|---|---|
| 财务三存储与协议专项 | **30 通过，0 失败**；覆盖租约/通知竞态、截止时间、资源去重、退款修复、费用/争议未知、超过单 SQL 批次、SQLite 重启与摘要破坏，以及受限 Stripe GET | `.release-evidence/2026-09-06/payment-finance-targeted.log` |
| 完整 `verify.sh` | **Node 474 通过；Swift 233 执行、2 跳过、0 失败**；repo-health、strict TypeScript、隔离服务 smoke、Swift warnings-as-errors、arm64 Release、空白检查通过 | `.release-evidence/2026-09-06/verify-payment-finance.log` |
| 完整 Node＋PostgreSQL | **579 通过，0 失败**；包含 memory/SQLite/Postgres 财务读取与既有支付、账本、报告和 API 回归 | `.release-evidence/2026-09-06/payment-finance-all-postgres.log` |
| 保留的故障证据 | 修复前专项 **29 通过、1 失败**；PostgreSQL 调整 recorded_at 时钟来源不一致。修复后上述专项与全套均通过 | `.release-evidence/2026-09-06/payment-finance-clock-mismatch.log` |
| 本机浏览器 | 真实页面/路由/SQLite 归档验证 v3 财务覆盖、未知净额/手续费、保存、v2 兼容读取及空窗口；1280×720 视口截图无重叠 | `.release-evidence/2026-09-06/payment-finance-ui.png`、`payment-finance-ui-dom.txt`、`payment-finance-ui-legacy-dom.txt`、`payment-finance-ui-empty-dom.txt` |
| QA 一致性 | 完整客户端源码及签名 bundle 与现有 QA 包一致，strict codesign 通过；当前服务端、测试、文档与证据摘要重新登记 | `.release-evidence/2026-09-06/payment-finance-validation.json`、`codesign-payment-finance.log` |

浏览器仅使用隔离本机 SQLite 和明确的合成财务事实，验证范围是页面与归档行为。它不证明真实 Stripe 收费、cohort 或利润；原生 AppKit/Keychain/UI 未在本轮验收。浏览器测试页、HTTP 服务及 PostgreSQL 均已关闭。仓库没有独立 ESLint；Swift 两个跳过项目仍为需显式运行的模型评测。

QA 仍为 **2.12 / 19**、arm64、最低 macOS 14.0，可执行文件 SHA-256 `49ffc51676c39ac302084204e858af32c167b2792226b2b6de6013e4ca19fe22`。客户端没有本轮代码变化，无需重包。本周期没有真实模型调用、现金退款、生产数据库读取/迁移、公证、正式 DMG、提交、push 或部署；100 CNY 共享评测预算无新支出。

本轮重试 Stripe 连接仍返回 `oauth_token_invalid_grant`，此前重新连接请求尚待回复。只读实现依据官方 [Disputes list](https://docs.stripe.com/api/disputes/list)、[Dispute object](https://docs.stripe.com/api/disputes/object)、[Refund object](https://docs.stripe.com/api/refunds/object) 及 [Reporting categories](https://docs.stripe.com/reports/reporting-categories) 核对；未读取真实账户 API/Webhook 版本，也未更改版本或订阅。接口、读取权限、完整事件名、迁移和回滚约束见 [API 文档](official-api.md)。

## 官方账户、Keychain 与迟到响应隔离周期（2026-09-07）

本周期推进 B23 / AC01、AC06、AC12，直接修复官方注册、刷新与充值交接的账户竞态，并验证默认 `.live` SSE 到全局镜像的真实 HTTP 路径。尚未完成 NotchController 父请求/题组联动、真实界面及部署平台验收，不能据此宣布全部账户或客户端验收完成。

- 新增 `OfficialAccountState.swift`，统一原 Keychain 凭证、UserDefaults 镜像、服务地址/令牌摘要绑定及身份 generation。锁覆盖身份核验和镜像提交，通知在解锁后发送，观察者可同步读取。服务/设备变化会清理旧缓存的余额版本、CLI 和累计量；不会改动服务端实际余额或另造付费归属。
- `KeychainStore` 将 item-not-found 与不可读取/无法解码分开。只有明确缺少 token、且无旧明文恢复副本时才准备注册；Keychain 锁定或 ACL 错误不再被误当成新设备。旧明文只有在 Keychain 无项目时迁移，写入失败保留副本；无法读取已存在 Keychain 时不使用旧明文覆盖它。
- 每个账户存储实例有独立注册合并任务。256-bit 重试凭证先写入并读回核验；网络响应丢失、正式 token 写入失败均复用原凭证。响应提交核验发起时地址、generation、当前凭证为空及原 retry credential；账户替换、显式重置或服务变化后，迟到注册不能写入旧 token。新 token 确认保存后才清理重试项。
- `refreshAccount` 冻结当前身份及请求序列，主线程应用前重新核验。旧账户的成功响应/401、较早刷新、旧 balance_version 均不能覆盖较新账户的余额/权限/总量；当前有效 401 仍保留唯一凭证。服务端总量可纠正偏高本地估计，不使用永久取最大值掩盖差异。SSE 与 status 的默认 `.live` 回调进一步通过同一存储执行带身份核验的更新。
- 注册、刷新与购买交接共用有界 JSON 传输：64 KiB 上限、严格媒体类型、字段类型/非负整数/版本、取消检查和明确禁止 HTTP 重定向。任何解码失败在镜像写入前返回；旧无版本响应不能覆盖已版本化镜像。
- 显式重置先删除重试凭证，再删除设备 token；任一失败都停止重新领取并保留镜像，设置页显示可重试错误。购买交接在网络响应返回和设置页真正调用浏览器打开之前两次核验账户绑定，防止 await 后切换账户仍打开旧购买链接。
- `verify.sh` 的普通 Swift 测试固定启用 DEBUG ephemeral Keychain，避免既有迁移测试读取/替换用户真实 API Key。新账户集成套件显式使用随机、独立 service 的真实 Security API 与独立 defaults suite；结束时清理测试项目。Keychain 错误分支使用明确的故障注入，不声称真实锁定 Keychain 故障被现场复现。

| 验证 | 最终结果 | 日志 / 证据 |
|---|---|---|
| 账户专项（完整回归内） | **18 通过，0 失败**；8 并发注册合为一次 HTTP、丢失响应同凭证重试、Keychain 拒读/拒写、重置失败、账户/服务切换、迟到成功/401、乱序刷新、非法 JSON/超限/重定向/取消、真实 Keychain 迁移/重开、100 并发余额版本及默认 `.live` SSE/全局镜像 | `.release-evidence/2026-09-06/verify-account-state.log` 中 `OfficialAccountStateTests` |
| 完整 `verify.sh` | **Node 474 通过；Swift 251 执行、2 跳过、0 失败**；repo-health、strict TypeScript、隔离服务 smoke、Swift warnings-as-errors、arm64 Release 和空白检查通过 | `.release-evidence/2026-09-06/verify-account-state.log` |
| 服务端三存储证据 | 当前 63 个服务端源码/配置文件摘要与上轮财务验证完全一致；上轮 **579 通过**的三存储记录继续适用于这些未修改文件。本周期未启动 PostgreSQL，不将历史运行冒称本轮重跑 | `.release-evidence/2026-09-06/payment-finance-all-postgres.log`、`account-state-validation.json` |
| 重新打包与资产 | Developer ID、hardened runtime、strict codesign、arm64、原 bundle ID、plist 和源图标一致性通过；客户端完整 55 文件清单和 4 个 bundle 文件重新记录 | `.release-evidence/2026-09-06/package-qa-account-state.log`、`codesign-account-state.log`、`codesign-account-state-details.log`、`artifact-manifest-account-state.json` |
| 原生界面条件 | Computer Use 对 Finder 的只读状态查询返回桌面锁定且无法解锁；未取得界面、未启动候选 App，点击/语言/辅助功能验收仍未通过 | `.release-evidence/2026-09-06/account-state-native-ui-availability.json` |

QA 仍为未发布的 **2.12 / 19**，最低 macOS 14.0；本轮最终可执行文件 SHA-256：`bd2532eedc3a9f05aab539a366abe6448ece05d056a95c515f097207489e6bea`。上一份 QA 包已按原摘要保存于 `.release-evidence/2026-09-06/qa-before-account-state/NotchSPI.app`，新包位于 `dist-qa/NotchSPI.app`。没有公证、正式 DMG、提交、push、部署、真实模型调用、现金退款或生产数据库操作；100 CNY 评测预算本轮无支出。Swift 两个跳过项为需显式执行的模型评测；没有独立 ESLint。

后续 B23 继续核验 `NotchController` 的父 capture 身份绑定及切换时题组清理，并检查服务端 `/v1/account` 的 account 与 quota 读取是否来自同一结算快照：当前路由先鉴权读取 account，再 await reap/quota，现有客户端序列保护不能代替服务端事务一致性。上述源代码审计项尚未标为完成。完整证据见 `.release-evidence/2026-09-06/account-state-validation.json`；真实桌面、模型题集、Stripe 连接及生产观察条件仍未满足。

## 服务端账户快照一致性周期（2026-09-07）

本周期完成 B23 中服务端账户读取的一致性修复。首先在三存储复现了两个问题：`/v1/account` 的新余额/版本配上鉴权时的旧累计量/CLI，以及 `/v1/devices` 的新版本配上 registerDevice 返回时的旧余额。修复前六个定向用例均失败，原始证据保留；这些是隔离数据库中的并发复现，没有声称发生过真实生产资金事故。

- `BillingStore` 新增 `accountSnapshot`。共享 SQL 实现在一个事务中锁定 devices 行，再读取该设备 quota lots，返回同一状态的余额、版本、held、分项、计数与权限。SQLite 沿用同步事务，Postgres 沿用设备行锁；Memory 在无 await 的同一执行段复制。没有改变 schema、账本写入或 HTTP 字段。
- `/v1/account` 在鉴权诊断、过期持有恢复之后使用完整快照，停止拼接之前取得的 Account。缺失返回 401，快照读取失败不回退至过期数据；错误响应不泄露底层故障文本。非负安全整数校验阻止超大计数被舍入后发送，版本仍按字符串保留超过 2^53 的精度。
- `/v1/devices` 的余额与版本从同一 quota 快照返回，保留初始 grant 与当前可用余额的区别。无法取得快照时返回可重试的 503，客户端保留原注册重试凭证。
- 新专项每种存储执行 20 轮结算，每轮 12 个并发快照读取，核验只能看到完整 held 或 settled 状态；返回值不随后续结算改变。另覆盖过期释放、读取故障、真实 SQLite 历史无 lot 行的期初投影/重开、账本只创建一次及异常持久计数拒绝输出。

| 验证 | 最终结果 | 日志 / 证据 |
|---|---|---|
| 修复前复现 | **6 失败**；每种存储两个路由均返回混合快照，差异包括 balance/版本及 totals/CLI | `.release-evidence/2026-09-06/account-snapshot-before-fix.log` |
| 三存储快照专项 | **17 通过，0 失败**；每种存储 20×12 并发快照、过期/异常/未知账户，以及 SQLite 重开与版本精度 | `.release-evidence/2026-09-06/account-snapshot-targeted.log` |
| 完整 `verify.sh` | **Node 486 通过；Swift 251 执行、2 跳过、0 失败**；repo-health、strict TypeScript、隔离服务 smoke、Swift warnings-as-errors、arm64 Release、空白检查通过 | `.release-evidence/2026-09-06/verify-account-snapshot.log` |
| 完整 Node＋PostgreSQL | **596 通过，0 失败**；当前源码的三存储与所有现有 API/支付/财务/报告回归 | `.release-evidence/2026-09-06/account-snapshot-all-postgres.log` |
| QA 一致性 | 客户端完整 55 文件清单及 4 个 bundle 文件与上轮签名 QA 完全一致；strict codesign 再次通过，无需重包 | `.release-evidence/2026-09-06/account-snapshot-validation.json`、`codesign-account-snapshot.log` |

本机 PostgreSQL 已停止；测试 schema 和临时 SQLite 文件由测试清理。版本仍为未发布 **2.12 / 19**，arm64、最低 macOS 14.0；可执行文件 SHA-256 `bd2532eedc3a9f05aab539a366abe6448ece05d056a95c515f097207489e6bea`。本轮没有原生 GUI、真实模型/付款/退款、生产数据库、公证、正式 DMG、提交、push、部署或放量；100 CNY 评测预算无新支出。Swift 两个跳过项仍为显式模型评测，仓库没有独立 ESLint。

本轮只证明服务端快照一致性及现有双端回归。后续继续核验客户端“账户刷新已包含某次用量，SSE 回执随后到达”的累计量去重，以及 NotchController 的父请求身份/题组联动；它们不能仅靠服务端快照修复宣布完成。真实 UI、质量、迁移回滚、部署平台和灰度观察闸门仍保持未通过。

## 客户端累计用量快照周期（2026-09-07）

本周期完成 B23 的刷新/SSE 累计量去重。修复前先复现账户刷新已包含一次结算、同版本 SSE 随后到达时题数 21→22、输入 token 210→220、输出 token 42→44 的重复计入；日志保留三个失败断言。

- `BillingStore.finish` 在原有结算事务和设备锁内返回 `AccountSnapshot`；Memory 在同一无 await 执行段复制。SSE、status 及重复请求元数据新增完整 `account_totals`，余额与累计量共享版本。没有新增 schema 或修改收费规则。
- 客户端按账户身份和十进制版本整体替换累计值，重复回执幂等，乱序旧回执不回退余额/计数；新快照已经包含先前结算，不会漏计。辅助操作沿用服务端累计 solve 口径，顶层尝试 token 不再混入账户累计；模型费用仍由尝试账本记录。
- 旧服务器缺失累计快照时保留本地已知计数，按原账户发起有界 GET；启动前和提交后均有身份保护。默认 `.live` 与隔离测试使用同一连接逻辑。解码验证完整组、整数类型、非负范围及余额版本，非法响应不能部分更新。
- 测试覆盖重复/乱序/旧刷新、辅助 token、status 重复提交、替换账户隔离、旧回执实际 HTTP 刷新，以及全部三存储结算返回值、并发读取和重复 finish。没有把测试对端或数据库夹具当作模型质量及生产流量证据。

| 验证 | 最终结果 | 日志 / 证据 |
|---|---|---|
| 修复前复现 | 1 个用例、**3 个失败断言** | `.release-evidence/2026-09-06/usage-totals-before-fix.log` |
| Swift 定向 | **36 通过、0 失败** | `.release-evidence/2026-09-06/usage-totals-swift-targeted.log` |
| 双存储路由及账户专项 | **42 通过、0 失败** | `.release-evidence/2026-09-06/usage-totals-server-targeted.log` |
| 三存储账户快照专项 | **20 通过、0 失败** | `.release-evidence/2026-09-06/usage-totals-postgres-targeted.log` |
| 完整 `verify.sh` | **Node 488 通过；Swift 257 执行、2 跳过、0 失败**；repo-health、strict TypeScript、隔离 smoke、warnings-as-errors、arm64 Release 及空白检查通过 | `.release-evidence/2026-09-06/verify-usage-totals.log` |
| 完整 Node＋PostgreSQL | **599 通过、0 失败** | `.release-evidence/2026-09-06/usage-totals-all-postgres.log` |
| QA 重包与资产 | Developer ID / hardened runtime、strict codesign、arm64、plist 和源图标一致性；客户端/服务端/产物 SHA 重新记录 | `.release-evidence/2026-09-06/package-qa-usage-totals.log`、`codesign-usage-totals.log`、`artifact-manifest-usage-totals.json`、`usage-totals-validation.json` |

当前 QA 仍为未发布的 **2.12 / 19**，最低 macOS 14.0；可执行文件 SHA-256 `6cfeae7616b19429740efb55f1e8f4c6bcc3998276b9bb141fbaf7abafc54707`。上一份完整签名包已按全部文件摘要归档至 `.release-evidence/2026-09-06/qa-before-usage-totals/NotchSPI.app`。测试临时资源由夹具清理，本机 PostgreSQL 已停止。两个 Swift 跳过项仍是显式模型评测；仓库无独立 ESLint。

本周期无真实模型/付款/退款、生产数据库、公证、正式 DMG、提交、push 或部署；100 CNY 预算无新支出。新增字段需遵守服务端先行发布。NotchController 父请求身份联动、真实原生 UI、质量输入、Stripe 核验、生产迁移/回滚及实际灰度窗口仍未完成，不能以本轮回归替代。

## 父请求身份与题组边界周期（2026-09-07）

本周期修复 B23 的父请求身份缺口：原 `RunSnapshot.channelID` 动态读取官方 base URL 且未包含设备身份；controller 的账单补查、解释及恢复会读取当前账户，周期清理也未使旧回调失效。

- 新增 `CaptureRequestBinding`，冻结目标、模式、用户选择和真实通道身份。官方包含 base/token/generation，自定义包含 provider/endpoint/model/Key，CLI 包含后端。长度前缀编码后生成本地 scope 摘要，不把明文凭证放入材料 scope 或遥测。
- `OfficialAPI.CaptureEnvironment.connected` 冻结创建时或明确指定的账号；更换后即便还没 dispatch 也不能改用新账号。`reconcileCaptureStatus` 使用保留父请求凭证，在请求前与响应提交时核验身份，并更新同账号的完整结算镜像。
- `NotchController` 在截图、区域选择、裁剪、材料接管、正文/解释/恢复回调及补查处检查冻结绑定。账户通知和周期检查触发材料清理，取消官方任务与补查、关闭 picker、递增 generation；旧返回不能清除后来创建的 picker。模式切换、显式清理和超时同样处理相应边界。
- 首次注册在本次查题截图前完成。先保存正文的合法首用旅程保留：只有未注册、同一选择、未过期且仍为原 scope 的材料组，才能绑定至本次成功确认的账号；已有账号之间不能转移。文件测试覆盖注册后继续两图上下文，原页序和会话 ID 均保留。
- 新增 8 个测试，覆盖身份/generation/通道变化、scope 不含明文密钥、旧环境 dispatch 拒绝、旧父状态请求实际 HTTP 身份与迟到响应隔离，以及首用材料绑定和到期拒绝。初次测试夹具遗漏必填 body 的编译错误已修正，最终全量运行无编译错误；没有把该夹具错误描述成产品故障。

| 验证 | 最终结果 | 日志 / 证据 |
|---|---|---|
| 绑定、账户、capture、材料定向 | **50 通过、0 失败** | `.release-evidence/2026-09-06/request-binding-targeted.log` |
| 完整 `verify.sh` | **Node 488 通过；Swift 265 执行、2 跳过、0 失败**；repo-health、strict TypeScript、隔离 smoke、Swift warnings-as-errors、arm64 Release 及空白检查通过 | `.release-evidence/2026-09-06/verify-request-binding.log` |
| 最后 picker 清理补丁 | 全量串行 Swift **265 执行、2 跳过、0 失败**；随后 Release 重编译和 QA 签名 | `.release-evidence/2026-09-06/request-binding-swift-final.log`、`package-qa-request-binding.log` |
| 三存储服务证据 | 当前全部 63 个服务源码/配置摘要与上周期一致，既有 **599 通过**的 PostgreSQL 记录继续对应这些文件；本周期未启动 PostgreSQL | `.release-evidence/2026-09-06/usage-totals-all-postgres.log`、`request-binding-validation.json` |
| QA 资产 | Developer ID / hardened runtime、strict codesign、arm64、plist 与图标一致性；完整 56 个客户端文件和 4 个 bundle 文件重新登记 | `.release-evidence/2026-09-06/artifact-manifest-request-binding.json`、`codesign-request-binding.log` |
| 原生 UI 条件 | Computer Use 查询再次返回桌面锁定，未启动候选 App、未完成交互验收 | `.release-evidence/2026-09-06/request-binding-native-ui-availability.json` |

当前签名 QA 仍为未发布的 **2.12 / 19**，最低 macOS 14.0；可执行文件 SHA-256 `fa38272ee9fd0f4014222580715d41f939adfb927a3b0b528f012ed1af0bc734`。上周期完整签名包已按所有文件摘要归档于 `.release-evidence/2026-09-06/qa-before-request-binding/NotchSPI.app`。没有真实模型/付款/退款、生产数据库、公证、正式 DMG、提交、push 或部署；100 CNY 预算无新支出。两个跳过项仍为显式模型评测，仓库没有独立 ESLint。

本轮代码和核心测试不证明真实 UI 已通过 AC07/08。下一项继续核验恢复后可见答案的解释父链：当前服务辅助端点仅接受 solve 父请求，恢复子结果虽有自己的 answer_hmac，客户端尚未将其解释能力与原收费祖先的一次性限制贯通。该项、真实 UI、迁移回滚、Linux 资源、质量和生产观察仍未标为完成。

## 恢复答案解释与原收费名额周期（2026-09-07）

本周期贯通恢复答案的解释。修复前 Memory/SQLite 两个路由回归均复现 409：原收费答案 B、恢复答案 C，客户端无法为 C 请求解释。修复保持原收费 solve 为唯一路由、成本与名额父节点，不新增收费或延长免费窗口。

- 可选 `answer_capture_id` 选择当前显示的直接恢复子答案；原图片/范围/语言/profile 与选中答案 HMAC 均须匹配。同设备、原父明确关联、recover 已终结且可用、绑定版本一致，才能用于解释。旧请求省略该字段时沿用原语义和原 HMAC 格式。
- `BillingStore.begin` 在原设备锁和事务中重核父链、占用原 solve 的 `explanationCaptureId` 及原表唯一槽。20 个原/恢复答案并发请求只有一个成功；失败后两个入口都不能再领。恢复在第 899 秒完成，也不能在原父第 900 秒开启解释。元数据可选增加 `answerCaptureId`，成本父链和表主键不变，无 DDL。
- solve/recover 的 `explanation_available` 从当前功能开关、原父期限和已用名额计算。Swift 区分收费 capture 与当前答案 capture；通过原收费路径携带恢复 ID，只在完整交付且明确允许后开放解释。非法 capability、账户在镜像回调中更换、正文截断及仅收到回执均有专门验证。
- 解释仍只写解释区域，保留用户当前答案；原收费题数与 lifetime solve 计数不因恢复或解释增加，所有模型尝试另行记录。

| 验证 | 最终结果 | 日志 / 证据 |
|---|---|---|
| 修复前路由复现 | **2 失败**，均为恢复答案解释 409 而非 200 | `.release-evidence/2026-09-06/recovered-explanation-before-fix.log` |
| 三存储账本与路由专项 | **77 通过、0 失败**；三存储争用/非法父链/失败/原父期限，Memory/SQLite 完整路由与 selector 检查 | `.release-evidence/2026-09-06/recovered-explanation-server-targeted.log` |
| Swift 定向 | **58 通过、0 失败**；实际 HTTP 路径/原材料/selector、capability 与正文完成分离、账户回调重核及严格解码 | `.release-evidence/2026-09-06/recovered-explanation-swift-targeted.log` |
| 完整 `verify.sh` | **Node 498 通过；Swift 269 执行、2 跳过、0 失败**；repo-health、strict TypeScript、隔离 smoke、Swift warnings-as-errors、arm64 Release 及空白检查通过 | `.release-evidence/2026-09-06/verify-recovered-explanation.log` |
| 完整 Node＋PostgreSQL | **612 通过、0 失败** | `.release-evidence/2026-09-06/recovered-explanation-all-postgres.log` |
| 签名 QA 与源摘要 | Developer ID / hardened runtime、strict codesign、arm64、plist/图标一致性，56 个客户端及 63 个服务文件和 4 个 bundle 文件重新登记 | `.release-evidence/2026-09-06/artifact-manifest-recovered-explanation.json`、`codesign-recovered-explanation.log`、`recovered-explanation-validation.json` |
| 原生 UI 条件 | Computer Use 再次返回桌面锁定；未启动候选 App，实际点击/辅助功能未验收 | `.release-evidence/2026-09-06/recovered-explanation-native-ui-availability.json` |

当前 QA 仍为未发布的 **2.12 / 19**，最低 macOS 14.0；可执行文件 SHA-256 `f18fe653b14896201f64d653464c3656030c5427ffc66c031ded0e445e0b662d`。上一份完整 QA 已按所有文件摘要归档至 `.release-evidence/2026-09-06/qa-before-recovered-explanation/NotchSPI.app`；本机 PostgreSQL 已停止。无真实模型/付款/退款、生产数据库、公证、正式 DMG、提交、push 或部署；100 CNY 预算无新支出。两项 Swift 跳过仍为显式模型评测，仓库没有独立 ESLint。

本轮关闭恢复答案解释的代码/协议/账本缺口，不代替真实 UI、模型质量或灰度证据。下一工程周期继续旧数据迁移/回滚和部署平台资源验收；原生交互须待桌面解锁，生产与质量闸门仍未完成。

## 2026-09-07 额度迁移、停流与兼容回退

本周期推进 B23/B24 的旧数据库升级和回退边界。原实现只有首次访问时建立 opening lot，没有迁移检查点或持久化停流/验证流程；现已接入真实存储与操作 CLI。本地验证通过，尚未执行生产迁移。

- `quota-migration.ts` / schema 新增控制行、设备检查点和不可变状态事件。旧余额 lot/ledger/检查点同事务提交，包含历史 topups/usage 分页摘要；原账户字段与已购记录保留，旧注册不补发 trial。新注册继续 fixed30。
- 兼容实例共享数据库准入锁；暂停后不建立新 capture，旧请求仍可结算/恢复。按设备批次检查 lot/ledger/reservation/余额、历史记录和余额版本，失败整批回滚。恢复时排他锁重核全部设备和在途状态；CLI 显式目的地、跨进程继续、完整重验和修订校验已执行验证。
- SQLite schema 扩展改为整批事务；Postgres 使用按 schema 的 advisory lock 串行扩展并完整重试。真实旧 schema 来自 Git `7ba96db7408b8e203adfb133947535a604806fb0`，测试文件保留原源摘要；4 个 SQLite 子进程和 8 个 PG Store 冷启动/重开通过。
- 完整 PG 回归发现迁移锁查询与报表 SET TRANSACTION 顺序冲突（13 个失败，错误 25001）。已把只读快照明确传给事务执行器，在首个查询前设置 REPEATABLE READ READ ONLY，由数据库禁止写入；兼容余额写入继续持有迁移锁。原失败日志保留，联合及全套复验通过。
- 旧 HTTP 停流返回 `503 service_maintenance` / `Retry-After: 60`，验证没有模型调用、扣费或遗留预算持有。既有 Store reserve/settle/credit 适配在升级后保持一致，充值重复引用不重复发放。模拟旧二进制直接改余额和历史充值行时，校验阻止恢复服务；这不能代替生产旧实例退出与数据库写权限收回。

| 验证 | 结果 | 证据 |
|---|---|---|
| 双持久存储迁移专项与真实 CLI | **13 通过、0 失败**：旧 schema、历史保留、批次/进程重启、并发 pause、在途结算/过期恢复、坏批回滚、直接写入检测、修订与旧 HTTP | `.release-evidence/2026-09-06/quota-migration-targeted-postgres.log` |
| 迁移＋报表＋财务联合 | **67 通过、0 失败** | `.release-evidence/2026-09-06/quota-migration-with-reporting-targeted.log` |
| PG 隔离设置问题复现 | **13 失败**，25001；已修复并复验 | `.release-evidence/2026-09-06/quota-migration-postgres-isolation-before-fix.log` |
| 完整 Node＋Postgres | **625 通过、0 失败** | `.release-evidence/2026-09-06/quota-migration-all-postgres.log` |
| 完整 verify.sh | **Node 505 通过；Swift 269 执行、2 跳过、0 失败**；strict TS、repo-health、隔离 smoke、Swift warnings-as-errors、arm64 Release、空白检查通过 | `.release-evidence/2026-09-06/verify-quota-migration.log` |
| QA 完整性 | 客户端 56 项输入与既有签名包对应；strict codesign 通过，4 项 bundle 文件摘要复核 | `.release-evidence/2026-09-06/quota-migration-validation.json`、`codesign-quota-migration.log` |
| 服务端源码候选归档 | 68 项文件全部核验；解包后在独立 SQLite 实际执行 pause/batch/完整重验/resume，147 旧余额和历史充值保持 | `.release-evidence/2026-09-06/server-compatibility-quota-migration.tar.gz`、`server-compatibility-quota-migration-rehearsal.json` |

QA 仍为未发布 **2.12 / 19**，arm64、最低 macOS 14.0，可执行文件 SHA-256 `f18fe653b14896201f64d653464c3656030c5427ffc66c031ded0e445e0b662d`；本轮客户端无变化。服务端源码归档 SHA-256 为 `59fb294b856ef14cd8c52e3e89f1a4321b1f505d0251484bf58048b61a7cd11f`；解包演练使用本机 lockfile 安装的依赖，尚未完成 Linux 目标运行、生产配置或部署验证。完整摘要见 `quota-migration-validation.json`。迁移接口与执行顺序见 [迁移/回退规程](quota-migration.md)。CLI status 同样包含 schema 初始化，不能作为只读生产探针。本机 PostgreSQL 和临时演练数据库均已停止/清理。

本轮没有真实模型/资金操作、生产数据库、公证、正式 DMG、提交、push 或部署；100 CNY 评测预算无新支出。仍需核验生产备份恢复、旧 deployment/任务/写权限退出及真实锁耗时；原生桌面、模型评测、Stripe 连接和真实灰度条件仍未满足。下一工程项为 Linux 目标运行与资源验收，不能将本地 migration 测试记为生产上线。

## Linux 运行与官方传输限制周期（2026-09-07）

本周期核验实际部署目标并修正客户端传输预算。Vercel 项目确认为 Node 24.x；[函数入口上限为 4.5 MB](https://vercel.com/docs/functions/limitations)，原客户端允许的 JSON 会超过平台入口，因此不能沿用 self-hosted 的 16 MiB 常量承诺官方请求容量。

- `OfficialCaptureMaterials` 按 base64 编码大小计数；多页兼容请求的最后一张问题图出现两次，也占两份预算。完整 JSON 在发送前限制为 4 MiB；使用不转义斜杠的序列化避免 base64 再膨胀。读取与最终 JSON 两层分别拒绝超限，保持所有原始图片字节、页序和既有截图质量。
- 平台纯文本 413 与服务端 `payload_too_large` 均映射为三语框选/减少材料提示。超限发送前停止；413 不重发 POST，也不补造收费回执。服务端 Vercel 模式采用 4,500,000 字节 parser 限制，self-hosted 保留 16 MiB。
- 新增真实 HTTP 边界测试覆盖 Content-Length / chunked 的恰好上限与多一字节、四页与兼容题图、含大量斜杠的 base64、材料可编码但 JSON 包络超限，以及无任何 HTTP/模型/收费副作用的拒绝路径。修复前的 Swift 和 Node 失败日志保留。
- Linux 使用固定 Node 24.20.0 / Amazon Linux 2023 x86_64 镜像，全新安装 lockfile 的 optional 原生依赖，实际加载 sharp 0.35.4 / libvips 8.18.6 / glibc 2.34。源码与测试只在断开外网后的内部容器网络中使用；PostgreSQL 为单独测试容器。执行方式和边界见 [Linux 运行规程](linux-runtime-verification.md)。
- 资源探针初次失败来自验证代码：在生产 ESM 模块之后加载 sharp 的 CommonJS 包装器，重新启用了共享原生缓存。调整加载顺序后，原有零缓存、零队列和内存断言全部通过。实际完成 21 次 16MP 解码、8 次并发上限拒绝，峰值 RSS 364.00 MiB / cgroup 305.58 MiB，容器上限 1 GiB；非法输入之后仍可解码，四页摘要和原字节一致。QEMU 耗时只作诊断，不代表生产 SLA。
- Linux 首轮实际执行 627 项，620 通过、7 失败：六项来自验证输入缺失，一项为 SQLite 四进程冷启动在 `PRAGMA journal_mode = WAL` 返回 SQLITE_BUSY。已在初始化加入仅作用于 journal-mode 的有限重试（5 秒单调总预算、25ms 间隔），所有初始化错误均关闭连接。SQLite 可能跳过 busy handler 以避免死锁，因此增加原有 timeout 本身不能解决该竞争；依据 [SQLite busy handler 说明](https://www.sqlite.org/c3ref/busy_handler.html)。macOS 重验还发现测试在提前 413 后继续写请求体引发 EPIPE，现将 Content-Length 提前拒绝和 chunked 实收边界分别验证。
- Linux 第二轮记录 600 个通过用例及一个财务测试文件级退出（该文件含 27 项），原 spec 输出只有 `test failed`，没有可用退出原因；内核无崩溃记录，cgroup OOM/kill 均为 0。财务文件改用 TAP 诊断独立重跑 27 项全过，8 次只检查启动的诊断正常退出；这不能抹去原失败，模拟器全量验收仍未标为通过。现有 GitHub Actions 已扩展为 Node 22.18/24.20 × Postgres 16/17、串行 macOS Swift 和无外网的原生 AL2023 1 GiB 资源探针，准备在 `codex/product-update-2-12` 验证分支取得原生结果。该分支通过 `git.deploymentEnabled` 关闭 Vercel 自动部署，CI 不使用生产凭证。
- 另补测可接受的 16 位 RGBA PNG：累计 25 次解码、10 次并发拒绝，最终探针峰值 RSS 357.71 MiB / cgroup 299.68 MiB，队列与缓存条目为零。此前 8 位探针的峰值 RSS 364.00 MiB 原样保留；两次测量都低于 1 GiB，均不作为生产延迟证据。

| 验证 | 已确认结果 | 证据 |
|---|---|---|
| macOS 最终全量回归 | Node 507 通过；Swift 273 执行 / 2 跳过 / 0 失败；严格 TS、repo-health、隔离 smoke、warnings-as-errors 与 arm64 Release 编译通过 | `verify-linux-transport-final.log` |
| Linux 失败项所属套件重验 | 58 通过，0 失败，包含双数据库迁移与实际 CLI | `linux-runtime-repaired-targeted.log` |
| Linux 第二轮与财务诊断 | 600 用例通过＋1 文件级失败；财务独立重跑 27 通过；8 次启动诊断通过，原失败仍待原生 CI 定论 | `linux-runtime-all-postgres-final.log`、`linux-runtime-finance-diagnostic.log`、`linux-runtime-finance-startup-diagnostic.jsonl` |
| Linux 验证输入完整性 | 容器与主机 388 个文件摘要一致 | `linux-runtime-source-integrity.json`、`linux-runtime/source-manifest-final.json` |
| Linux 原生资源探针 | 25 次解码、10 次有界拒绝，含 16 位 RGBA；内存峰值低于 1 GiB；零缓存/队列断言通过 | `linux-runtime-resource-probe-16bit.json` |
| Swift 捕获/材料定向 | 27 通过，0 失败 | `transport-limit-swift-targeted.log` |
| Node 输入/传输定向 | 20 通过，0 失败 | `transport-limit-node-targeted.log` |
| 签名 QA | 2.12 / 19、arm64、最低 macOS 14.0，Developer ID hardened runtime 与 strict codesign 通过 | `artifact-manifest-linux-transport.json`、`package-qa-linux-transport.log` |
| 实际平台只读核验 | 项目 Node 24.x；团队 Hobby；现有 production deployment READY，未创建新 deployment | `linux-runtime-vercel-project.json`、`linux-runtime-vercel-team.json`、`linux-runtime-vercel-existing-deployment.json` |
| 原生 UI | 桌面仍锁定，未启动候选 App，未通过交互验收 | `linux-transport-desktop-status.json` |

当前 QA 可执行文件 SHA-256 为 `9d2078d201ccf5150e2c404d9ea545184800bbcfc574629f16dd381aa0d8ba85`；上一完整签名包已按摘要归档于 `qa-before-linux-transport/NotchSPI.app`。两项 Swift 跳过仍是显式模型评测；仓库没有独立 ESLint。本轮没有真实模型/付款/退款、生产数据库、公证、正式 DMG、提交、push 或部署；评测预算无新支出。已确认 Hobby 不支持当前每分钟 cron，生产管线停在调度选择与既有质量闸门之前。

## 原生 CI 与验证快照周期（2026-09-07）

验证快照已在独立 worktree 提交并推送至 `codex/product-update-2-12`，commit 为 `90e368ec54e7ba6e310289f6caf2c2666cd32715`。保留原主工作区；该快照承接此前全部候选实现和本轮传输/WAL 修复。最终发布提交与生产分发仍受蓝图闸门约束。

[GitHub Actions 34068252074](https://github.com/RotteSya/notch-SPI/actions/runs/34068252074) 的 8 个任务全部通过，已下载实际 TAP、原生资源 JSON、运行元数据和完整日志至 `.release-evidence/2026-09-06/native-ci-90e368e/`：

| 原生 CI 配置 | 实际结果 |
|---|---|
| Node 22.18.0 / 24.20.0，各自完整 Node 回归 | 每组 507 通过，0 失败、0 跳过；strict TypeScript、隔离 smoke 与 npm audit 均通过，audit 报告 0 漏洞 |
| Node 22.18.0 / 24.20.0 × PostgreSQL 16 / 17 | 四组各 627 通过，0 失败、0 跳过；均包含此前模拟器整文件退出的全部财务用例 |
| macOS 15 / Swift 6.1.2 | 273 项执行、2 项显式模型评测跳过、0 失败；串行 warnings-as-errors 和 arm64 Release 构建通过 |
| Node 24.20.0 / AL2023 / glibc 2.34，独立 1 GiB 容器 | 25 次 16MP 解码、10 次并发拒绝，含 16 位 RGBA；峰值 RSS 419.34 MiB / cgroup 355.47 MiB；缓存条目、原生运行和等待队列均为零 |

AL2023 job 先在目标镜像中按 lockfile 安装 optional 依赖，再在全新的、禁用网络且只读挂载代码的 1 GiB 容器运行资源探针。采样耗时仍只作为隔离资源诊断，不作为生产端点 SLA。QEMU 的一次整文件退出原因仍未确认，首轮、第二轮及独立诊断日志保留；发布平台的软件判断采用上述完整原生矩阵。

验证分支的 Vercel Git 自动部署已通过 `git.deploymentEnabled` 明确关闭；推送后只读复查，生产仍为原 deployment `dpl_BStwrGFdwhRC7FP3g2m6snSpcgfC` / READY。[Vercel 分支配置语义](https://vercel.com/docs/project-configuration/git-configuration)。没有向 CI 提供生产凭证、执行生产迁移、付款、真实模型调用或公证分发。两个临时 Linux 容器及内部网络已删除，QEMU VM 已停止；原主工作区继续保留。

本周期已创建并推送一个验证提交；版本仍为未发布的 2.12 / 19。原生 CI 验证不替代真实 UI、授权质量集、Stripe/实际资金核验、Hobby 分钟调度决策、生产备份恢复、Vercel 实际构建与灰度观察。CI 与资源完整摘要见 `native-ci-validation.json`，最新签名 QA 与源码归档见 `artifact-manifest-native-ci.json`。

## 完整蓝图尚待完成的工作

| 范围 | 实际差距与下一步 |
|---|---|
| B02/B17/B22 场景与质量 | 质量录入/归档、旧 240 题转换及新阅读完整执行/评分/解释独立复核工具链已实现。缺阅读练习授权 holdout、独立标注/复核、准确隔离候选与新 prompt/profile 的真实模型结果；support catalog 仍无公开支持组合。必须完成当前候选旧基线比较、新范围及至少 80 个解释样本的质量评测 |
| B18 完整支付与退款 | 订单/退款状态机、lot 冻结/撤回、部分退款审核、持久化重试、购买会话恢复、异常 Checkout 审核及财务资源发现/漏记退款修复已实现并通过三存储测试。仍需恢复 Stripe 连接，核验真实 API 版本、Checkout read/write 与 Charges/Refunds/Disputes/Balance Transactions 读取权限、Webhook 订阅、生产迁移与真实对账 |
| B19 遥测与观察覆盖 | 同意版本、原子队列、序列回执、device_observation、关闭后仅同步偏好、严格 usable solve 及 B21 自报来源已贯通并通过测试。待 B23 真实交互和旧事件版本覆盖验收、实际观察窗口；不能提前宣称完整观察 |
| B20 cohort/economics | 查询核心、四种运营视图、聚合快照、独立质量记录、未分配签名收款及订单费用/争议资源核对已实现。仍需真实资金准确性、账户未关联费用/服务支出覆盖与汇率证据；真实新范围质量随 B22，实际窗口冻结随 B26 执行，不能以本地合成测试充当 cohort、正确率或利润证据 |
| B21 入口与反馈 | 可跳过来源选择、SPI/阅读入口、三语 fixed30/收费/支持范围、预览授权导出及离线审核/撤回/清理工具已实现。待真实客户端屏幕/语言/可访问性验收；正式征集前须配置实际受控收件、授权成员、邮箱/备份清理与每日任务并完成演练；外部模型使用仍须另行授权 |
| B23 全量验收 | 新合约输入、Swift SSE/OfficialAPI.run 真实 HTTP、三存储准入/取消/预算/回执丢失、官方账户同步存储、Keychain/全局镜像竞态、account/quota 与累计去重、父请求账号和材料 scope、恢复答案解释的原收费名额已验证。旧 schema 升级、停流/检查点/重验和兼容 Store 回退已在双数据库演练；原生 Node 22/24、Postgres 16/17、AL2023 1 GiB 资源及 macOS 编译/单测矩阵已通过。仍需补查/恢复/解释真实 UI 联动、生产迁移/备份恢复与旧实例退出、Vercel 实际部署验收及全部屏幕/语言/可访问性验收；不能宣称 AC01–AC14 全部通过 |
| B24 发布 | 服务端先行；核验正式配置、持久数据库迁移、模型价格上界、入口 body limit、独立恢复日志、回滚；其后公证/staple/DMG及最终提交与分发 |
| B25/B26 | 内部→5%→25%→100%，每档至少 72h 和 200 treatment captures，并满足质量/成本闸门；28d 窗口＋7d 晚到冻结尚未开始，不可用软件测试代替 |

## 外部阻断与方案

1. **真实模型评测条件缺失**：preflight 无 `reading_candidates`；隔离官方设备 token、候选部署核验与价格/上界证明缺失。厂商 key 可保留在候选服务，本机文件仍为脱敏占位。已请求授权题集的本地路径与通过环境提供的凭证。继续独立工程；新范围开关保持关闭。既有题库不能改名充当新 holdout。
2. **原生界面条件**：本轮 Computer Use 只读查询仍返回桌面锁定、工具无法解锁；此前已请求用户手动解锁。本轮没有追加解锁操作、没有启动候选 App；点击、语言与辅助功能验收须待桌面可用后继续。
3. **生产调度已确认阻断部署**：2026-09-07 通过 Vercel 只读连接器核验 notchspi-api 的 Node 为 24.x，所属团队实际套餐为 Hobby。Hobby 仅支持每天一次；当前 `* * * * *` cron 会被平台拒绝部署。已异步请求选择已有外部分钟调度服务，或授权升级 Pro（当前基础费用 $20/月，税与超额用量另计）。现有 100 CNY 授权仅用于评测；没有自动购买、升级或删除 cron。方案确定后还须核验鉴权、真实分钟触发与恢复日志。证据为 `linux-runtime-vercel-project.json`、`linux-runtime-vercel-team.json`。[官方频率限制](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Pro 定价](https://vercel.com/docs/plans/pro-plan)
4. **最终放量证据**：独立复核、真实灰度样本及观察时间必须实际发生。用户授权自主发布不代表豁免这些已批准闸门。
5. **Stripe 连接失效**：此前连接器返回 `oauth_token_invalid_grant`，已通过异步问题请求重新连接。本 Linux 周期再次只读列举可用账户，仍返回必须重新认证，证据为 `linux-transport-stripe-availability.json`。恢复后先读取并核验版本、权限和真实资源，再执行已授权且通过技术门槛的发布操作；当前没有真实账户核验结果。

下一工程项为实际部署打包检查。获得桌面与数据条件后开展真实客户端 UI、隔离模型评测及财务核验；正式收件需先落实上述操作条件。没有要求用户提供架构或编程方案。
