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
--config <path>       OpenSessionViewer JSON 配置文件
--allow-terminal-launch
                      允许本地页面通过 Windows Terminal 继续会话
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
| `OPENSESSIONVIEWER_CONFIG` | JSON 配置文件路径 |

## 继续会话命令

会话详情页始终显示可复制的 session ID。当 Provider 有已知的继续命令，且
会话记录中的项目目录有效时，页面也会提供可复制的命令。只有使用
`--allow-terminal-launch` 启动服务后，页面才允许实际打开终端。

所有已注册 Provider 都声明了默认继续命令：

| Provider | 默认命令 |
|---|---|
| OpenCode | `opencode --session {sessionId}` |
| CodeAgent | `codeagent --session {sessionId}` |
| Claude Code | `claude --resume {sessionId}` |
| Codex CLI | `codex resume {sessionId}` |
| Gemini CLI | `gemini --resume {sessionId}` |

每个命令和 PowerShell 兼容终端 shell 都可以在 OpenSessionViewer 配置目录的
`config.json` 中覆盖，也可以通过 `--config` 指定文件：

```json
{
  "resumeCommands": {
    "opencode": {
      "executable": "opencode",
      "args": ["--session", "{sessionId}"]
    },
    "codeagent": {
      "executable": "my-codeagent",
      "args": ["resume", "{sessionId}"],
      "cwd": "D:\\WorkSpace"
    },
    "gemini": false
  },
  "resumeShell": {
    "executable": "powershell.exe",
    "args": ["-NoExit", "-NoLogo", "-NoProfile"]
  }
}
```

支持 `{sessionId}` 和 `{projectPath}` 占位符。命令以 executable/args 数组
启动，不执行原始 shell 字符串。对于历史记录中没有项目目录的 Provider，
可以显式配置绝对路径 `cwd`。将 Provider 配置设为 `false` 可禁用其继续
会话操作。

`resumeShell.executable` 可以是 `pwsh.exe`、`powershell.exe`，或
PowerShell 兼容程序的绝对路径。`args` 会插入到自动生成的
`-EncodedCommand` 参数之前。未配置时，OpenSessionViewer 会依次查找
`pwsh.exe` 和 `powershell.exe`，并使用 `["-NoExit", "-NoLogo"]`。

## Web 设置

打开 `/:provider/settings`，例如
`http://127.0.0.1:3456/opencode/settings`，即可通过开关和表单管理分析功能、
目标路径、Provider 命令、继续会话命令和 PowerShell Host。页面会显示配置
文件的准确路径，并在保存前完成校验。底层 JSON 仍保留在折叠的高级设置中。

`analysis`、`resumeCommands` 和 `resumeShell` 的修改会立即应用到当前服务器。
端口、数据目录和 Provider 路径等配置会持久化，但需要重启后生效。
`allowTerminalLaunch` 有意保留为非 Web 配置权限：必须使用
`--allow-terminal-launch` 启动 OpenSessionViewer，才能向当前进程授予该能力。

## 会话分析与评估提案

OpenSessionViewer 可以从会话详情页以非交互方式启动已配置的 Agent。
分析任务只生成提案：它会把会话保存为带索引的 JSONL 证据、保存选定工件
快照、创建评估种子，并要求 Agent 输出：

- `report.md`：主要的、面向人的分析结果
- `evaluation-proposals.json`：包含回放、留出和回归用例的验证计划
- `artifact-proposals.json`：建议的目标修改，也可能是空提案列表

这三个文件是最终分析产物。`session-index.json`、`evidence-index.json`、
`evidence.jsonl`、`artifacts.json` 和 `manifest.json` 等文件属于支持证据和
诊断数据。已完成运行会在会话的 **分析活动** 面板中显示直接打开和下载链接。

生成的评估用例初始状态为 `status: "proposed"`。OpenSessionViewer 不会直接
修改 Skill，也不会把提案标记为已验证。只有在基线版本与候选版本通过重放、
留出和回归测试后，才应提升候选工件。

Analyzer 退出后，OpenSessionViewer 会自动检查输出结构，要求同时包含重放、
留出和回归用例，依据工件清单验证提案根目录与路径，解析每个 `ev:...` 与
`artifact:...` 引用，并要求显式描述基线/候选预期以及 token/runtime 标准，
最后将 `manifest.json` 状态更新为 `completed`、`invalid` 或 `failed`。

会话页面包含一个 **分析活动** 面板。分析运行期间页面会自动轮询，结束后
显示权威的 manifest 状态、进程退出码、提案数量、校验错误和本地运行目录。
启动 Toast 只表示命令已经发起；是否真正成功应以分析活动面板为准。

Analyzer 首先读取紧凑的会话层级与证据索引，而不是单个大型会话 JSON。
生成的分析请求提供以下只读命令：

- `session_main_info`
- `session_query_system_prompts`
- `session_query_context`
- `session_query_errors`
- `session_query_tools`，使用 `status: "completed"` 获取正样本
- `session_find_anomalies`
- `session_get_evidence`
- `extension_list`
- `extension_get`

用户中断信号来自明确的工具错误原因。“高错误率”仍是透明的启发式判断：
结果会返回阈值、最小工具调用样本数、原始计数、错误率和完整排序。Analyzer
在提出修改前还必须对比成功与失败的执行结果。

会话分析与继续命令共用显式的 `--allow-terminal-launch` 安全开关，并且需要
为每个 Provider 单独启用和配置：

```json
{
  "analysis": {
    "enabled": true,
    "defaultTargets": ["skills", "tests"],
    "defaultTarget": "skills",
    "outputDir": ".opensessionviewer/analysis",
    "includeRawSnapshots": false,
    "shell": {
      "executable": "powershell.exe",
      "args": ["-NoExit", "-NoLogo", "-NoProfile"]
    },
    "targets": {
      "skills": {
        "label": "分析 Skills",
        "artifactRoots": ["skills", ".agents/skills", ".codex/skills"],
        "extensions": [".md", ".json", ".yaml", ".yml", ".js", ".ts", ".py"],
        "promptFile": "prompts/analyze-skills.md"
      }
    },
    "providers": {
      "opencode": {
        "command": {
          "executable": "opencode",
          "args": [
            "run",
            "读取附加的分析请求并写入要求的提案文件。",
            "--model", "deepseek/deepseek-v4-flash",
            "--dir", "{projectPath}",
            "--file", "{promptPath}"
          ]
        }
      },
      "claude-code": {
        "command": {
          "executable": "my-other-agent-cli",
          "args": ["--non-interactive"],
          "stdin": "prompt"
        },
        "shell": {
          "executable": "pwsh.exe",
          "args": ["-NoExit", "-NoLogo"]
        }
      }
    }
  }
}
```

命令支持 `{sessionId}`、`{projectPath}`、`{target}`、`{runId}`、
`{runDir}`、`{sessionPath}`、`{sessionIndexPath}`、
`{evidenceIndexPath}`、`{evidencePath}`、`{analysisToolPath}`、
`{promptPath}`、`{reportPath}`、`{evaluationSeedPath}`、
`{evaluationPath}`、`{proposalsPath}` 和 `{artifactsPath}` 占位符。
也可以使用 `{prompt}` 将完整提示词作为一个参数传入，但大体积会话更适合
使用 `{promptPath}` 或 `"stdin": "prompt"`。只有启用
`includeRawSnapshots` 进行调试或兼容旧 Analyzer 时，才应使用
`{messagesPath}`。

OpenCode 示例使用非交互的 `run` 命令，并把生成的请求作为文件附加。应配置
OpenCode 权限，使其只能写入分析输出目录。`--dangerously-skip-permissions`
可简化受信任本地项目的无人值守测试，但只应在项目和提示词均可信时添加。

相对路径形式的 `artifactRoots` 和 `outputDir` 从会话记录的项目目录解析。
显式配置时也允许使用绝对工件目录。`artifactFiles` 可以包含 `README.md`
或 `AGENTS.md` 等项目相对文件。分析文件使用有大小限制的快照，因此即使
原工件后续发生变化，分析证据仍可审查。

可以在设置页面直接编辑目标专用的 Analyzer 指令，也可以通过
`analysis.targets.<target>.prompt` 配置。`promptFile` 只是对已有文本文件的
可选引用；相对路径从 `config.json` 所在目录解析，OpenSessionViewer 不会
自动创建该文件。可以在设置页面点击 **预览实际提示词**，检查与运行时使用
相同的组合提示词模板；会话专用路径会显示为占位符。

无需在 `analysis.targets` 中额外配置即可使用以下内置分析目标：

- `skills`：可复用的 Agent Skills
- `prompts`：提示词文件与模板
- `agents`：Agent 定义与角色
- `docs`：文档目录
- `rules`：Agent/项目规则目录
- `tests`：测试、规格与 Fixtures
- `workflows`：CI 与仓库自动化
- `scripts`：项目脚本与命令行工具

设置页面会将这些目标显示为预设。`analysis.targets` 中的配置可以覆盖内置
目标，也可以定义其他自定义目标。

`analysis.defaultTargets` 控制会话页面初始勾选的目标。启动前可以选择任意
多个目标；OpenSessionViewer 会为每个目标创建一个独立运行，各自生成报告、
评估提案、工件提案、manifest 和校验结果，不会把多个目标混合到同一个输出
包中。旧的 `defaultTarget` 字段仍受支持，并作为已有配置的第一个默认选择。

默认情况下，分析任务写入 `session-index.json`、`evidence-index.json` 和
不可变的 `evidence.jsonl`，不会生成完整的 message/tree/container/flow/
trace 快照。只有旧 Analyzer 确实依赖这些大型诊断文件时，才应把
`analysis.includeRawSnapshots` 或目标级 `includeRawSnapshots` 设为 `true`。

可以在 `analysis.providers.<provider>.targets.<target>` 下覆盖某个
Provider 的目标配置，包括命令、提示词、shell、工件目录和扩展名。其他
自定义目标也可复用相同结构。

## Claude Code 历史记录

Claude Code Provider 同时读取旧版 `~/.claude/transcripts` 和当前
`~/.claude/projects/<project>/*.jsonl` 布局。OpenSessionViewer 不会修改这些文件。

Claude Code 会按照 `cleanupPeriodDays` 清理历史 JSONL，默认保留 30 天。
JSONL 被清理后，`~/.claude.json` 中可能仍保留项目元数据；此时页面会明确提示
“只有元数据”，但无法恢复已删除的对话。如果需要长期归档，请设置合适的正数
保留天数。

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
