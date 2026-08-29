# Personality 付费评测协议

`manifest.json` 是 fixture ID、图像哈希、协议期望、人物像方向选项和发版阈值的唯一来源。
入库 JPEG 均为合成图。需要重建时：

```bash
python3 -m venv /tmp/notchspi-fixtures
/tmp/notchspi-fixtures/bin/pip install -r scripts/requirements-fixtures.txt
/tmp/notchspi-fixtures/bin/python scripts/generate-personality-fixtures.py
swift test --filter PersonalityEvaluationTests.testSyntheticFixtureManifestIsCompleteAndSelfConsistent
```

JSONL 与脱敏 Markdown 摘要写入 `.eval-results/personality/`（已 gitignore）。
这是短期证据，不是架构文档。需要永久保存时作为 Release artifact 上传，不要提交仓库。
记录只含协议/评分元数据；禁止写入原始 completion、人物像正文、题目正文、API Key 或用户数据。

## 跑官方通道（发版闸门）

第一次有意使用 pending reviewer，先落证据，只让签核断言失败：

```bash
NSPI_RUN_PERSONALITY_EVAL=1 \
NSPI_EVAL_CHANNEL=official \
NSPI_EVAL_EXECUTOR="$USER" \
NSPI_EVAL_REVIEWER=pending-second-review \
NSPI_EVAL_PROVIDER_MODEL='anthropic:claude-opus-4-8' \
swift test --filter PersonalityEvaluationTests.testOfficialPersonalityReleaseGateWhenExplicitlyEnabled
```

CLI 或自定义 Key 基线：`NSPI_EVAL_CHANNEL=cli` 且 `NSPI_EVAL_CLI=claude|codex`，
或 `NSPI_EVAL_CHANNEL=customKey` 并保证 App/Keychain 里已有对应配置。
非官方通道记录指标，不套用官方阈值。
`NSPI_EVAL_FILTER=<fixture-id-or-category>` 把所选 run 变成严格协议兼容检查。

`NSPI_PERSONALITY_FIXTURES_DIR` 可指向私有外部 fixture 目录（同一 manifest schema）。
不要把私有图像或绝对路径放进本仓库。

## 第二人复核

打开生成的 Markdown 摘要，按方向性索引对照合成图、人物像变体和 `manifest.json` 的
`expected_choices`。复核后只签名、不再打模型：

```bash
NSPI_REVIEW_PERSONALITY_EVAL="$PWD/.eval-results/personality/<result>.jsonl" \
NSPI_EVAL_REVIEWER='<reviewer identity>' \
swift test --filter PersonalityEvaluationTests.testExistingOfficialRecordWhenExplicitlyReviewed
```

签名只替换该 JSONL 的 `reviewer` 元数据，并原地更新同目录 Markdown。
测试同时核验 manifest 全覆盖、无 transport 失败、以及五项官方阈值。
