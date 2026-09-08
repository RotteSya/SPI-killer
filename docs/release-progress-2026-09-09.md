# 2026-09-09 发布进度

本轮完成框选窗口的键盘操作、比例与坐标修复，客户端与测试提交为 `7dfed7bd039e413415ebb050ab71dcc2b6bc9117`，随后打包脚本提交为 `1a2c140`。**尚未公开发布，生产服务及数据库未切换。**

## 实施与验证

- 框选窗口打开后明确聚焦选区。方向键移动、Shift＋方向键调整大小、回车确认、Esc 或关闭取消；无选区时不会隐式提交整屏。提供原生确认/取消按钮、可读选区百分比和键盘焦点描边。
- 截图按原比例适配，窄长图的留白不参与归一化坐标。鼠标松开使用最终位置，拖动起点必须位于图像内。选区保持图像边界内，窗口应用现有截图保护策略。
- 五个窗口测试覆盖初始 Esc、一次性取消回调、键盘坐标/缩放、边界、留白和最终鼠标位置。完整 Swift warnings-as-errors 执行 283 项、0 失败；2 项真实模型评测仍按显式门槛跳过。
- 实际 QA App 打开生产 `QuestionRegionPicker`，验证初始焦点、方向键与 Shift 调整、回车、立即 Esc 和鼠标拖动。键盘回调为 `(0.26,0.25,0.5,0.51)`，鼠标回调也已记录。使用仓库标明的合成 UI fixture，不把它算入授权留出题或模型质量指标。DEBUG 本地图片入口在 Release 中排除。
- [CI 34249157818](https://github.com/RotteSya/notch-SPI/actions/runs/34249157818) 已 10/10 成功。初次 CI 34248834178 在边界测试把 `0.9999999999999999` 与 `1` 做精确比较而失败；修正为百万分之一容差，同时保留严格 `region.isValid` 检查后通过，未为测试更改运行逻辑。
- 59 个客户端输入摘要与候选提交全部匹配，见 `candidate-source-match.json`。
- 打包脚本提交后的 CI 34249981706：所有代码测试通过，但两个 PostgreSQL / Node 22 任务在上传测试日志 artifact 的 FinalizeArtifact 阶段收到 HTTP 403。两者各 630 通过、0 失败；仅重跑失败任务后，[CI 34249981706](https://github.com/RotteSya/notch-SPI/actions/runs/34249981706) 已 10/10 成功，未把上传失败改成忽略。最终状态和完整日志为 `ci-package-final.json` / `ci-package-final.log`。失败原始日志为 `ci-package-failed.log`。

## 安装包流水线

2.12 / build 19 已重新 Release 编译、Developer ID hardened runtime 签名并通过 strict codesign。首次公证进程停在 `xar_open_digest_verify → open`；`hdiutil info` 和 `lsof` 确认本次 DMG 仍被一个可写磁盘映像实例占用。卸载仅该映像后，原进程以格式校验失败（exit 64）结束。校验和本身有效，故不能断言磁盘损坏或 Apple 服务故障。

打包脚本改为显式 HFS+ / UDZO，并在签名前执行 `hdiutil verify`。重新生成后的完整性、签名和公证格式检查通过，已上传 Apple，提交编号 `9c29c37f-e49a-4e95-872a-5b5b7ae25fae`；Apple 已返回 Accepted，装订与校验通过。没有使用 `--force` 跳过验证。执行会话 `20066` 已完成，日志为 `ui/release-package.log`。原失败日志 `release-package-first.log`、原映像 `rejected-apfs.dmg` 和进程采样均保留。

**最新候选**为 `dist/NotchSPI.dmg`，3,996,192 字节，SHA-256 `4323d5177b78ff611f251591b26f501559d31a86bf6011f1a4f24de54c3c7a08`。只读挂载后 App strict codesign、Gatekeeper 和 DMG stapler 均通过；59 个客户端/打包输入摘要与 `1a2c1401955b35c4263b390fab5576ce483a02a7` 一致，见 `notarized-artifact-manifest.json`。未公开发布。

上一轮已公证且核验通过的安装包保存在 `.release-evidence/2026-09-09/pre-region-dist/NotchSPI.dmg`，SHA-256 `1f6ce5824a83d1b3b16fa008c89064c79b72bfae08521e03cc752922bf36436f`；它不包含本轮框选修复。

## 未完成验收与外部条件

完整捕获→框选→请求流程尚未通过本轮实机验收。保存材料后的 Computer Use 状态读取重复超时，最后一次 Node 运行时重置；材料删除和清空不能记为通过。测试 App 与 localhost mock 服务已停止，没有真实模型或支付调用。完整 VoiceOver 语音、其他显示器/设备仍待验证。

400 道新增授权留出题、80 份独立解释复核、同候选 240 题基线、正式旧写入隔离及数据切换、支付端到端对账、生产恢复调度、反馈删除演练和分档观察门槛仍未完成，详情继承 [9 月 8 日发布记录](release-progress-2026-09-08.md)。生产新能力保持关闭，Cloudflare 定时触发仍暂停；CNY 20/日模型预算待新版生产部署后才生效。

证据目录：`.release-evidence/2026-09-09/ui/`。包括 `region-validation.json`、`region-keyboard.png`、`region-escape.log`、`region-mouse.log`、`region-tests-final.log`、`swift-full-tests.log`、`ci-full.log` 和 `ci-status.json`。
