# AgentSession

AgentSession 3.0 是本地优先的 AI 编程工作历史阅读器。此工作区唯一实现采用
Rust、Axum、原生 rmcp stdio MCP 和 Svelte 前端，读取 OpenCode、Claude Code、
Codex CLI、Pi 和 DeepSeek Harness 的记录，提供会话库、正文阅读、搜索、用量和
Runtime 视图。

Provider 数据库与 transcript 保持只读；收藏、标题和回收站状态写入独立的 Viewer
元数据。阅读与 MCP 检索均保留 canonical provider/session 身份和已记录的证据。

[English](README.en.md) · [原生 CLI、配置与 MCP](v3/README.md) ·
[验收契约](docs/design/agentsession-v3-acceptance-contract.md)

## 3.0 稳定版

**3.0.0** 使用 npm `latest` 稳定版渠道。
[更新说明](docs/releases/3.0.0.md)记录功能、升级步骤和实际验证范围；
完整性能、资源及历史状态归因仍有开放项，见[验收账本](docs/specs/stable-readiness-2026-10/tasks.md)。

```sh
npm install -g @acetamido/agentsession@3.0.0
npm install -g @acetamido/agentsession-mcp@3.0.0
agentsession
```

预发布继续使用 npm `next` 渠道。[更新与升级说明](docs/releases/3.0.0.md)
以公开版本 v1.10.1 为基准，涵盖默认端口、元数据副本导入和 MCP/API 迁移。
四平台独立程序见 [GitHub Release](https://github.com/Guanzhw/AgentSession/releases/tag/v3.0.0)。

从旧版升级时，请先按[元数据迁移指南](v3/README.md#viewer-metadata-import)
导入旧收藏、标题和回收站状态，再进行新版元数据编辑。3.0.0 的 npm 入口支持
`migrate-meta`；指南也保留 rc.4 的独立程序路径，并说明已有新版状态时如何保留两份数据。

如果第三方 npm 镜像对新版本的 tarball 返回 `404`，可仅对本次安装指定官方源：

```sh
npm install -g @acetamido/agentsession@3.0.0 @acetamido/agentsession-mcp@3.0.0 --registry https://registry.npmjs.org
```

这不会修改全局 npm registry 配置；官方源也报错时，应保留具体错误继续排查。

## 从源码运行

开发需要 Node.js 22.15 或更新版本，以及支持 edition 2024 的 Rust 工具链。

```bash
npm install
npm --prefix v3/ui ci
npm run build
npm start
```

打开[本地 Viewer](http://127.0.0.1:3457)。根目录安装没有 prepare 构建步骤；
UI 依赖需明确安装。`npm run build` 构建 UI 和锁定依赖的 Rust release；
`npm start` 构建并启动该原生 Viewer。参数可通过
`npm start -- --port 3458 --disable-terminal-launch` 转发。

已构建的原生程序可用 `v3/target/release/agentsession-v3 serve` 直接启动
（Windows 文件名带 `.exe`），用 `mcp` 子命令启动原生 stdio MCP。
独立程序运行时无需 Node 或 Cargo。

## 3.0.0 阅读与导航修复

正文搜索结果可直接显示并高亮初始窗口之外的匹配内容，使用与 Reader 一致的
UTF-16 位置和 `contentRevision`，按有界正文窗口读取；浏览器 Back 恢复查询、
结果和所选位置。会话库各行显示自身加星状态，**仅显示加星会话**可与提供方、
项目、时间和排序筛选组合，保留 core 的父子家族语义。

**技术详情**跳转到来源正文后，Back 恢复 Runtime 视图、已应用筛选、当前页和
滚动位置；相关会话图选择也随历史保留。回收站区分完整、部分和失败读取，部分
结果保留可读行并标记数量不完整，失败时数量未知，两者均可重试。来源诊断链接到
对应的 Settings 锚点，显示当前启动路径、配置字段、命令行选项及重启复查步骤；
路径优先级为 CLI、环境变量、配置文件、提供方默认值。

范围见[修复规格](docs/specs/reader-journey-repair-2026-10/requirements.md)，
实际验证见[执行记录](docs/specs/reader-journey-repair-2026-10/tasks.md)。
这些改动包含于 3.0.0；历史 rc.4 保留原有行为。

## 开发与状态

本地未发布修复：Token 统计默认按 Token 展示趋势、Harness 与模型份额。
Codex 普通 `token_count` 记录按可核验的累计增量计入已知用量，重复快照不重复
计数；请求数仍需要明确的请求身份。旧格式 `session_id` 会话头也可被发现。
详见[统计修复决策](.agents/decisions/implemented/2026-10-12-codex-recorded-token-consumption.md)。

本地架构修复同时修正 Claude pending 用量去重，保留 DSH 歧义会话诊断，并让
Reader 续读保留具体 Protocol 错误。旧派生索引和 Reader 缓存会自动重新捕获；
provider 原始数据与 Viewer 元数据保持原状。浏览器公开回归在 Linux x64 CI 必跑，
本地浏览器工具独立安装，项目的 Node.js 22.15 开发要求保持。

```bash
npm run review
npm test
```

[开发指南](AGENTS.md)规定代码归属和验证要求；
[交付计划](docs/design/agentsession-v3-delivery-plan.md)记录剩余来源、性能、产品和
平台门槛。3.0.0 的验证范围与发布裁决见更新说明；完整验收仍保留未补证项。2.0 的历史证据和迁移
决策保留原有范围，其实现可从 Git 历史恢复。

## 许可证

MIT
