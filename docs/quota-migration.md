# 额度账本迁移与兼容回退

适用：2.12 / 19 候选，检查点 migration_version=1。本地 SQLite/Postgres 演练使用 Git 基线 `7ba96db7408b8e203adfb133947535a604806fb0` 的旧表定义与隔离测试记录，尚未执行生产迁移。

2026-09-08 已完成 Neon 正式数据快照的独立分支恢复与额度迁移演练，44 个历史账户和全部原有表字段保持一致。它补足了真实数据规模下的恢复证据，正式切换闸门仍保留，详见 [Neon 恢复演练](neon-restore-rehearsal-2026-09-08.md)。

## 切换前提

先在入口暂停收费流量并排空旧实例的在途模型请求，再把所有写入实例换成支持当前 ledger、支付/财务队列和迁移锁的兼容服务。核验旧 deployment URL、定时任务、管理工具和数据库凭证都不能继续写入；仅更换主域名不足以证明旧实例退出。旧版本在途请求没有 capture_requests 记录，新表的 held=0 不能代替旧实例排空证据。

入口仍停流时，保存数据库备份并验证能恢复到独立数据库；记录真实部署构建 SHA-256、实例清单、版本/开关、连接角色和时间。兼容版本关闭未放行的新题型、解释及自动模式，保留 fixed30、旧 HTTP 契约、统一额度写入和分钟恢复任务。工具接收的兼容构建摘要只是不可变审计关联，不能凭字符串证明实例已部署。生产证据未核验前，不执行生产迁移或恢复入口流量。

## 事务实现

- SQLite 整批 schema 扩展使用 BEGIN IMMEDIATE，失败回滚并关闭连接；busy timeout 在扩展前设置。Postgres 在同一事务中持有按 schema 区分的 advisory lock，串行处理冷启动 DDL，失败允许完整重试。所有旧字段保留。
- quota_migration_control 持久化 active/paused、修订和兼容构建摘要。Postgres 兼容写事务在设备锁之前取得控制行共享锁，pause/resume 取得排他锁；SQLite 使用同一写事务顺序。报表先设置 REPEATABLE READ READ ONLY，由数据库禁止写入，无须准入锁。
- paused 时，新 solve、解释和恢复均不建立 capture；HTTP 返回 `503 service_maintenance` 与 `Retry-After: 60`。已有请求的结算、释放、status 和恢复继续，注册/充值仍走账本。held capture 或 running attempt 非零时，backfill/resume 拒绝执行。客户端不因此自动重发原请求。
- 首个旧余额建立 legacy_unknown / opening_balance lot；不推算历史 trial/paid 消耗比例。lot、grant ledger 和检查点同事务提交，0 余额也有检查点。原 balance、token hash、时间、累计用量、CLI 和历史支付不重算；旧注册不补发 30。新注册的 trial lot 和检查点同事务提交。
- 检查点保存当时的设备快照，以及历史 topups/usage 的最大 ID、条数和逐行 SHA-256。扫描按 500 行分页；以后追加记录不改旧检查点。历史行被删改或移动归属时，重新校验拒绝恢复。快照和摘要留在受控数据库，CLI 只输出计数与状态。
- backfill 每批 1–500 台，同序锁定设备，核对每个 lot 的可用量、held、reservation 和 ledger，再核对余额与历史摘要。一个设备出错则整批回滚，已提交前批可跨进程继续。validated balance version 必须匹配当前版本，期间充值/结算使旧验证失效。每次新 pause 和 CLI validate/resume 均要求重新验证。
- resume 以 paused 修订阻止过期操作，取得排他锁后复查全部设备及在途状态，事务内写 active 和不可变审计事件。不会重新计算余额或发放额度。

## 操作接口

入口为 [`scripts/migrate-quota.mjs`](../scripts/migrate-quota.mjs)。只接受显式目的地：`--sqlite` 指向已存在文件，或 `--postgres` 读取 `NSPI_MIGRATION_DATABASE_URL`。不读取 .env，不使用应用默认数据库。**所有命令都会初始化/检查兼容 schema，含 DDL；status 不是只读生产探针。** 数据库凭证不得放进命令行参数或日志。

| 命令 | 参数与结果 |
|---|---|
| status | 输出状态、修订、兼容构建摘要、设备/检查点/待验证/held/running 数量 |
| pause | 必需 --release，使用已核验兼容构建 SHA-256；相同 pause 幂等，不能用另一摘要重绑在途迁移 |
| batch | --batch-size 默认 100；处理一批并输出剩余状态，支持中断后继续 |
| validate | 清除验证标记并逐批核对全部设备；异常保持 paused；最多 10000 批后停止 |
| resume | 必需 --revision，取当前 paused 修订；先完整重核再恢复。并发入账再次使验证失效时保持 paused |

生产顺序：满足切换前提 → pause → 等待兼容请求排空 → batch → validate → 校对备份/已购记录/审计 → resume → 恢复入口 → 核验旧客户端、余额/status 和分钟恢复任务。schema 扩展完成或单次 exit 0 不代表生产迁移完成。

余额与 lot/ledger 不同表示存在越过账本的写入或损坏；历史摘要不同表示检查点前记录变化；held/running 非零表示未排空。保持 paused，保存修订与数据库备份，定位来源后处理。工具不会覆盖旧余额、删除历史或重新发 trial。数据库异常日志不输出 SQL 参数、凭证或设备记录。

## 回退边界

只能使用已核验支持当前 schema、账本、队列及迁移锁的兼容服务构建，或关闭新功能开关。**禁止用基线 7ba96db 二进制回写新库**：它直接修改 devices.balance_questions，不读暂停状态，也不更新 lot。隔离演练证明后续校验会发现该写入；校验不是阻止旧二进制写数据库的权限机制。

回退保留 fixed30、新 lot/ledger、检查点、支付/财务记录、请求身份和恢复任务。不得用旧备份覆盖已恢复写入的新库，丢失新充值/结算。灾难恢复须再次停流，核对备份之后的资金与额度事实，再接回经验证的恢复库。

本地已覆盖 schema 升级、断批回滚、重复进程、兼容 Store 写入及旧 HTTP 停流。生产备份恢复、旧实例退出、真实数据库规模/锁耗时、支付核对、部署配置和真实灰度仍是发布闸门。
