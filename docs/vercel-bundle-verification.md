# Vercel 函数包核验

2026-09-07 使用已认证的项目 API 只读取构建元数据：项目 notchspi-api，Root Directory 为 server，Node 24.x，项目 framework 为 fastify，但源码 vercel.json 明确 framework=null。实际构建必须在包含 server 的仓库根目录加载项目设置，再使用 server/vercel.json；从临时 server 子目录直接套用 rootDirectory=server 会重复拼接路径，不能把这种诊断目录错误归因于 npm 缺失。

候选 90e368e 使用 Vercel CLI 59.11.7、@vercel/node 12.0.1、TypeScript 5.9.3 可完成构建，但默认 @vercel/static 将 115 个 src/test/tsconfig 文件放入静态输出。生成路由先检查 filesystem。对现有生产版本两条路径的 HEAD 检查也返回 200；没有读取正文，没有核验或声称泄露环境密钥。原始记录保留在 `.release-evidence/2026-09-06/vercel-existing-static-head.json`。

修复将 outputDirectory 固定到 public，并提供实际使用的 robots.txt，保留管理、API、购买路径的爬虫排除。公开产品页及 API 继续由原 Fastify 函数处理。robots.txt 不承担鉴权；静态输出隔离由构建配置和产物检查负责。单独指定不存在的 public 目录不足以阻止默认回退；空目录也无法稳定通过后续构建，因此不能用未跟踪空目录作为发布前提。

新增 CI 任务在固定 AL2023 Node 24 镜像内安装固定 Vercel CLI，并使用公开项目设置快照运行 `vercel build --standalone`。CI 没有 Vercel、Postgres、Stripe 或模型凭证，不执行 deploy，也不调用真实模型。每次正式部署前仍需重新读取实际生产设置。CLI 使用真实 server/package-lock.json 安装目标平台原生依赖；不能复制 Mac 的 node_modules。

`node scripts/verify-vercel-output.mjs .vercel/output` 在 Linux x86_64 上检查：

- 静态输出恰好为已审核的 robots.txt，内容与源码相同；函数仅一个，入口、Node 24 runtime、架构及 300 秒时限匹配。
- standalone 包无外部符号链接、环境文件、应用测试文件或数据库；原生 .node 为 x86_64 ELF；函数大小在平台上限内；逐文件记录字节数与 SHA-256。
- 从包内导入 sharp、完整图片校验、SQLite/Postgres 动态模块；SQLite 使用内存库，不连接外部数据库。
- 通过打包后的 api/index.js 启动真实 loopback HTTP：健康状态、三语页面、源码路径 404、reaper 拒绝无凭证、授权恢复空队列、fixed30 注册、旧协议 SSE 单次结算及余额刷新。

HTTP 冒烟子进程只继承明确的测试环境；本地 mock 仅用于验证打包后的协议和结算线路，不构成模型质量、生产配置或正式付费证据。CI 在无外网、只读挂载和 1 GiB cgroup 下运行验证，然后归档 config.json、functions 和 static。Mac 可显式传 `--allow-host-platform` 做诊断，报告会标明不是 Linux 发布包。

真实生产日志表明当前 Fluid Active CPU 计费会忽略 vercel.json 中的 memory 设置。1 GiB 资源测试仍提供保守限额证据，但不是线上内存配置或延迟 SLA。package.json 的开放 Node 最低版本范围仍需与正式构建输出中的 nodejs24.x 一起检查，平台升级不能跳过这道产物闸门。

## 实际执行结果

[CI 34069961702](https://github.com/RotteSya/notch-SPI/actions/runs/34069961702) 在提交 `a797ef18c8d2ce7c808e240e25c93dc8b2563041` 上全部 9 项通过。函数包任务使用 AL2023、Node 24.20.0、CLI 59.11.7、@vercel/node 12.0.1。包内 551 个函数文件共 23,007,333 字节，静态文件仅 robots.txt；全部打包后 HTTP/SSE、图片与动态 SQL 检查通过。归档含 553 个文件，下载后逐一复核摘要通过，归档 SHA-256 为 `c47fb6c770beed5b90c59d30a186f18950eba71e8d243896a3ad69a33b9590b0`。

原始产物与日志位于 `.release-evidence/2026-09-06/native-ci-a797ef1/vercel-linux-bundle/`。真实旧快照的回归拒绝证据为 `vercel-bundle-before-static-fix.json` / `.log`，不是合成文件替代实际构建。

成功的本地或 CI 构建不验证 Hobby 分钟 cron 能力、生产密钥/价格/预算、数据库迁移与旧写入实例退出、真实 Stripe、SSE 平台代理行为、真实 UI 或模型留出集。正式部署和灰度仍受这些闸门约束。
