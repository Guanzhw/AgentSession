# AgentSession

> 开发者的 AI 会话档案馆：把 OpenCode、Claude Code、Codex CLI、Gemini CLI、Pi 的本地会话集中到一个可搜索、可追踪、可复盘的 Web UI。

[English](./README.en.md) · [中文](./README.md)

![Node.js >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen?style=flat-square&logo=node.js)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime_deps-0-blue?style=flat-square)
![MIT License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)
![v1.7.0](https://img.shields.io/badge/version-1.7.0-orange?style=flat-square)

## 1.7.0 更新

- Pi 现已成为一等 Provider，支持分支树 JSONL、活动分支、fork 会话、reasoning、工具结果、Token Explorer、Flow、runtime extensions、恢复命令与 MCP 查询。
- MCP 默认诊断现在包含未安装的 Provider；`session_get` 返回首末消息预览，长事件返回可直接复用的 continuation 参数。

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 来源说明

AgentSession 基于 [OpenSession](https://github.com/HeavyBunny19C/OpenSession) 开发。这个项目保留了本地、多 Provider AI 会话浏览器的核心方向，同时迁移到 TypeScript，并继续推进更丰富的嵌套会话、调用链和系统提示可视化。

## 它现在是什么

AgentSession 是一个本地优先的 AI 编程会话查看器。它不会修改原始工具数据库，而是读取你机器上的会话记录，生成统一的仪表盘、搜索、详情页、统计页、导出和调用链视图。

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
| OpenCode | 完整支持 | `$XDG_DATA_HOME/opencode/opencode.db` 或 `~/.local/share/opencode/opencode.db` | 浏览、搜索、收藏、重命名、删除、回收站、导出、统计、Trace、嵌套会话、分析 |
| Claude Code | 可管理 | `~/.claude/transcripts/` + `~/.claude/projects/` | 浏览、搜索、收藏、重命名、删除、回收站、Token Explorer、ReACT、Trace、Flow、可用 transcript 的子 agent、分析提示词证据、分析 |
| Codex CLI | 可管理 | `~/.codex/sessions/**/*.jsonl` | 浏览、搜索、收藏、重命名、删除、回收站、Token Explorer、ReACT、Flow、嵌套子 agent、分析 |
| Gemini CLI | 可管理 | `~/.gemini/tmp/*/chats/*.json` | 浏览、搜索、收藏、重命名、删除、回收站、Token Explorer、ReACT、Flow |
| Pi | 可管理 | `~/.pi/agent/sessions/**/*.jsonl` | 浏览、搜索、收藏、重命名、删除、回收站、Token Explorer、ReACT、Flow、活动分支、fork 关系、runtime extensions |

想要新增 Provider？请阅读[新增 Provider 指南](./docs/CONTRIBUTING-PROVIDER.md)，其中包含适配器、MCP、测试和发布验收清单。

所有 Provider 都使用独立的本地元数据库保存收藏、自定义标题、软删除和永久排除状态，不会写回原始会话数据库或 transcript 文件。

## 主要功能

- **统一会话入口**：`/sessions` 在一个列表中展示所有已检测 Provider，并支持 Provider 多选、项目/时间筛选、排序和跨 Provider 无限滚动。会话始终保留 `(provider, sessionId)` 复合身份，详情页继续使用 Provider 所有的 canonical URL。
- **会话列表与搜索**：全局入口筛选 Provider 标题、viewer 自定义标题和目录；Provider 页面继续提供消息内容搜索、收藏和本地管理。标题类型筛选可将带有 analysis/analyze 信号的显示标题与其他会话分开；它是可逆的查看器启发式，不是 Provider 元数据。
- **详情页复盘**：按 Provider 保存的模型响应边界，把 reasoning、action/tool call 和 observation/tool result 组织在同一个 ReACT 回合中。
- **稳定的详情标签**：Overview、Conversation、Flow、Analysis 和 Raw data 共用稳定内容轨道；Conversation 目录栏淡入淡出，不会让标题、操作区和标签栏重新排版，并尊重系统减少动态效果偏好。
- **递归 Session Tree**：OpenCode、Codex、Pi，以及保存了 sidechain transcript 的 Claude Code child session 会被组织成嵌套结构；每个子会话还可独立打开。
- **Tool Flow Tree**：右侧 Flow 视图按时间和层级展示 root、message、tool、subagent 分支。
- **Table of Contents**：长会话自动生成可折叠导航，只索引用户消息、assistant 消息和 `task` / `subtask` / `spawn_agent` 子 agent。
- **会话内搜索**：可从详情页操作栏打开紧凑搜索，或按 `/` 聚焦；结果会同时显示匹配回合与文本命中数，逐词高亮，并在上下跳转时保持控制条可见。
- **System Prompts**：解析当前可用的 OpenCode 配置、agent markdown、AGENTS.md/CLAUDE.md 和 `instructions`，展示用户开始前可能进入系统上下文的内容来源。
- **Trace API**：暴露 step/span summary，聚合 tool、skill、agent、MCP、LSP 等调用。
- **统一用量入口**：`/stats` 使用同一份每日 Token 组成契约聚合所有已选 Provider；总量趋势图直接提供 Provider 筛选，来源卡片可在同一页面应用单 Provider 筛选或进入 Provider 专属明细。单 Provider 明细继续提供 Top 会话、周期对比、模型排名、按日下钻和可选费用估算。文件型 Provider 只展示 transcript 实际提供的维度，不伪造能力。
- **本地管理**：所有 Provider 都支持收藏、重命名、批量操作、软删除、回收站恢复和永久排除；这些操作只修改 viewer 元数据。
- **导出**：OpenCode 在详情页提供一个 Export 菜单，可选择 Markdown
  或 JSON 导出，JSON 包含 session tree。
- **中英双语**：通过 `--lang zh` 或 `--lang en` 指定界面语言。

## 安装

本项目当前支持以下安装方式：

### 方式一：下载单文件 binary（无需安装 Node.js）

从 [GitHub Releases](https://github.com/Guanzhw/AgentSession/releases) 下载对应平台压缩包，并用同一 Release 中的 `SHA256SUMS` 验证文件。每个压缩包包含：

- `agentsession` / `agentsession.exe`：Web Viewer；
- `agentsession-mcp` / `agentsession-mcp.exe`：只读 stdio MCP Server。

当前发布 Windows x64、Linux x64、Linux arm64 与 macOS arm64。binary 内嵌 Node.js runtime、Web 静态资源和 analysis helper，不依赖系统 Node.js 或源码目录。目前未提供商业代码签名，Windows SmartScreen 或 macOS Gatekeeper 可能要求用户确认本地下载的可执行文件。

### 方式二：安装 npm 包

```bash
npm install --global @acetamido/agentsession
agentsession
```

打开 http://localhost:3456 来访问主页

### 方式三：从源码运行

```bash
git clone https://github.com/Guanzhw/AgentSession.git
cd AgentSession
npm install
npm start
```

## 命令行参数

```text
agentsession [options]

--port <number>       服务端口，默认 3456
--opencode-db <path>  OpenCode 数据库路径，别名 --db
--claude-dir <path>   Claude Code 数据目录
--codex-dir <path>    Codex CLI 数据目录
--gemini-dir <path>   Gemini CLI 数据目录
--pi-dir <path>       Pi agent 数据目录
--config <path>       AgentSession JSON 配置文件
--disable-terminal-launch
                      禁止启动继续会话和分析命令
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
| `XDG_DATA_HOME` | OpenCode 的 XDG 数据根目录 |
| `CLAUDE_CONFIG_DIR` | Claude Code 数据目录 |
| `CODEX_HOME` | Codex CLI 数据目录 |
| `GEMINI_HOME` | Gemini CLI 数据目录 |
| `PI_CODING_AGENT_DIR` | Pi agent 数据目录，默认 `~/.pi/agent` |
| `AGENTSESSION_META_PATH` | AgentSession 元数据库路径 |
| `AGENTSESSION_CONFIG` | AgentSession JSON 配置文件路径 |
| `OPENSESSIONVIEWER_META_PATH` | 旧版兼容元数据库路径 |
| `OH_MY_OPENSESSION_META_PATH` | 更早版本兼容元数据库路径 |
| `OPENSESSIONVIEWER_CONFIG` | 旧版兼容 JSON 配置文件路径 |

## AgentSession-MCP：供 Coding Agent 查询会话历史

`@acetamido/agentsession-mcp` 是一个独立的 stdio MCP 包，供 Codex、Claude Code、Gemini CLI、OpenCode、Pi 等 MCP Host 查询本机已注册 Provider 的会话历史。它不启动 Web 服务、不绑定端口，也不会修改任何 Provider 数据。

```bash
npm install --global @acetamido/agentsession-mcp
agentsession-mcp --config /path/to/config.json
```

它只提供五个只读工具：`session_search`、`session_get`、`session_timeline`、`session_get_context` 与 `session_get_event`。默认搜索标题、消息正文和已记录的目录；以空白分隔的多个关键词必须全部命中，但不要求相邻。`session_search` 可用 `directory` 限定规范化后的项目路径，并用返回的 `nextCursor` 继续读取同一时间快照；默认搜索的 `diagnostics` 会列出所有已注册 Provider，包括未安装的 Provider。`session_get` 同时返回首条和末条可见消息预览，标题命中后通常无需先调用 timeline 才能取得 EventRef。普通搜索不会返回 reasoning；reasoning、tool input 与 tool output 均需要显式请求，并始终受服务端长度限制。截断的 `session_get_event` 内容会返回可直接用于下一次调用的 `continuation`/`continuations` 参数，直到 `nextOffset` 为 `null`。

使用相同的 AgentSession 配置文件即可复用 Provider 路径与元数据目录。可选的 MCP 输出上限如下；所有数值都有服务端硬上限：

```json
{
  "mcp": {
    "searchLimit": 20,
    "timelineLimit": 50,
    "eventMaxChars": 4000,
    "contextWindow": 5
  }
}
```

在 MCP Host 中注册时，使用 `agentsession-mcp` 命令和可选的 `--config` 参数即可。例如 Codex CLI：

```bash
codex mcp add agentsession -- agentsession-mcp --config /path/to/config.json
```

## 继续会话命令

会话详情页始终显示可复制的 session ID。当 Provider 有已知的继续命令，且
会话记录中的项目目录有效时，页面可以在终端中打开该命令。命令启动默认
启用。启动前，页面会在可复制的折叠面板中展示解析后的命令和工作目录；使用 `--disable-terminal-launch` 启动服务可隐藏并禁用继续会话和分析
操作。
启动时优先使用 Windows Terminal（`wt.exe`）；如果不可用，则直接打开已配置的
PowerShell Host。
API 会等待终端 Host 或 PowerShell wrapper 确认启动后才返回成功；如果 Host
无法启动，页面会显示错误，而不是弹出成功提示。运行时启动日志会记录所选 Host、
fallback 信息，以及可用时的 launcher PID。

所有已注册 Provider 都声明了默认继续命令：

| Provider | 默认命令 |
|---|---|
| OpenCode | `opencode --session {sessionId}` |
| Claude Code | `claude --resume {sessionId}` |
| Codex CLI | `codex resume {sessionId}` |
| Gemini CLI | `gemini --resume {sessionId}` |
| Pi | `pi --session {sessionId}` |

每个命令和 PowerShell 兼容终端 shell 都可以在 AgentSession 配置目录的
`config.json` 中覆盖，也可以通过 `--config` 指定文件：

```json
{
  "resumeCommands": {
    "opencode": {
      "executable": "opencode",
      "args": ["--session", "{sessionId}"]
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
`-EncodedCommand` 参数之前。未配置时，AgentSession 会依次查找
`pwsh.exe` 和 `powershell.exe`，并使用 `["-NoExit", "-NoLogo"]`。

## Web 设置

打开 `/:provider/settings`，例如
`http://127.0.0.1:3456/opencode/settings`，即可通过开关和表单管理分析功能、
目标路径、Provider 命令、继续会话命令和 PowerShell Host。页面会显示配置
文件的准确路径，并在保存前完成校验。底层 JSON 仍保留在折叠的高级设置中。

`analysis`、`resumeCommands` 和 `resumeShell` 的修改会立即应用到当前服务器。
端口、数据目录和 Provider 路径等配置会持久化，但需要重启后生效。
`allowTerminalLaunch` 有意保留为非 Web 配置权限。命令启动默认启用；使用
`--disable-terminal-launch` 启动 AgentSession 可对当前进程关闭该能力。

Token Explorer 不内置供应商价格表。若要显示费用估算，请在高级 JSON 配置中
按 `provider/model` 键填写每百万 Token 的价格；估算只在统计页筛选到单个模型时显示：

```json
{
  "tokenPricing": {
    "openai/gpt-5": {
      "currency": "USD",
      "inputPerMillion": 1.25,
      "outputPerMillion": 10,
      "cacheReadPerMillion": 0.125,
      "sourceLabel": "Vendor pricing page",
      "sourceUrl": "https://example.com/pricing",
      "asOf": "2026-07-13"
    }
  }
}
```

`currency` 必须是三个字母的货币代码；价格必须为非负有限数；`sourceUrl`
只能使用绝对 HTTP/HTTPS URL。未配置的 reasoning/cache 维度会明确标为未计价，
不会被静默当作零成本。请使用实际模型键和可信价格来源，并自行维护 `asOf` 日期。

## 运行时日志

AgentSession 会在 metadata 目录下写入 append-only JSONL 运行时事件：

```text
<metadata-dir>/logs/runtime-YYYY-MM-DD.jsonl
```

日志记录服务器启动、Provider 索引、HTTP 路由模式与状态码、元数据修改、设置保存、
终端启动，以及分析任务 prepare/launch 事件。为了本地诊断，启动事件可能包含工作
目录路径。日志有意不记录请求体、会话全文、prompt、工具输出、完整命令参数、
cookie、token 或 secret。单个分析任务的 stdout/stderr 与证据快照仍保存在该 run
自己的 `diagnostics/` 目录中。

## 会话分析与评估提案

AgentSession 可以从声明支持会话分析的 Provider 详情页以非交互方式启动
已配置的 Analyzer，目前包括 OpenCode、Claude Code 和 Codex CLI。其他 Provider 在适配器
声明同等能力前继续保留只读浏览能力。分析任务只生成提案：它会把会话保存为带索引的 JSONL 证据、保存
选定工件快照、创建评估种子，并要求 Analyzer 输出：

- `report.md`：主要的、面向人的分析结果
- `evaluation-proposals.json`：包含回放、留出和回归用例的验证计划
- `artifact-proposals.json`：建议的目标修改，也可能是空提案列表。单个提案
  可以用 `kind: "skill-evolution"` 表示这是有证据支持的未来 Agent 技能、
  指令或 harness 指南更新。

这三个文件是最终分析产物。`session-index.json`、`evidence-index.json`、
`evidence.jsonl`、`artifacts.json` 和 `manifest.json` 等文件属于支持证据和
诊断数据。已完成运行会在会话的 **分析活动** 面板中显示直接打开和下载链接。

运行中、失败或校验无效的任务还会在同一面板中提供可用的 Analyzer stdout/stderr 日志，
以及可复制的 PowerShell Analyzer 命令。

分析输入会明确分成三类：

- **会话证据**：标准化后的对话、工具结果、系统提示词记录和其他会话数据。
- **分析材料**：由所选目标配置、与 Provider 无关的原始输入，例如文档、
  测试、提示词素材、脚本或显式外部引用文件。
- **运行时扩展**：由 Provider 解析的指令和行为，包括 `AGENTS.md`、
  `CLAUDE.md`、`GEMINI.md`，以及技能、Agent、命令、插件、Hook、工具和规则。

启动前，AgentSession 会解析当前本地 Provider 运行时扩展，并自动采集
默认选中的项目级和用户级指令、Skills、Agents、Commands、Plugins、Hooks、
Tools、Rules 或扩展包中可采集的部分。扩展类型、搜索路径和优先级仍由各
Provider 负责。大多数 transcript 不包含不可变的历史扩展清单，因此这里表示
“当前本地解析结果”，不会声称精确还原会话开始时加载的环境。每个捕获的工件
都会记录其对应的运行时扩展 ID。

会话详情页会把启动动作放在同一行：**在终端中继续** 和 **分析所选项** 并列
显示。下方的分析选择器使用类似 inventory 的二维网格：行表示来源范围，例如
分析目标、项目级运行时和用户级运行时；列表示材料类型，例如 Skills、Prompts、
Agents、Rules 和其他输入。启动前，摘要会显示已选目标数量和运行时扩展数量。

新运行会按用途组织这些文件：

```text
<run>/
├── manifest.json
├── outputs/
│   ├── report.md
│   ├── evaluation-proposals.json
│   ├── artifact-proposals.json
│   └── implementation-result.json # 实现 run 请求写入
├── inputs/
│   ├── session.json
│   ├── evaluation-seed.json
│   ├── analysis-request.md
│   └── accepted-proposals.json    # 用户批准后写入
├── evidence/
│   ├── session-index.json
│   ├── evidence-index.json
│   ├── evidence.jsonl
│   ├── artifacts.json
│   └── artifact-snapshots/
└── diagnostics/
    ├── analyzer.stdout.log
    ├── analyzer.stderr.log
    ├── messages.json            # 仅 raw snapshot 受 includeRawSnapshots 控制
    ├── tree.json
    ├── container.json
    ├── metrics.json
    ├── flow.json
    └── trace.json
```

旧版平铺运行目录仍可读取。

生成的评估用例初始状态为 `status: "proposed"`。AgentSession 不会直接
修改 Skill，也不会把提案标记为已验证。只有在基线版本与候选版本通过重放、
留出和回归测试后，才应提升候选工件。

Analyzer 退出后，AgentSession 会自动检查输出结构，要求同时包含重放、
留出和回归用例，依据工件清单验证提案根目录与路径，解析每个 `ev:...` 与
`artifact:...` 引用，并要求显式描述基线/候选预期以及 token/runtime 标准，
最后将 `manifest.json` 状态更新为 `completed`、`invalid` 或 `failed`。

会话页面包含一个 **分析活动** 面板。分析运行期间页面会自动轮询，结束后
显示权威的 manifest 状态、进程退出码、提案数量、校验错误和本地运行目录。
启动 Toast 只表示命令已经发起；是否真正成功应以分析活动面板为准。

Analyzer 首先读取紧凑的会话层级与证据索引，而不是单个大型会话 JSON。
生成的分析请求提供以下只读命令。CLI 输出使用紧凑 Markdown，同时保留精确的
证据 ID 与工件 ID，供后续查询和校验使用：

- `session_main_info`
- `session_query_system_prompts`
- `session_query_context`
- `session_query_errors`
- `session_query_tools`，使用 `status: "completed"` 获取正样本
- `session_find_anomalies`
- `session_get_evidence`
- `extension_list`
- `extension_get`
- `artifact_list`
- `artifact_get`

`extension_*` 用于查询已捕获的 OpenCode 运行时上下文；`artifact_*` 用于查询
由已配置分析材料和自动采集的运行时扩展共同生成的有界快照。
`runtimeExtensionIds` 字段会标识来自运行时上下文的快照。

用户中断信号来自明确的工具错误原因。“高错误率”仍是透明的启发式判断：
结果会返回阈值、最小工具调用样本数、原始计数、错误率和完整排序。Analyzer
在提出修改前还必须对比成功与失败的执行结果。

会话分析与继续命令共用启动时的命令启动设置。该能力默认启用，也可以使用
`--disable-terminal-launch` 关闭；分析仍需要显式启用。OpenCode 自带默认
Analyzer 命令，也可以覆盖：

```json
{
  "analysis": {
    "enabled": true,
    "defaultTarget": "skills",
    "outputDir": ".agentsession/analysis",
    "includeRawSnapshots": false,
    "shell": {
      "executable": "powershell.exe",
      "args": ["-NoExit", "-NoLogo", "-NoProfile"]
    },
    "implementation": {
      "command": {
        "executable": "opencode",
        "args": [
          "run",
          "读取附加的实现请求并实现已接受的提案。",
          "--model", "deepseek/deepseek-v4-flash",
          "--dir", "{projectPath}",
          "--file", "{implementationPromptPath}"
        ]
      }
    },
    "targets": {
      "skills": {
        "label": "分析 Skills",
        "fileExtensions": [".md", ".json", ".yaml", ".yml", ".js", ".ts", ".py"],
        "promptFile": "prompts/analyze-skills.md"
      },
      "docs": {
        "artifactRoots": ["docs"],
        "artifactFiles": ["README.md"],
        "fileExtensions": [".md", ".mdx", ".txt"]
      }
    },
    "providers": {
      "opencode": {
        "targets": {
          "skills": {
            "prompt": "优先分析影响所选会话的可复用技能。"
          }
        },
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
      }
    }
  }
}
```

命令支持 `{sessionId}`、`{projectPath}`、`{target}`、`{runId}`、
`{runDir}`、`{sessionPath}`、`{sessionIndexPath}`、
`{evidenceIndexPath}`、`{evidencePath}`、`{accessManifestPath}`、
`{analysisToolPath}`、`{promptPath}`、`{reportPath}`、
`{evaluationSeedPath}`、`{evaluationPath}`、`{proposalsPath}` 和
`{artifactsPath}` 占位符。
实现命令还支持 `{implementationPromptPath}`、`{acceptedProposalsPath}` 和
`{implementationResultPath}`。
也可以使用 `{prompt}` 将完整提示词作为一个参数传入，但大体积会话更适合
使用 `{promptPath}` 或 `"stdin": "prompt"`。只有启用
`includeRawSnapshots` 进行调试或兼容旧 Analyzer 时，才应使用
`{messagesPath}`。

OpenCode 示例使用非交互的 `run` 命令，并把生成的请求作为文件附加。应配置
OpenCode 权限，使其只能写入分析输出目录。`--dangerously-skip-permissions`
可简化受信任本地项目的无人值守测试，但只应在项目和提示词均可信时添加。

当 run 以 `manifest.validation.ok === true` 完成且至少包含一个已校验的提案
后，会话页可以启动实现 run。点击 **实现已接受的提案** 是第一版用户
批准门：它会写入包含已接受提案 ID 和完整提案记录的
`inputs/accepted-proposals.json`，再写入 `inputs/implementation-request.md`，
把配置的实现命令指向该请求，并要求 Agent 只实现已接受的提案。若该 run 带有
`inputs/analysis-access.json`，请求也会指向它，让实现阶段沿用相同的有界
文件优先证据接口。Agent 应写入 `outputs/implementation-result.json`、完成
验证并留下供人工 review 的结果；它不会自动合并。

相对路径形式的 `artifactRoots` 和 `outputDir` 从会话记录的项目目录解析。
显式配置时也允许使用绝对工件目录。`artifactFiles` 可以包含 `README.md`
等项目相对文件或绝对外部引用文档。`.opencode/skills`、`.claude/skills`、
`~/.claude/skills`、`AGENTS.md` 和 `CLAUDE.md` 等 Provider 运行时路径不应
在这里重复配置；Provider Adapter 会将它们解析为运行时扩展。分析文件使用
有大小限制的快照，因此即使原始材料后续发生变化，分析证据仍可审查。
`fileExtensions` 仅用于筛选这些分析材料目录中的文件名后缀；已有配置中的
旧字段 `extensions` 仍继续兼容。
历史内置配置或文档示例中精确匹配的混合路径会在加载时被标准化，并在下次
保存设置时移除；其他自定义路径保持不变。

未配置 `analysis.outputDir` 时，run 默认写入会话项目下的
`.agentsession/analysis`。AgentSession 会写入
`.agentsession/.gitignore`，即使目标项目尚未忽略该目录，生成的 run 也不会
进入版本控制。已有的 `.opensessionviewer/analysis` run 仍会继续被发现以保持兼容。
每个 run 都会在自己的 `tools/` 目录中携带只读 evidence 查询工具及其本地依赖，
因此 Analyzer 不需要读取 AgentSession 的安装目录。显式绝对 `outputDir`
仍受支持，但如果 Analyzer 采用仅允许访问项目目录的 sandbox，该目录也必须对
Analyzer 可见。

可以在设置页面直接编辑目标专用的 Analyzer 指令，也可以通过
`analysis.targets.<target>.prompt` 配置。`promptFile` 只是对已有文本文件的
可选引用；相对路径从 `config.json` 所在目录解析，AgentSession 不会
自动创建该文件。可以在设置页面点击 **预览实际提示词**，检查与运行时使用
相同的组合提示词模板；会话专用路径会显示为占位符。

无需在 `analysis.targets` 中额外配置即可使用以下内置分析目标：

- `skills`：所选 OpenCode 运行时 Skills
- `prompts`：提示词文件与模板
- `agents`：所选 OpenCode 运行时 Agent 定义与角色
- `docs`：文档目录
- `rules`：所选 OpenCode 运行时指令与规则
- `tests`：测试、规格与 Fixtures
- `workflows`：CI 与仓库自动化
- `scripts`：项目脚本与命令行工具

设置页面会将这些目标显示为预设。`analysis.targets` 中的配置可以覆盖内置
目标，也可以定义其他自定义目标。

`analysis.defaultTarget` 控制会话页面启动分析时使用的单个目标。旧配置中的
`defaultTargets` 数组仍会被接受，但只使用第一个有效目标。

设置页面会编辑 `analysis.providers.<provider>.targets.<target>` 覆盖。每个目标
会明确显示默认使用的 Provider 无关分析材料根目录、显式文件和后缀筛选；会话
页面会把这些目标和 Provider 解析出的运行时扩展一起放进 inventory 选择器中，
但生成分析包时这两类输入仍保持分离。Provider 运行时上下文会在启动时自动解析。
点击 **恢复默认值** 时，会尽可能删除 Provider 专用差异，使该值重新继承
`analysis.targets` 或内置目标。

默认情况下，分析任务写入 `evidence/session-index.json`、
`evidence/evidence-index.json` 和不可变的 `evidence/evidence.jsonl`，
`diagnostics/` 目录始终包含 Analyzer stdout/stderr 日志。只有旧 Analyzer
确实依赖大型诊断快照时，才应把 `analysis.includeRawSnapshots` 或目标级
`includeRawSnapshots` 设为 `true`。

可以在 `analysis.providers.<provider>.targets.<target>` 下覆盖 Provider 的目标
配置，包括提示词、工件目录和文件后缀筛选。其他自定义目标也可复用相同结构。
面向编码 Agent 的其他 Provider 分析能力实现指南见
[`docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md`](./docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md)。

## Claude Code 历史记录

Claude Code Provider 同时读取旧版 `~/.claude/transcripts` 和当前
`~/.claude/projects/<project>/*.jsonl` 布局。AgentSession 不会修改这些文件。

Claude Code 会按照 `cleanupPeriodDays` 清理历史 JSONL，默认保留 30 天。
JSONL 被清理后，`~/.claude.json` 中可能仍保留项目元数据；此时页面会明确提示
“只有元数据”，但无法恢复已删除的对话。如果需要长期归档，请设置合适的正数
保留天数。

## 架构概览

```text
bin/
└── cli.ts                  # CLI 入口，先初始化配置再加载服务
src/
├── providers/
│   ├── interface.ts       # ProviderAdapter 接口
│   ├── kinds.ts           # Provider capability 判断
│   ├── index.ts           # Provider 注册表
│   ├── shared/            # 与具体 schema 无关的共享 Provider 工具
│   ├── opencode/          # OpenCode SQLite 适配器与结构化视图
│   ├── claude-code/       # Claude Code JSONL 适配器
│   ├── codex/             # Codex CLI JSONL 适配器
│   ├── gemini/            # Gemini JSON 适配器
│   └── pi/                # Pi 分支树 JSONL 适配器
├── db.ts                  # OpenCode-compatible DB 查询
├── meta.ts                # 收藏、重命名、删除等本地元数据
├── index-db.ts            # 跨 Provider 会话索引
├── config.ts              # CLI、环境变量与 JSON 配置
├── resume.ts              # 结构化继续会话命令
├── analysis*.ts           # 证据快照、查询、执行与验证流水线
├── server.ts              # HTTP API 与 SSR 页面
├── views/                 # 服务端渲染模板
├── static/                # 原生前端 JS/CSS，构建时复制到 dist
└── locales/               # 中英文文案
scripts/
├── copy-static.mjs        # 复制静态资源
└── qa-agent-browser.*     # Live E2E QA
test/
└── core.test.mjs          # Provider、分析、配置和渲染回归测试
```

详细的模块边界、代码约定、验证矩阵和本地服务操作见
[AGENTS.md](./AGENTS.md)。新增 Provider 时同时参考
[Provider 贡献指南](./docs/CONTRIBUTING-PROVIDER.md) 和
[`docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md`](./docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md)，以及
`src/providers/interface.ts`；接口源码是最终契约。

## 验证

基础验证：

```powershell
npm run typecheck
npm test
```

涉及页面、静态资源、Provider 展示或 API 行为时，先构建并重启本地服务：

```powershell
npm run build
node dist/bin/cli.js
```

然后使用一个真实、包含 reasoning/tool/subagent 数据的 OpenCode Session
运行浏览器 E2E：

```powershell
$env:OPENSESSIONVIEWER_QA_BASE_URL = 'http://127.0.0.1:3456'
$env:OPENSESSIONVIEWER_QA_SESSION_ID = '<real-session-id>'
npm run qa:e2e
```

E2E 覆盖：

- dashboard、session list、search、stats、session detail
- settings、recursive session tree、TOC、Flow、reasoning 与 token 渲染
- JSON/Markdown 导出
- 默认关闭的终端启动入口
- browser/page errors 收集

会话分析不能只看外部 analyzer 的退出码。最终成功条件是对应 run 的
`manifest.json` 同时满足 `state: "completed"` 和
`validation.ok: true`，并通过 evidence 引用、输出 schema、路径边界与
SHA-256 完整性检查。

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

[x] **Token Explorer**
   - 将统计面板升级为交互式 Token Explorer，支持过滤、多系列趋势、模型排名、会话排行和数据覆盖信息。

## 开发

要求 Node.js `>= 22.13.0`。项目使用 TypeScript ESM、Node 内置测试运行器和
原生浏览器 JavaScript/CSS，并保持零 runtime npm dependencies。

```powershell
npm install
npm run typecheck
npm test
npm start
```

常用命令：

| 命令 | 说明 |
|:---|:---|
| `npm run typecheck` | 仅执行 TypeScript 检查，不生成文件 |
| `npm run build` | 编译 `bin/`、`src/`，并复制 `src/static/` 到 `dist/` |
| `npm test` | 先构建，再运行 `test/*.test.mjs` |
| `npm start` | 构建并启动 `127.0.0.1:3456` |
| `npm run dev` | 构建、启动并打开浏览器 |
| `npm run qa:e2e` | 对已运行的本地服务执行 `agent-browser` E2E |

开发时只修改源码目录，不要直接编辑 `dist/`。Provider 原始数据库和 transcript
保持只读；收藏、重命名、软删除与永久排除状态写入独立的 viewer 元数据库。
配置、Provider capability、渲染语义、分析输出和测试要求详见
[AGENTS.md](./AGENTS.md)。

## License

MIT
