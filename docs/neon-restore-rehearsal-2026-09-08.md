# Neon 生产数据副本恢复与迁移演练（2026-09-08）

本轮使用 Vercel 已有授权进入 Neon。生产连接配置 `POSTGRES_URL` 和 `DATABASE_URL` 的 `contentHint.storeId` 均为 `store_8gOqqnXO3I4mJiU4`，对应资源 `neon-rose-lens`、项目 `curly-lab-12614267`。评测资源 `notchspi-objective-eval` 是另一资源，未用于本次恢复。Neon 当前为 Free，控制台显示 6 小时历史窗口。

## 已完成的备份与恢复

- 在 `main`（`br-bold-heart-atsce3zq`）创建手动快照：`main at 2026-09-08 15:06:40 UTC (manual)`，不自动过期。现有免费手动快照名额已占用，没有购买或修改套餐。
- 采用 Multi-step restore，将快照恢复到独立分支 `br-royal-band-at5sp31r`。控制台明确显示原 main 不变；未执行 Migrate connections and settings，未切换生产 URL。恢复分支使用 `ep-dry-voice-atbiwd7s`。
- 在恢复分支以 `REPEATABLE READ READ ONLY` 核验数据：44 个设备账户、4 条充值、1,105 条用量、1 条计数器，product_events 为 0。报告只保存计数与摘要，不输出设备行、令牌摘要、支付引用或凭证。
- 使用 PostgreSQL 17.11 工具从恢复分支生成 custom-format dump，52,644 字节，SHA-256 `1b8748f9eb4a2ce88d8b701ea4f0b29ee24ce87a648505c38f03e36b4a6f8c8c`。文件保存在忽略目录的 private 子目录，权限 0600。TLS 验证使用系统信任根，不降低证书校验。
- 在同一隔离分支新建 `notchspi_restore_verify_20260908` 数据库，以单事务、遇错退出模式恢复 dump。5 张原始表的全部原有字段、行数和按主键排序的 SHA-256 与恢复来源逐项一致。

## 迁移验证边界

迁移已在隔离验证库完成，10 次独立 CLI 进程全部 exit 0：pause → 5 台首批 → 重新打开 status → 10/10/10/9 台分批 → 全量 validate → resume → 最终 status。44/44 检查点已验证，未验证、held capture、running attempt 均为 0，最终状态 active / revision 2。执行与重验累计约 751 秒，含本机到美国区域的网络往返，不作为生产请求延迟指标。

迁移后再次在只读一致性事务中核验 5 张原始表：原有字段、行数与逐行摘要全部保持一致。设备凭证、余额、累计用量、充值与历史使用记录未被改写或补发。

迁移工具及 60 个服务端源文件与云端已通过的 `81f69b0b6d41cd0ffcb622f42a4bbc1353a1c8c4` 完全一致；关联的实际 Vercel 函数包 SHA-256 为 `4a70b03540d5b0349b5f9951aba57c4d7578a5767de186411b0b3d519db36d1d`。最终结果记录于 `.release-evidence/2026-09-08/neon-migration-rehearsal.json` 和 `neon-history-after-migration.json`。

这次快照发生在生产继续运行期间，用于验证恢复与迁移能力。它不是正式切换时的停流备份。公开部署仍需排空旧写入实例、核验真实连接角色与凭证隔离、生成切换时备份、支付核对和灰度准入；不得把副本演练视为生产迁移已完成。独立分支与本地备份包含生产数据，应按发布保留策略管理，不能提交 Git 或用作模型评测输入。

## 迁移后的实际存储检查

在历史摘要核验之后，仅在隔离验证库追加一个标记为 `release-restore-probe` 的合成测试账户：首次余额为 30；三个并发重复结算只扣一次，余额为 29、累计查题为 1；1ms 租约自然过期后恢复任务只释放一次，第二次执行为 0，最终 held 为 0。全过程没有模型调用、付款或退款。结果见 `neon-post-migration-probe.json`。本节检查属于托管 PostgreSQL 上的存储行为验证，不等同于生产 HTTP、Stripe 或 Cloudflare 定时触发验收。

补测后再次核验原始历史摘要，5 张表仍全部一致。合成账户新增一条扣 1 题记录和一条扣 0 题的过期释放记录；恢复操作保留零扣费流水。初次核验脚本只预期一条新增流水，因此失败；按存储实现核对这两条记录均属于合成账户后，修正该测试期望并复验通过，没有修改服务端行为。最终证据为 `neon-history-after-probe.json`。

## 证据

所有原始证据在 `.release-evidence/2026-09-08/`：`database-env-metadata.json`、`neon-resource-inspection.json`、`neon-backup-restore-metadata.json`、`neon-restored-baseline.json`、`neon-restored-table-hashes.json`、`neon-snapshot-dump.json`、`neon-pg-restore.json`、`neon-history-before-migration.json`、`migration-source-match.json`。生产健康探针在演练期间返回 200，见 `production-health-during-restore.json`。
