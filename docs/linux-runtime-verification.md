# Linux 运行环境验证

服务正式入口为 `server/api/index.ts`。2026-09-07 只读核验 Vercel 项目 `notchspi-api` 使用 Node 24.x；原生依赖须在 Linux 安装，Mac 的 `node_modules` 不能用于发布。

本轮使用独立 QEMU x86_64 Linux VM 内的容器验证。Node 镜像固定为 `public.ecr.aws/lambda/nodejs@sha256:ba8267e65e24c53ab13256b11bd004a01e23c4ec7f0d5301522a57fba6868b63`，实际 Node 24.20.0、Amazon Linux 2023、glibc 2.34。镜像提供与 [Vercel AL2023 构建环境](https://vercel.com/docs/builds/build-image)相近的 Linux 用户空间；它不是 Vercel 部署，也不包含平台网关或生产数据库。镜像运行环境依据 [AWS Node.js 镜像说明](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html)。

## 输入与隔离

容器限制为 1 GiB 内存、无额外 swap、1 CPU、256 PID。先只传 `server/package.json` 和 lockfile，运行 `npm ci --include=optional --no-audit --no-fund`，再验证 sharp / libvips 实际加载。依赖下载结束后断开外部网络，只保留隔离的容器内部网络，随后传入候选源码、测试、操作 CLI、共享 fixture 和旧评测归档。没有主机目录挂载、SSH agent、生产密钥、真实付款或模型服务。

PostgreSQL 使用固定镜像 `postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`，独立的测试用户和库名，不映射主机端口。测试会清空该库；正式库不能作为 `TEST_POSTGRES_URL`。历史导入测试还需要 Git 基线，传入只读生成的 HEAD bundle；没有改写用户仓库历史。

完整验证输入清单为 `.release-evidence/2026-09-06/linux-runtime/source-manifest-complete.json`。每项必须与容器内文件逐字节 SHA-256 相符。全量测试不只依赖 `server/src` 和 `server/test`：还会运行 `scripts` 中的 CLI、读取 `Tests/Fixtures/objective-result-v1/cases.json`，并校验旧 Objective manifest 及 240 张图片。遗漏这些输入造成的是验证包缺陷，必须补齐后重跑受影响用例，不能记作跳过。

## 执行与证据

在隔离容器的 `server` 目录运行 `npm run typecheck` 和 `node --test --test-concurrency=2 'test/*.test.ts'`。`TEST_POSTGRES_URL` 只指向上述内部数据库。日志必须保留实际退出码、测试数量和失败明细；首轮失败日志与修复后的结果分别保存。

全量测试结束后，在无其他应用任务的 1 GiB 容器内从仓库根目录运行 `node scripts/verify-linux-runtime.mjs`。探针调用生产 `imageDigest` / `imageDigests`，验证 16MP 完整解码、两个任务的准入上限、四页顺序、非法图片拒绝后的恢复、队列清空和原生缓存不保留条目。输出只包含版本、资源和合成输入摘要，不保存客户图片。

sharp 的 ESM / CommonJS 包装器都在初始化时启用共享原生缓存。探针先加载诊断使用的 CommonJS 包装器，再加载生产模块，让生产的禁用缓存配置最后生效；否则诊断代码本身会重置配置。缓存和队列断言必须保留，不能为通过测试删除。RSS 与 cgroup 峰值、采样堆内存、事件循环延迟都保存，但 QEMU 的耗时不能用作真实设备或生产 SLA。

当前验证结果、原始日志和 QA 摘要统一见 [发布进度记录](release-progress-2026-09-06.md)。正式发布仍须执行 Vercel 构建/原生依赖打包核验、真实入口与 SSE 验证、独立分钟恢复日志及生产迁移。实际团队为 Hobby，每分钟 cron 会阻断部署；调度方案确定前不能将本地容器通过标记为已上线。

原生补验已在 [GitHub Actions 34068252074](https://github.com/RotteSya/notch-SPI/actions/runs/34068252074) 完成：Node 22.18/24.20 与 Postgres 16/17 的四组矩阵各 627 项全过；AL2023 同 digest 镜像在 x86_64 runner 上全新安装依赖，并在独立、无外网的 1 GiB 容器通过 25 次 16MP 解码及 10 次并发拒绝，覆盖 8 位和 16 位 RGBA。原生资源峰值 RSS 419.34 MiB；结果绑定 commit `90e368ec54e7ba6e310289f6caf2c2666cd32715`。QEMU 第二轮曾出现一次未解释的财务文件进程退出，独立 27 项及四组原生完整回归均通过，原日志继续保留。
