# 2026-09-06 阅读练习评测准备记录

用户已确认整轮真实模型评测最多花费 **100 元人民币**。授权记录在
[evaluation-budget.json](evaluation-budget.json)。这包含基线、候选、失败、解释和恢复调用；不是每次启动各有 100 元。本轮新增模型费用为 0。

## 本地题库查找结果

已搜索 `~/Developer`、`~/Documents`、`~/Downloads`、`~/Desktop` 的相关文件名，以及项目的隐藏/忽略目录；排除了依赖、构建产物和 Git 内部文件。另查了项目文本中的 `reading_practice`、`reading-practice`、`阅读练习`、`holdout`。

| 找到的目录 | 内容 | 能证明什么 |
|---|---|---|
| `Tests/Fixtures/objective-v1` | 240 题及图片摘要 | 既有客观题回归；不可当作新增阅读场景留出集 |
| `Tests/Fixtures/Personality` | 35 个人格模式测试项目 | 人格模式回归 |
| `objective-eval-output` | 既有 240 题模型运行和签署记录 | 历史评测；不表示当前修改已经通过 |
| `.eval-results/personality` | 既有人格评测输出 | 历史输出 |

上述位置没有找到阅读练习的独立授权题集。蓝图里的“阅读练习”目前是待验证场景名，并没有附带题库。不能把旧题库或临时生成的诊断题改名后作为独立留出集。

新增题集仍需满足蓝图 §13.2 的来源授权、家族隔离、分层样本量、布局覆盖、独立审题和完整一次运行要求。缺少这些材料时，继续本地工程验证；公开范围开关保持关闭。

## 币种、价格与凭证

历史客观题评测使用 `deepseek-v4-flash-vision-exp`。2026-09-06 查到的
[DeepSeek 官方人民币报价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)为高峰时段每百万输入 token（未命中缓存）3 元、输出 9 元。正式上界按较高价格计算，不依赖缓存和空闲时段优惠。图片也计入输入 token；官方说明每张图片最多 384 token，见
[图像计量](https://api-docs.deepseek.com/guides/vision/#token-usage)。此处是带日期的报价核验记录，不是永久固定价格。

DeepSeek 账户支持 CNY 或 USD，[只读余额接口](https://api-docs.deepseek.com/api/get-user-balance/)会返回实际币种。取得可用凭证后由执行者读取，无须让用户辨认币种。CNY 直接记账；USD 需先核验汇率并使用包含转换余量的人民币上界，不能将美元金额直接算成人民币。

本次检查中，进程环境没有可用的模型密钥；`server/.env.local` 中 Anthropic 和 DeepSeek 的值均为 `[SENSITIVE]` 脱敏占位内容。未打印真实密钥，未读取或修改生产数据库。可用密钥应通过本机环境变量提供；不要放进聊天、Git 或评测报告。

## 付费前检查与预算控制

执行 `node scripts/evaluation-preflight.mjs` 可重查本地题集、图片摘要、凭证存在状态及调用成本上界文件。它不加载数据库配置、不访问模型，缺少条件时返回退出码 2；找到候选题集也不等于通过授权审查和质量评测。

Objective、legacy 和新 reading 三个 Node 评测入口共用 `scripts/lib/evaluation-budget.mts`：

- 保留原 `NSPI_RUN_OBJECTIVE_EVAL=1` 启用条件和独立复核者要求。
- 调用前必须提供 `NSPI_EVAL_COST_BOUND`，指向已核验候选的成本上界 JSON；缺少、过期、币种不明或模型/地址不符时拒绝运行。
- 先检查整份题集的费用上界是否能放入剩余预算，每次发请求前再用 SQLite 事务占用预算。
- 整轮账本固定存于 `.eval-results/budget-ledger.sqlite3`，重启、改模型、基线和候选运行共用累计额度；不得通过删除该文件或更换 campaign 重置额度。
- 断网、HTTP 错误、进程退出和缺失 usage 均保留整次费用上界。正常返回也不回收预留差额，避免估算误差或尚未入账的费用变成新的可花额度。
- 不自动重试、不跟随重定向。发现实际 token 超出核验上界时持久化停止标记，阻止后续调用，转入费用核对。
- 每份 JSONL 记录预算调用 ID 和人民币费用上界，便于与供应商真实账单分别核对。上界占用不是实际消费。

成本上界文件字段由 `EvaluationCallBound` 定义：`model`、`base_url` 绑定隔离候选；`input_token_upper` 和 `output_token_upper` 必须覆盖候选服务实际允许的最大输入及输出（包括思考 token）；价格以原币种每百万 token 的百万分之一货币单位表示。`billing_currency`、`currency_evidence`、`pricing_source`、`bounds_evidence` 记录账户币种、官方价格和服务端限制证据。`cny_micros_per_currency_unit` 表示每原币种单位折合的人民币百万分之一单位；CNY 必须为 1000000，USD 另需 `exchange_rate_evidence`。`verified_at` 与 `expires_at` 最多相差 24 小时，每次发送时重新检查有效期。

此文件由执行工程师根据隔离候选和只读账户结果生成，不要求用户填写 token 限制或币种。当前缺少题集及可用凭证，尚未生成可启用付费调用的上界证明，也未进行真实模型调用。

2026-09-07 已接通 [新阅读执行/复核链路](reading-evaluation.md)：`run-reading-eval.mjs` 使用隔离官方设备 token，厂商 key 留在候选服务器；本机无需直接厂商 key。预检检查授权/真值/家族复核、完整图片、候选部署核验原件、价格上界与共享账本；不再将“本机没有厂商 key”单独作为官方执行器阻断。候选实际模型和提交仍需真实部署证据，HTTP health/config 不能代替该核验。

本周期只读预检结果：授权阅读 manifest、隔离设备 token、候选核验及成本上界仍缺失；本地共享预算账本尚未创建，累计可用上限 100 CNY，新模型调用 0。预检退出码 2 保留这些缺口。当前专项测试使用临时 diagnostic 材料与本机受控 provider，不计入正式模型质量。

## 本轮工程验证

修复 `billing-memory.ts` 与 `billing-sql.ts` 中实际费用被截断到预留金额的问题。现在完整计入已知超支，之后的请求按真实累计费用拒绝；重复结算及迟到释放不能抹掉这笔费用。memory 与 SQLite 共用行为测试覆盖这些情况。

2026-09-06 18:57（Asia/Shanghai）执行 `./scripts/verify.sh`，结果通过：Node 172 项全部通过；Swift 执行 172 项、跳过 2 项、失败 0；类型检查、本地 mock 服务检查、arm64 Release 编译和差异空白检查通过。新增评测预算测试 9 项，另新增 memory/SQLite 超支回归 4 项。首次类型检查发现脚本目录被按 CommonJS 解释，已改为显式 ESM 的 `.mts` 并通过复验。

离线预检查退出码 2 是预期的“未具备付费评测条件”，不是软件测试失败。240 张客观题图片摘要全部匹配。未配置隔离 Postgres 测试库，因此本轮未运行 Postgres 实库测试；未进行新的界面实测、生产变更或付费模型评测。完整蓝图及阅读场景质量验收仍未完成。
