# 2026-09-09 发布进度

本轮完成框选、答案辅助功能及临时截图清理修复。最新客户端与测试提交为 `645c1de3825a6e15168c99a994fb36a72112bcd6`。**尚未公开发布，生产服务及数据库未切换。**

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

**框选修复阶段的候选**现保存在 `.release-evidence/2026-09-09/pre-answer-dist/NotchSPI.dmg`，3,996,192 字节，SHA-256 `4323d5177b78ff611f251591b26f501559d31a86bf6011f1a4f24de54c3c7a08`。只读挂载后 App strict codesign、Gatekeeper 和 DMG stapler 均通过；59 个客户端/打包输入摘要与 `1a2c1401955b35c4263b390fab5576ce483a02a7` 一致，见 `notarized-artifact-manifest.json`。未公开发布。

上一轮已公证且核验通过的安装包保存在 `.release-evidence/2026-09-09/pre-region-dist/NotchSPI.dmg`，SHA-256 `1f6ce5824a83d1b3b16fa008c89064c79b72bfae08521e03cc752922bf36436f`；它不包含本轮框选修复。


## 实机捕获、辅助功能与隐私清理

- `3c09b33`：StreamingAnswerView 将实际合成后的可见文本提供给辅助功能，包括折叠/展开状态；复制和展开操作走现有真实回调并重新检查可用性。两个测试及实际返回答案的辅助功能树核验通过。
- `6d9f369`：MaterialActionButton 支持不成为 key window 的 NotchPanel 与辅助功能操作。删除闭包仅持有材料 UUID，避免辅助功能客户端保留旧按钮时连带保留图片。新增测试先复现失败，再在修复后通过。
- `645c1de`：真实删除最后一张材料仍残留文件，进一步发现隐藏的 QuestionMaterialStrip 跳过更新并保留旧 assets。现在隐藏时仍同步材料状态；完整 NotchView 回归同样先失败后通过。随后最终版实际保存一张截图，点击“删除第 1 张材料”后立即确认对应文件不存在，最后一张材料删除的实机验收已补齐，见 `material-final-ui/delete-result.json`。
- CaptureFileLifecycle 将 JPEG 与题组目录注册到本进程所有权集合，写入和退出清理共用锁，禁止退出后迟到写入重新创建文件。目录 0700、图片 0600；正常 App 退出等待后台清理，失败取消退出并给出重试提示。启动清理包含过期的 capture 目录。并发写入、无关文件保留及迟到写入拒绝测试通过。
- 真实捕获后的 Cmd-Q 曾确认 App exit 0，所跟踪的 1 张图片与其目录都不存在，见 `cleanup-live-validation.json`。不把后续 SIGINT 停止记作正常退出验收。
- 真实捕获耗时出现 295/312/325ms 及 10,591ms；材料保存另观察到约 20–21 秒等待。工具取状态的延迟不能直接归因于 App 死锁，也不能据此宣布性能达标。
- 最终本地命令 `NSPI_QA_EPHEMERAL=1 swift test -Xswiftc -warnings-as-errors` 执行 290 项、2 项显式真实模型评测跳过、0 失败。没有把跳过项计为质量通过。日志 `swift-hidden-final.log`。
- CI 34252218494 除 artifact 上传 403 外，还暴露 loopback HTTP 测试 -1005。修复测试服务：读完整 POST body 再应答，使用 TCP 最终发送而不是取消连接截断队列；仍严格测试缺 DONE 的失败。32KiB 请求体验证和连续 5 轮通过，未修改生产流解码器。[CI 34255328679](https://github.com/RotteSya/notch-SPI/actions/runs/34255328679) 已 10/10 成功。最终隐藏材料修复提交的 [CI 34255765664](https://github.com/RotteSya/notch-SPI/actions/runs/34255765664) 也已 10/10 成功；状态与完整日志为 `ci-final-status.json` / `ci-final.log`。其中 macOS 290 项、2 跳过、0 失败；Node 22/24 各 509 项通过；PostgreSQL 16/17 × Node 22/24 四组各 630 项通过。CI 中 TypeScript typecheck、依赖审计、Swift warnings-as-errors、Cloudflare 构建与 Linux/Vercel 原生包检查均通过。

本节证据目录：`.release-evidence/2026-09-09/capture-chain/`。关键文件包括 `local-settlement-validation.json`、`readable-result.png`、`cleanup-live-validation.json`、`material-lifetime-before.log` / `material-lifetime-after.log`、`hidden-material-before.log`、`swift-hidden-final.log`、`transport-repeat.log`、`stopped-qa-cleanup.json` 及 CI 完整日志。`deletion-fixed-validation.json` 是第二个隐藏视图问题修复前的失败证据，不能引用为通过。

## 当前可核对的安装包

最终客户端提交 `645c1de3825a6e15168c99a994fb36a72112bcd6` 对应 `dist/NotchSPI.dmg`，版本 2.12 / build 19，arm64、最低 macOS 14.0；4,038,862 字节，SHA-256 `cac71ab3180de9d4108b85a74caa1a0f696608248797e8323ca3ee453f9c49d2`。Apple 公证 `3b3d98d0-1cfd-4d2b-a380-ca9ff425a9c8` 已 Accepted，装订、HFS+ 映像完整性、只读挂载后 strict codesign 与 Gatekeeper 均通过。60 个客户端/资源/打包输入摘要与该提交一致，包含新增 CaptureFileLifecycle.swift。

完整证据为 `capture-chain/release-package-final.log`、`artifact-verification.log`、`notarized-artifact-manifest.json`。`pre-lifecycle-dist` 和 `pre-hidden-strip-dist` 是本轮中间已公证包，均不包含全部最终修复，不作为当前候选。当前包仍未上传公开 Release。

## 未完成验收与外部条件

实际全屏捕获→localhost mock 请求→答案显示与结算已通过，四个隔离测试账户各从 30 变为 29、累计查题 1，4 个预留均 settled、无 held。这只证明传输与 UI/结算链路，不能证明模型质量；完整捕获→框选→请求组合仍待验收。材料操作暴露了两个真实文件持有问题，修复后自动测试通过，最终版删除最后一张材料及“新题组”清空的实机验收均已通过。Computer Use 状态读取出现超时；正常退出测试另有独立成功证据，SIGINT 停止不计为正常退出。隔离 QA App 与 localhost mock 服务均已停止，没有真实模型或支付调用。完整 VoiceOver 语音、其他显示器/设备仍待验证。

400 道新增授权留出题、80 份独立解释复核、同候选 240 题基线、正式旧写入隔离及数据切换、支付端到端对账、生产恢复调度、反馈删除演练和分档观察门槛仍未完成，详情继承 [9 月 8 日发布记录](release-progress-2026-09-08.md)。生产新能力保持关闭，Cloudflare 定时触发仍暂停；CNY 20/日模型预算待新版生产部署后才生效。

证据目录：`.release-evidence/2026-09-09/ui/`。包括 `region-validation.json`、`region-keyboard.png`、`region-escape.log`、`region-mouse.log`、`region-tests-final.log`、`swift-full-tests.log`、`ci-full.log` 和 `ci-status.json`。

## 最终版实机删除与部署清单补验

`material-final-ui/validation.json` 记录最终代码的实际截图和删除结果：保存后新增 1 张材料，点击删除后剩余 0 张。最初错误提示仅用于 DEBUG 展示操作入口，新增材料来自实际 ScreenCapture；未连接模型或支付服务。此轮没有修改产品代码，公证包及 CI 证据仍对应 `645c1de`。

清空题组前两次被 Computer Use `get_app_state` 超时中断，两个隔离 QA 进程用 SIGINT 停止。确认工具请求终止并恢复连接后，第三次独立尝试实际保存材料、点击“新题组”，在 App 退出前确认文件剩余 0，再 Cmd-Q 正常退出、exit 0。证据 `clear-input.json` / `clear-result.json` / `validation.json`；前两次 SIGINT 不算正常退出验收。

Vercel 只读 API 完整列出 41 个部署，分页 `next=null`、均 READY，原始清单见 `material-final-ui/deployment-inventory.json`。READY 仅表示部署构建状态，不能证明是否仍在运行、可公开访问或使用同一数据库凭证。生产停流/排空时必须按此完整清单核验旧入口、角色及连接隔离；当前未删除任何旧部署、未撤销生产凭证或切换流量。正式质量材料和独立复核仍未提供。

生产项目回读同时确认主路由仍为旧部署 `dpl_BStwrGFdwhRC7FP3g2m6snSpcgfC`，项目已有 `all_except_custom_domains` SSO 保护，见 `material-final-ui/production-routing.json`。这限制部署地址访问，但不证明旧数据库凭证已撤销；未更改现有保护设置。

## 新发现的性能阻断

最终版完整框选请求尝试未通过。点击真实“框选题目”完成本机注册后，窗口状态读取连续超时；App 自身标准输出记录 `capture took 128575ms`。这是真实客户端计时，不能仅归因于工具等待。该隔离数据库 1 个设备、余额 30、capture/reservation 均 0，没有扣题或模型调用，见 `material-final-ui/region-chain-incomplete.json`。两秒进程采样显示主线程处于正常事件循环，不能据此证明异步截图操作正常，也没有证据认定主线程死锁。

为排除同时使用界面截图工具的影响，确认所有前序 Computer Use 请求已终止后，使用现有 DEBUG `--qa-capture 3` 自动入口运行同一真实查题实现，期间没有 Computer Use 调用。进程运行 3 分 22 秒时仍为 0 captures、0 reservations、余额 30，随后停止 App 及本机服务。三次计划触发不能算成三次完成；后续触发可能被现有 running 防重入拦截。证据为 `capture-isolated-status.json`、`capture-isolated-client.log` 和 `capture-isolated-server.log`。

现有证据确认了长等待及请求未提交，尚未定位到共享窗口枚举、截图 API、注册后的状态转换中的具体等待点；也不能推断只是 Computer Use 同时截图导致。**候选未通过运行性能验收，公开发布继续暂停。** 下一步需对实际等待阶段加有界诊断，查明回调、取消和缓存刷新路径，再验证恢复与失败提示；不得用延长等待或单次成功替代修复。产品源代码本轮未改，已公证包和通过的 CI 仍对应 `645c1de`，它们证明打包与已有检查通过，不证明此运行问题已解决。
