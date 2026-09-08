# 2026-09-08 发布进度

**2.12 / build 19 已完成正式签名、公证及 DMG 装订，尚未公开发布。** 用户已批准 Cloudflare 免费定时器、首周 CNY 20/日模型预算及 Mac 实机测试；Apple 公证凭证已验证，Stripe 正式通知配置已补齐。现有生产服务仍为旧版，未执行生产数据库迁移或切换用户流量。

## 已实施与外部配置

- `scheduler/` 是独立 Cloudflare Worker。一个 tick 只调用一次固定 Vercel 恢复接口；45 秒截止、禁止重定向、最多读取 4 KiB、严格核验返回计数，部分失败会让任务失败。HTTP 外部访问不能触发恢复，日志不含凭证或业务正文。当前 Worker `notchspi-reaper` 部署 ID 为 `082c40757f7f424ea498c4d247e73b8c`，公开/预览 URL 关闭，定时触发列表为空。新服务和迁移验收后才启用每分钟调度。未购买 Cloudflare 付费套餐。
- 两端的 `CRON_SECRET` 已设置。Vercel 生产环境已写入并回读核对 9 项预算/价格设置，见 `deploy/production-model-budget.json`。每日限额为 CNY 20,000,000 micros，上海时间零点重置；所有官方查题、解释和恢复共用持久账本。实际生效需要新版服务部署，不代表旧版本已受到新上限限制。
- 价格表补齐 Claude Opus 4.8 与 DeepSeek vision；按 8 CNY/USD 的保守估值和 DeepSeek 高峰未命中价格核算。历史 USD 记录不改币种。单次暂留 CNY 10，已知用量结算后释放差额；未知费用保留上界，临近每日上限可能提前拒收新调用。首周观察不自动涨额度。模型预算不是固定扣费，也不包含服务器费用。价格来源、上界推导及启用条件见 `docs/cloudflare-scheduler.md`。
- Mac 实测发现首次引导自绘按钮/语言选择缺失辅助功能语义。现已添加可读名称、按钮/单选角色、选择状态、可执行操作、键盘处理及焦点描边；禁用、隐藏、纯确认状态不触发操作。免费额度数字也可被辅助功能读取，并移除 30 前面的填充零。三语文案修正了绝对隐身及“截图用完即删”的不准确承诺。

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

当前正式候选：`dist/NotchSPI.dmg`，SHA-256 `9fbff1929096ae0468dd4a4af9dab79ff94895b328b2d4f79f9965f4674afa61`。只读挂载后重新核验 App 的签名、版本、最低系统、4 个文件摘要和 Gatekeeper；59 个客户端输入已登记。原 `dist` 的 5 个文件已保存到私有证据目录并逐项记录摘要。此包未上传 GitHub Release、未发布更新通知。

## 仍未放行的生产条件

1. **真实质量材料**：新增范围仍缺蓝图规定的 400 道授权留出题、80 份独立解释复核，以及同候选 240 题基线比较。代码测试和本机 mock 注册不能代替它们。
2. **生产数据升级**：需完成生产备份恢复、旧写入实例排空、额度迁移和兼容回退证明；敏感数据库连接无法通过现有只读配置结果取得，尚未操作生产数据库。
3. **支付运行验收**：notchSPI 的 live endpoint `we_1TslR1DLfLoLVRGJXChtUW6u` 已在后台补齐 13 项所需事件，并以 Stripe GET 回读确认；URL、API 版本及原签名密钥未变。此配置缺口已消除，证据为 `stripe-webhook-configuration.json`。实际生产受限密钥的结算/退款读取权限及新版端到端对账仍需验证；本轮未创建真实付款或退款。
4. **最终 UI 与平台验收**：首次引导只是已验证部分。完整键盘/VoiceOver、外接屏/无刘海设备、长答案以及题组、框选、解释、恢复的真实交互仍需验收；DEBUG 可截图测试包不等同于生产签名包运行验收。
5. **生产运行证据**：恢复接口与调度实测、正式反馈收件/删除演练、分档至少 72 小时和样本数门槛、28 天及迟到数据窗口仍需实际积累。不得用本机测试或公证通过替代。

本轮新配置和候选安装包已经可复核；公开发布仍按上述条件暂停。未重新索取用户已经给出的费用、部署或测试授权。
