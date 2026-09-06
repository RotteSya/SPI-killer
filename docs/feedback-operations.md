# 自愿反馈的收件、审核与删除

本规程对应 F14 / B21 的 `feedback-v2` 本地导出和 `scripts/manage-feedback.mjs`。客户端不自动上传；用户核对图片、当前答案、可选标准答案及用途，勾选权利确认后，选择本地保存位置。提交时需自行把 JSON 与旁边同名编号的材料文件夹一起交给已披露的支持邮箱 `raysyadesu@gmail.com`。反馈编号在 JSON 的 `submission_id` 字段中。本机原件由用户管理。

**状态：工具已经实现，正式征集尚未开放。** 开放前须指定接收负责人、审题成员、受控收件位置及其备份策略，在实际操作账户运行删除演练，并记录每日清理任务及告警的运行证据。此仓库没有设置这些账户权限或生产定时任务。完成之前，仅使用自有或已获相应用途授权的材料；测试夹具不是实际授权证据。

## 权限和保留边界

- 默认 `support_review` 仅排查本次问题，不能升级为质量评测。`quality_evaluation` 允许在同一授权期内排查和内部质量审核；进入评测还须独立审核、题目图片和已核对的标准答案。
- 两种授权均从导出确认时起最多 90 天；读取评测材料时再次验证期限。用途扩大、延期、外部模型或新的处理方，需要用户另行明确同意。本工具不会把原授权改写成新用途，也不会调用外部模型。当前导出**没有授权任何外部模型处理**。
- 正文、图片、答案、capture/session ID 仅留在单独的 `material` 目录。`record.json` 仅保存反馈编号、原件摘要、用途、期限、审核记录与删除状态；这些最小审计记录也只对授权成员开放，不能进入公开仓库、遥测或运营汇总明细。
- 存档根目录必须为仓库外的独立绝对路径，当前操作用户所有，权限 0700；文件 0600。放在受控账户的本地加密磁盘，不放进自动云同步、共享下载或未受控备份目录。文件权限隔离不等于多人身份管理；CLI 的 `--reviewer` 只是记录提交者声明，必须由实际授权名单、系统账户权限和审核证据补足身份核验。
- 禁止保留带正文的 CLI 日志、工单复制件或截图。该 CLI 的正常输出仅含最小元数据或受控本地路径；无效 JSON 的错误不会打印输入片段。审题报告如需引用原题，应放在同一受控存储并纳入同一删除范围。

## 已实现的操作接口

在仓库根目录执行。下列变量必须指向本次实际资料和已经分配的审核记录，不能用测试夹具充当授权：`FEEDBACK_VAULT` 为上述私有目录；`FEEDBACK_MANIFEST` 为收到的 JSON；`FEEDBACK_ID` 为完整反馈 UUID；`FEEDBACK_REFERENCE` 为唯一工单或审核编号；`FEEDBACK_REVIEWER` 为授权成员标识；`FEEDBACK_EVIDENCE_SHA256` 为已保存独立审核证据文件的 SHA-256（64 位小写十六进制）。引用和成员标识只接受字母、数字及 `_.:-`，最多 100 字符。

```sh
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" ingest --manifest "$FEEDBACK_MANIFEST"
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" status --id "$FEEDBACK_ID"
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" review --id "$FEEDBACK_ID" --reference "$FEEDBACK_REFERENCE" --reviewer "$FEEDBACK_REVIEWER" --evidence-sha256 "$FEEDBACK_EVIDENCE_SHA256" --decision support_checked
```

收件前先核对发送者与授权、撤回联系信息和文件来源。`ingest` 校验精确字段、版本、用途、时间、文件路径、大小和摘要，只复制被选择的图片。同一编号与原件摘要可安全重试；原件改变、已撤回或已删除的编号拒绝重新启用。收件成功后，按受控流程删除邮箱附件、下载临时件和解压目录中的冗余副本，记录这些位置，避免形成第二个无人管理的素材池。

收件工具只校验图像字节与导出摘要，不证明图像可读、答案正确或材料有权使用。审核成员必须实际打开材料，检查裁剪边界、私人信息、清晰度、题目与选项完整性、权利范围和标准答案，记录独立判断及证据摘要。客户端导出端另有完整图片解码检查；这也不能替代人工审题。

只有材料明确选择了质量用途、审核证据已经完成且审核者有权限时，才记录评测准入决定：

```sh
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" review --id "$FEEDBACK_ID" --reference "$FEEDBACK_REFERENCE" --reviewer "$FEEDBACK_REVIEWER" --evidence-sha256 "$FEEDBACK_EVIDENCE_SHA256" --decision evaluation_approved
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" material --id "$FEEDBACK_ID"
```

`material` 检查最新审核决定、当前授权和每张图片的摘要后返回受控路径；不复制进公共 fixture，也不接入模型执行器。它的输出始终声明 `external_processing: requires_separate_permission`。内部阅读审核通过不能被解释为外部模型调用许可。审核编号固定绑定同一决定；有新证据时使用新的审核编号，保留既往记录。后续 `support_checked` 决定会关闭当前评测准入。

## 撤回与到期清理

撤回渠道为上述邮箱。负责人通过原提交渠道核对申请，使用反馈 UUID 定位，不要求追加身份证件等无关资料。确认后立即停用并执行：

```sh
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" withdraw --id "$FEEDBACK_ID" --reference "$FEEDBACK_REFERENCE"
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" status --id "$FEEDBACK_ID"
```

工具先持久化 `purge_pending`，立即阻止继续审核和评测，再删除该编号的 `material` 目录，成功后记录 `withdrawn`。磁盘故障或进程中断不会把未完成删除伪装为成功；`prune` 重试同一删除决定。最终状态只证明**此存档内**的材料已经删除。

负责人还必须核对并删除收件邮箱及垃圾箱、下载/解压临时件、审题报告中的原文、授权范围内的派生副本及可删除备份。受控备份应排除此材料或支持同一编号的删除与恢复后重放删除记录；无法满足时不得正式收集。所有受控位置清理确认后，才向用户确认完成。通知需人工在原渠道处理；CLI 不发邮件。用户自己的导出原件不由服务方删除。

授权到期后即时拒绝材料准入，存储清理在每日任务以及每次收件/使用前运行：

```sh
node scripts/manage-feedback.mjs --vault "$FEEDBACK_VAULT" prune
```

每日任务须使用同一受控账户与绝对脚本路径，保存不含正文的退出码及 `{removed, active}`，失败通知负责人并暂停继续收件。此命令清理到期材料、未完成删除和崩溃遗留的暂存目录；实际每日调度及邮箱/备份清理仍是开放前必验条件。到期复审不会自动续期；如仍有使用需要，先获得新的授权及新提交编号。

## 故障与恢复

同一存档通过 `.lock` 互斥。出现 busy 时读取该目录内的 `owner.json`，核对 PID 对应的实际进程、启动时间及命令；进程仍运行时等待其完成。仅在确认原操作已经退出、没有并发操作后，移除该存档的陈旧 `.lock` 并立即执行 `prune`。不能仅凭 PID 不熟悉而杀进程或删锁。

无效记录、摘要不一致、权限过宽或路径链接会拒绝操作。保持材料不可用于评测，先依据原件与审计定位损坏；不能改原件摘要或授权日期来绕过校验。CLI 不会把损坏资料自动当作有效。删除故障恢复后先重跑清理，再重新开放使用。发布证据必须分别列出本地测试、真实删除演练和定时任务运行状态，不能互相代替。
