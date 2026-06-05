# CodeagentSession

> 开发者的 AI 会话档案馆：把 OpenCode、CodeAgent、Claude Code、Codex CLI、Gemini CLI 的本地会话集中到一个可搜索、可追踪、可复盘的 Web UI。

[English](./README.en.md) · [中文](./README.md)

![Node.js >= 22.5.0](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen?style=flat-square&logo=node.js)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime_deps-0-blue?style=flat-square)
![MIT License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)
![v1.3.0](https://img.shields.io/badge/version-1.3.0-orange?style=flat-square)

## 来源说明

CodeagentSession 基于 [OpenSession](https://github.com/HeavyBunny19C/OpenSession) 开发。这个项目保留了本地、多 Provider AI 会话浏览器的核心方向，同时迁移到 TypeScript，并继续推进更丰富的嵌套会话、调用链和系统提示可视化。针对 CodeAgent 特定优化.

## 它现在是什么

CodeagentSession 是一个本地优先的 AI 编程会话查看器。它不会修改原始工具数据库，而是读取你机器上的会话记录，生成统一的仪表盘、搜索、详情页、统计页、导出和调用链视图。

当前重点已经不只是“列出会话”，而是帮助你复盘一次 AI 工作流到底发生了什么：

- 哪个用户问题开启了这次会话
- Assistant 每一步做了什么
- 调用了哪些工具、MCP、Skill、LSP 或子 agent
- task/subtask 分支如何插入主会话
- 用户第一条消息之前加载了哪些 agent prompt、AGENTS.md、CLAUDE.md 或 configured instructions
- token、cost、runtime、模型分布如何变化
- 哪些会话值得收藏、重命名、删除或导出

## 支持的 Provider

| Provider | 状态 | 默认数据来源 | 能力 |
|:---|:---:|:---|:---|
| OpenCode | 完整支持 | `$XDG_DATA_HOME/opencode/opencode.db` 或 `~/.local/share/opencode/opencode.db` | 浏览、搜索、收藏、重命名、删除、回收站、导出、统计、Trace、嵌套会话 |
| CodeAgent | 完整支持 | `$XDG_DATA_HOME/opencode/db/ngagent.db` 或 `~/.local/share/opencode/db/ngagent.db` | OpenCode fork，同等能力 |
| Claude Code | 只读 | `~/.claude/transcripts/` + `~/.claude/projects/` | 浏览、搜索、token 统计 |
| Codex CLI | 只读 | `~/.codex/sessions/**/*.jsonl` | 浏览、搜索、token 统计 |
| Gemini CLI | 只读 | `~/.gemini/tmp/*/chats/*.json` | 浏览、搜索、token 统计 |

OpenCode 和 CodeAgent 使用独立的本地元数据库保存收藏、重命名、软删除等状态，不会写回原始会话数据库。

## 主要功能

- **统一仪表盘**：所有已检测 Provider 都显示在顶栏，未检测的 Provider 会灰显。
- **会话列表与搜索**：支持时间范围筛选、无限滚动、标题与内容搜索。
- **详情页复盘**：按消息、工具调用、todo、subsession 展开完整会话。
- **递归 Session Tree**：OpenCode/CodeAgent 的 child session 会被组织成嵌套结构，而不是散落在平铺消息里。
- **Tool Flow Tree**：右侧 Flow 视图按时间和层级展示 root、message、tool、subagent 分支。
- **Table of Contents**：长会话自动生成可折叠导航，只索引用户消息、assistant 消息和 `task` / `subtask` 子 agent。
- **System Prompts**：解析当前可用的 OpenCode 配置、agent markdown、AGENTS.md/CLAUDE.md 和 `instructions`，展示用户开始前可能进入系统上下文的内容来源。
- **Trace API**：暴露 step/span summary，聚合 tool、skill、agent、MCP、LSP 等调用。
- **统计面板**：展示会话数量、消息数量、token 趋势、模型分布、每日会话。
- **本地管理**：OpenCode/CodeAgent 支持收藏、重命名、批量操作、软删除、回收站恢复和永久删除。
- **导出**：OpenCode/CodeAgent 支持 Markdown 与 JSON 导出，JSON 包含 session tree。
- **中英双语**：通过 `--lang zh` 或 `--lang en` 指定界面语言。

## 安装

本项目当前支持以下安装方式：

### 方式一：安装打包后的包（推荐）

前往[下载页面](https://openx.huawei.com/codeagent-session/download)下载最新版本的安装包. 然后执行:

```bash
# 安装本地包
npm install --global {package}

# 运行
codeagent-session
# 或
codeagentsession
# 或
opensession
```

打开 http://localhost:3456 来访问主页

### 方式二：从源码运行

```bash
git clone https://szv-open.codehub.huawei.com/innersource/codeagent-session_G/codeagent-session.git
cd codeagent-session
npm install
npm start
```

## 命令行参数

```text
codeagent-session [options]

--port <number>       服务端口，默认 3456
--opencode-db <path>  OpenCode 数据库路径，别名 --db
--claude-dir <path>   Claude Code 数据目录
--codex-dir <path>    Codex CLI 数据目录
--gemini-dir <path>   Gemini CLI 数据目录
--reindex             启动时重建跨 Provider 索引
--lang <en|zh>        界面语言
--open                启动后打开浏览器
-h, --help            显示帮助
```

## 环境变量

| 变量 | 作用 |
|:---|:---|
| `PORT` | 默认服务端口 |
| `SESSION_VIEWER_DB_PATH` | OpenCode DB 路径，低于 `--opencode-db` 优先级 |
| `OPENCODE_DB_PATH` | OpenCode DB 备选环境变量 |
| `XDG_DATA_HOME` | OpenCode/CodeAgent 的 XDG 数据根目录 |
| `CLAUDE_CONFIG_DIR` | Claude Code 数据目录 |
| `CODEX_HOME` | Codex CLI 数据目录 |
| `GEMINI_HOME` | Gemini CLI 数据目录 |
| `OPENSESSIONVIEWER_META_PATH` | OpenSessionViewer 元数据库路径 |
| `OH_MY_OPENSESSION_META_PATH` | 旧版兼容元数据库路径 |

## 架构概览

```text
src/
├── providers/
│   ├── interface.ts       # ProviderAdapter 接口
│   ├── index.ts           # Provider 注册表
│   ├── opencode/          # OpenCode-compatible SQLite 适配器工厂
│   ├── codeagent/         # CodeAgent 适配器，复用 OpenCode schema/parser
│   ├── claude-code/       # Claude Code JSONL 适配器
│   ├── codex/             # Codex CLI JSONL 适配器
│   └── gemini/            # Gemini JSON 适配器
├── db.ts                  # OpenCode-compatible DB 查询
├── meta.ts                # 收藏、重命名、删除等本地元数据
├── index-db.ts            # 跨 Provider 会话索引
├── server.ts              # HTTP API 与 SSR 页面
├── views/                 # 服务端渲染模板
├── static/                # 前端 JS/CSS
└── locales/               # 中英文文案
```

## 当前验证状态

最近一次真实数据验证使用：

```text
OpenCode DB: C:\Users\QQ110\.local\share\opencode\opencode.db
Server: http://127.0.0.1:3456/opencode
Data: 24 sessions, 1903 messages
```

验证覆盖：

- dashboard、session list、search、stats、session detail
- recursive session tree、TOC、Flow 视图、System Prompts
- OpenCode 管理操作入口
- CodeAgent 缺省 DB 不存在时的 unavailable 页面
- `agent-browser` delegated E2E，无 browser/page console errors

## Roadmap

下一阶段会围绕“更准确地复盘 AI 工作流”继续推进：

[x] **Session Container Rewrite**
   - 将 session 建模为可递归容器，主会话、child session、subsession 都能以统一结构插入和渲染。

[x] **Nested Subagent Expansion**
   - 将 `task` / `subtask` 工具调用展开为可折叠的 nested subagent session，而不是普通工具行。

[x] **Metrics Upgrade**
   - 增加 per-session token usage、runtime、step duration、tool counts、model/provider breakdown。

[ ] **Tool Flow Tree**
   - 将当前 trace/tool 视图升级为完整树，包含所有 sub-session branch、task calls、spans 和 timing。

## 开发命令

```bash
npm run typecheck
npm run build
npm start
```

## License

MIT
