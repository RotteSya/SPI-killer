# 2026-09-08 发布进度

**2.12 / build 19 已完成正式签名、公证及 DMG 装订，尚未公开发布。** 用户已批准 Cloudflare 免费定时器、首周 CNY 20/日模型预算及 Mac 实机测试；Apple 公证凭证已验证，Stripe 正式通知配置已补齐。现有生产服务仍为旧版，未执行生产数据库迁移或切换用户流量。

## 已实施与外部配置

- `scheduler/` 是独立 Cloudflare Worker。一个 tick 只调用一次固定 Vercel 恢复接口；45 秒截止、禁止重定向、最多读取 4 KiB、严格核验返回计数，部分失败会让任务失败。HTTP 外部访问不能触发恢复，日志不含凭证或业务正文。当前 Worker `notchspi-reaper` 部署 ID 为 `082c40757f7f424ea498c4d247e73b8c`，公开/预览 URL 关闭，定时触发列表为空。新服务和迁移验收后才启用每分钟调度。已在账户后台确认当前方案为 Free / $0，未购买付费套餐，见 `cloudflare-free-plan.json`。
- 两端的 `CRON_SECRET` 已设置。Vercel 生产环境已写入并回读核对 9 项预算/价格设置，见 `deploy/production-model-budget.json`。每日限额为 CNY 20,000,000 micros，上海时间零点重置；所有官方查题、解释和恢复共用持久账本。实际生效需要新版服务部署，不代表旧版本已受到新上限限制。
- 价格表补齐 Claude Opus 4.8 与 DeepSeek vision；按 8 CNY/USD 的保守估值和 DeepSeek 高峰未命中价格核算。历史 USD 记录不改币种。单次暂留 CNY 10，已知用量结算后释放差额；未知费用保留上界，临近每日上限可能提前拒收新调用。首周观察不自动涨额度。已建立本任务每日费用复查 `notchspi`，只在实际启用后计算七天；未上线或状态不变时保持安静，七天报告后暂停。模型预算不是固定扣费，也不包含服务器费用。价格来源、上界推导及启用条件见 `docs/cloudflare-scheduler.md`。
- Mac 实测发现首次引导自绘按钮/语言选择缺失辅助功能语义。现已添加可读名称、按钮/单选角色、选择状态、可执行操作、键盘处理及焦点描边；禁用、隐藏、纯确认状态不触发操作。免费额度数字也可被辅助功能读取，并移除 30 前面的填充零。三语文案修正了绝对隐身及“截图用完即删”的不准确承诺。

- 已补齐持久 `REQUEST_HMAC_KEYS_JSON`（256-bit / v1）、固定 30 题三项兼容配置及持久存储要求；8 项非密钥设置逐项回读匹配，签名密钥存在性与本地 keyring/注册重试一致性校验通过。未验收的 screen_query 和 explanation 明确为 0。现网仍使用旧部署环境快照。
- 已通过现有 Vercel/Neon 授权完成正式数据库资源的手动快照、独立分支恢复、pg_dump/pg_restore 及副本额度迁移。44 账户、4 条充值和 1,105 条用量的原始字段与摘要全部保持一致。详情见 [Neon 恢复演练](neon-restore-rehearsal-2026-09-08.md)。

## 验证

证据目录：`.release-evidence/2026-09-08/`。

| 检查 | 结果 | 日志 |
|---|---|---|
| 服务端完整 Node 测试 | 509 通过，0 失败，0 跳过 | `server-full-tests.log` |
| 持久预算专项 | 33 通过；包含四账户 25 并发预约、CNY 20 上限及上海午夜边界 | `budget-tests.log` |
| Swift 完整测试 | 276 执行，2 个明确模型评测跳过，0 失败；warnings-as-errors | `swift-full-tests-final.log` |
| 服务端 strict TypeScript | 通过 | `server-typecheck-final.log` |
| Worker 测试 | 14 通过，含真实 workerd scheduled 事件；不调用生产 | `scheduler-tests.log` |
| Worker 类型/打包/依赖 | Wrangler types、tsc、dry run 通过；npm audit 0 漏洞 | `scheduler-typecheck.log`、`scheduler-build.log`、`scheduler-audit.json` |
| App 首次引导 | 实际三语切换、屏幕权限状态、本机隔离服务注册并领取 30 题、跳过来源及完成引导 | `native-ui-validation.json`、`ui/registered-trial-final.png` |
| 发布安装包 | arm64 Release、Developer ID + hardened runtime、strict codesign、公证 Accepted、stapler 与 Gatekeeper 通过 | `release-package-notary.log`、`notarized-artifact-manifest.json` |
| 仓库健康/空白 | 通过 | 本轮执行输出 |

Worker 运行时测试最初失败：Cloudflare 不接受 Fetch 的 `redirect: error`，虽然 Node 测试接受。改为 `manual` 并拒绝所有非 200 状态后，workerd 复验通过。初次追加 esbuild 版本的低风险开发服务器问题也已通过升级到 0.28.2 消除。

代码提交 `81f69b0b6d41cd0ffcb622f42a4bbc1353a1c8c4` 的 [GitHub CI 34241607923](https://github.com/RotteSya/notch-SPI/actions/runs/34241607923) 已 10/10 成功：Node 22.18/24.20、Postgres 16/17 四组合、macOS 15、AL2023 1 GiB 原生资源、实际 Vercel Linux 函数包及 Cloudflare 调度。两个 Node 组合各 509 通过，四个 PostgreSQL 组合各 630 通过，均无失败或跳过。完整 CI 日志、测试 TAP 与函数包已下载保存；551 个函数文件摘要逐项一致，静态目录仅 robots.txt。公证包的 59 个客户端输入摘要与该提交全部一致。

前一轮正式候选（现已保存到 `pre-settings-dist`）：SHA-256 `9fbff1929096ae0468dd4a4af9dab79ff94895b328b2d4f79f9965f4674afa61`。只读挂载后重新核验 App 的签名、版本、最低系统、4 个文件摘要和 Gatekeeper；59 个客户端输入已登记。原 `dist` 的 5 个文件已保存到私有证据目录并逐项记录摘要。此包未上传 GitHub Release、未发布更新通知。

## 设置与材料实机复验（本轮最新）

设置侧栏六个分类和五个主题色现有完整辅助功能角色、名称、选择状态、键盘操作与焦点描边；侧栏支持上下方向键。账户余额圆环可读出“尚未获取”或实际剩余题数。两个真实窗口集成测试验证分类切换、焦点及主题偏好更新。实际 QA App 已验证侧栏方向键、Tab/空格切页和切换主题；本机注册后辅助功能读出“30 题可用”。

本轮 Swift warnings-as-errors 完整运行 278 项、0 失败；最初跳过 3 项，其中隔离凭证测试随后以 `NSPI_QA_EPHEMERAL=1` 单独运行通过，剩余 2 项需要真实模型评测。候选提交 `e28cda3fd48ad6cbf2cfae6623adcb409594d900` 的 [CI 34247512780](https://github.com/RotteSya/notch-SPI/actions/runs/34247512780) 已 10/10 成功，完整日志保存在 `ui/ci-full.log`。

通过刘海菜单真实保存了一张本机材料，界面出现材料缩略图和删除入口。框选按钮操作与随后的状态读取遇到 Computer Use 超时，未完成区域选择及取消验收；两秒进程采样显示主事件循环正常处理，不能据此认定应用死锁，也不能记为框选通过。材料删除/清空、完整 VoiceOver、其他显示设备及生产完整交互仍待验收。隔离 QA App 和 localhost 服务已停止；此次没有真实模型或支付调用。证据为 `ui/settings-and-material-validation.json`、`ui/settings-theme-keyboard.png` 和 `ui/settings-quota-readable.png`。

**当前候选**仍为 2.12 / build 19：`dist/NotchSPI.dmg`，3,310,068 字节，SHA-256 `1f6ce5824a83d1b3b16fa008c89064c79b72bfae08521e03cc752922bf36436f`。已重新 Release 编译、Developer ID 签名、公证 Accepted（提交 `d79e49a0-2334-45f5-aa92-20d5b7bc0a3c`）、装订；只读挂载后 strict codesign 与 Gatekeeper 均通过。59 个客户端输入摘要逐项匹配上述候选提交，见 `ui/notarized-artifact-manifest.json`，打包日志为 `ui/release-package.log`。未上传公开 Release 或切换生产。

## 仍未放行的生产条件

1. **真实质量材料**：新增范围仍缺蓝图规定的 400 道授权留出题、80 份独立解释复核，以及同候选 240 题基线比较。代码测试和本机 mock 注册不能代替它们。
2. **正式数据切换**：已有授权支持 Neon 数据库操作，快照恢复与完整额度迁移已在隔离副本通过。正式切换仍需排空旧写入实例、核验连接角色与凭证隔离、取得停流后的最新备份，再执行生产迁移与兼容回退验证；尚未改写生产库或切换连接。
3. **支付运行验收**：notchSPI 的 live endpoint `we_1TslR1DLfLoLVRGJXChtUW6u` 已在后台补齐 13 项所需事件，并以 Stripe GET 回读确认；URL、API 版本及原签名密钥未变。此配置缺口已消除，证据为 `stripe-webhook-configuration.json`。实际生产受限密钥的结算/退款读取权限及新版端到端对账仍需验证；本轮未创建真实付款或退款。
4. **最终 UI 与平台验收**：首次引导只是已验证部分。完整键盘/VoiceOver、外接屏/无刘海设备、长答案以及题组、框选、解释、恢复的真实交互仍需验收；DEBUG 可截图测试包不等同于生产签名包运行验收。
5. **生产运行证据**：恢复接口与调度实测、正式反馈收件/删除演练、分档至少 72 小时和样本数门槛、28 天及迟到数据窗口仍需实际积累。不得用本机测试或公证通过替代。

本轮新配置和候选安装包已经可复核；公开发布仍按上述条件暂停。未重新索取用户已经给出的费用、部署或测试授权。
