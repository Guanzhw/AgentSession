# AgentSession

AgentSession 3.0 是本地优先的 AI 编程工作历史阅读器。此工作区唯一实现采用
Rust、Axum、原生 rmcp stdio MCP 和 Svelte 前端，读取 OpenCode、Claude Code、
Codex CLI、Pi 和 DeepSeek Harness 的记录，提供会话库、正文阅读、搜索、用量和
Runtime 视图。

Provider 数据库与 transcript 保持只读；收藏、标题和回收站状态写入独立的 Viewer
元数据。阅读与 MCP 检索均保留 canonical provider/session 身份和已记录的证据。

[English](README.en.md) · [原生 CLI、配置与 MCP](v3/README.md) ·
[验收契约](docs/design/agentsession-v3-acceptance-contract.md)

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

## 开发与状态

```bash
npm run review
npm test
```

[开发指南](AGENTS.md)规定代码归属和验证要求；
[交付计划](docs/design/agentsession-v3-delivery-plan.md)记录剩余来源、性能、产品和
平台门槛。本次工作区整合不代表 3.0 已发布或完成全部验收。2.0 的历史证据和迁移
决策保留原有范围，其实现可从 Git 历史恢复。

## 许可证

MIT
