# AgentSession

AgentSession 是本地优先、只读的 harness runtime inspector。它从 OpenCode、Claude Code、Codex CLI、OpenClaw、Hermes Agent、Pi 和 DeepSeek Harness 的本地记录中重建：harness 如何运行、如何派生 session、如何调度工作，以及上下文如何被加载、压缩、继承和重新注入。

对话仍然是兼容的阅读投影，但不是唯一的结构模型。所有 Provider 原始数据库、transcript 和事件日志都保持只读；收藏、自定义标题和排除状态写入独立的 AgentSession 元数据。

[English](./README.en.md) · [中文](./README.md)

![Node.js >= 22.15.0](https://img.shields.io/badge/node-%3E%3D22.15.0-brightgreen?style=flat-square&logo=node.js)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime_deps-0-blue?style=flat-square)
![MIT License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)

## Work Graph

session 详情页固定为 `Work Graph | Conversation | Overview | Raw`，并默认打开 Work Graph。每个可读 session 都显示 Work Graph，并按协议证据降级；不会把“不支持”“不可用”“缺失”“无效”渲染成观测到的零值。

Work Graph 提供五个服务端派生 lens：

- **Work**：目标、Task、依赖关系，以及 Task 与每次 AgentRun 的明确关联。
- **Execution**：参与者、运行尝试和当前 session 的请求用量；继承或共享的 input/cacheRead 仍归属发生它的真实请求并计一次，不会因共享上下文而在跨请求间去重（同一共享上下文在不同请求中的 cacheRead 各自计费一次）；继承的已存历史本身不另造一条新请求。
- **Coordination**：已记录的协调观察，以及 parent、spawned、forked、continued、compacted-into、scheduled-run-of 和 handed-off 等 canonical session 关系。
- **Context**：压缩结果、上下文版本和 memory、experience、user-info 等带 scope 的产物，并区分 direct、inherited 和 shared 来源。
- **Evidence**：按来源顺序分页的标准化事件、协议状态、诊断和 provenance。

### Session Protocol v2 与 v3

每个注册 Provider 都为每个可读 session 提供 `getSessionProtocol()`。协议边界使用 canonical composite `SessionRef`：`{ provider, sessionId }`；Provider 自己的 session ID 始终保留。

v2 snapshot 包含：

- `version: 2`、session descriptor（state、origin、created/updated、cwd、harness、terminal outcome、fork seed boundary、inherited event count）；
- dense source-order `events`，带 `category`、`normalizedKind`、turn/step/correlation anchors 和 `provenance`；
- typed session relationships、`tasks`、`agentRuns`、metadata-first `contextArtifacts` 和可选的 in-file `branches`；
- `validation`、`completeness` 和 provider `revision`。

事件的常见 category 是 `session`、`message`、`model`、`reasoning`、`tool`、`task`、`run`、`context`、`control`、`team` 和 `unknown`。`recorded` 表示来源直接记录，`derived` 表示适配器根据来源证据重建；两者不会混写。校验器检查序列稠密性、实体唯一性、引用完整性、Task/AgentRun 分离、lineage 冲突和 capability 声明。

只要来源没有保存事实，适配器就不会发明 child session、隐藏 prompt、context 正文或 lifecycle。in-file message branch 是 branch topology，不会伪造成跨 session 关系。

Session Protocol v3 在同一 canonical session 边界上增加 Work、Execution、Coordination 和 Context 四个领域，以及 request usage 的 direct、inherited、shared 来源切片。当前共享升级层保留 v2 事实并把未记录的 v3 覆盖状态标为 unknown；Provider 可以逐步提供原生 v3 证据，浏览器端不会推断 Provider 语义。

## Read-only HTTP API

以下 API 都是 `GET`，返回 bounded、服务端归一化的 JSON：

```text
GET /api/:provider/session/:id/protocol
GET /api/:provider/session/:id/runtime/summary
GET /api/:provider/session/:id/runtime/events?cursor=&limit=&category=&kind=&phase=&correlationId=
GET /api/:provider/session/:id/runtime/graph?depth=&maxNodes=
GET /api/:provider/session/:id/runtime/work?maxItems=
GET /api/:provider/session/:id/runtime/execution?maxItems=
GET /api/:provider/session/:id/runtime/coordination?maxItems=
GET /api/:provider/session/:id/runtime/context?maxItems=
```

完整 `/protocol` 返回 v2 snapshot、capability descriptors、validation 和可用的 storage diagnostic。四个领域 API 返回有界的 v3 投影；`events` 使用 cursor/limit，`graph` 使用 depth/maxNodes。响应会报告 truncation、缺失 session、不可用 Provider 和校验诊断。未知 session 返回 404；已知但不完整或无效的 session 保留诊断，不会被伪装成完整结果。

## Provider coverage

七个已注册 Provider 都覆盖 Session Protocol v2。能力表区分来源记录和适配器派生的事实；`partial` 不等于来源原生保存。

| Provider | 生命周期 | 本地来源 | Protocol fidelity 与覆盖 |
|:---|:---|:---|:---|
| OpenCode | active | `$XDG_DATA_HOME/opencode/opencode.db` 或 `~/.local/share/opencode/opencode.db` | `partial/derived` messages/parts 事件；原生 child/session 记录支持关系、Task、AgentRun。 |
| Claude Code | active | `~/.claude/transcripts/`、`~/.claude/projects/` | `partial/derived` transcript、compact 边界和 sidechain/task-notification 证据。 |
| Codex CLI | active | `~/.codex/sessions/**/*.jsonl` | `full/recorded` response/item、工具和 compaction；`partial/derived` NEW_TASK 关系、Task、AgentRun。 |
| OpenClaw | active — JSONL reader (legacy/archive); 最新 SQLite refresh pending | `~/.openclaw/agents/*/sessions/*.jsonl`（legacy/archive）；最新 upstream 主存储为 `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | `partial/derived` branch、reasoning、工具和 registry lineage；无来源证据不创建 child。 |
| Hermes Agent | active | `$HERMES_HOME/state.db` | `full/recorded` SQLite 事件；`partial/derived` 压缩延续/delegation lineage，压缩不是 spawned。 |
| Pi | active | `~/.pi/agent/sessions/**/*.jsonl` | `full/recorded` branch/compaction 和 `partial/derived` parent lineage；不虚构 spawn。当前 upstream package/repo 已迁移到 `@earendil-works/pi-coding-agent`（官方 session format v3），现有 reader 需持续对 v3/当前版本验证。 |
| DeepSeek Harness | active preview | `$DSH_HOME/sessions/**/session.jsonl[.zstd]` 或 `~/.dsh/sessions/**` | `full/recorded` v0 event/context；`partial/derived` workflow、team 和跨 session 关系。 |

当前 Provider 也提供消息搜索、token 统计、导出和只修改 AgentSession 元数据的本地管理。Runtime Environment 与 system-prompt evidence 仍是独立的只读能力：只展示可解析的本地来源，不声称恢复隐藏 prompt。
未检测到的安装会显示为 unavailable 并保留 Provider diagnostic，不会被报告为空的成功来源。

## DeepSeek Harness compatibility

DSH 适配器当前兼容 **alpha.3 snapshot**（不等同于最新版本）；项目策略是跟随最近的 alpha/official HEAD（稳定 rc 不作为“最新预览”依据）。当前兼容快照为 commit `dd6322d604e00eec1ba5e0c8541159906a21094a`、tag `dsh-v0.1.2-alpha.3`、package `@deepseek-ai/dsh@0.1.2-alpha.3`，session format version `0`。Upstream alpha.5 与官方 HEAD 的 refresh **pending**（见 evidence-matrix freshness snapshot）。

JSONL 是当前主支持后端，支持 raw `.jsonl`、multi-frame `.jsonl.zstd` 和 packed `text-chunks`、`reasoning-chunks`、`tool-call-chunks`。alpha.3 的 range-encoded `sourceEventSeqs` 会在 Provider 边界统一解码。适配器保留 zero-based source sequence、`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`request/header` 与 `request/context`、surface/source-event citations、`session/end-seed`、fork `parentSession`/`seedLength`、compaction、cancellation/interruption、workflow/subagent、`agent/inbox/spliced` 和 Agent Teams `team/member`、`team/task`、`team/message/queued`、`team/message/delivered`。alpha.3 还记录 `model/selection`、`subagent/model-selection-policy`、`session-log-deepseek/delivery-accepted`。这些属于 control/model/delivery facts，不会变成普通 conversation message。

alpha.3 已移除 SQLite persistence backend。检测到遗留 schema 17 store 时仍会明确显示 **unsupported backend/schema diagnostic**；它不会静默消失，也不会被当作空 Provider。官方 headless CLI 没有声明默认 resume 参数，因此 AgentSession 不伪造 DSH resume 命令。

## Installation

需要 Node.js `>= 22.15.0`。也可以使用 GitHub Releases 中的 standalone binary。

```bash
npm install --global @acetamido/agentsession
agentsession
```

源码运行：

```bash
git clone https://github.com/Guanzhw/AgentSession.git
cd AgentSession
npm install
npm start
```

服务只监听 loopback，默认地址为 `http://127.0.0.1:3456`。

## CLI

```text
agentsession [options]

--port <number>       服务端口（默认 3456）
--opencode-db <path>  OpenCode 数据库
--claude-dir <path>   Claude Code 数据目录
--codex-dir <path>    Codex CLI 数据目录
--pi-dir <path>       Pi agent 数据目录
--dsh-dir <path>      DeepSeek Harness 数据目录（默认 $DSH_HOME 或 ~/.dsh）
--openclaw-dir <path> OpenClaw state 目录
--hermes-dir <path>   Hermes Agent 数据目录
--config <path>       AgentSession JSON 配置
--disable-terminal-launch  禁止 resume command 启动
--reindex             启动时重建索引
--lang <en|zh>        界面语言
--open                启动后打开浏览器
-h, --help            显示帮助
```

终端启动只用于用户明确请求的 provider resume command。命令由结构化 executable/args/cwd 组成，并受 loopback、same-origin 和 `--disable-terminal-launch` 约束；AgentSession 不提供写入 Provider 数据的终端控制面。

## Configuration

用户配置文件默认为元数据目录下的 `config.json`，也可以用 `AGENTSESSION_CONFIG` 或 `--config` 指定。项目目录映射现在是顶层 `projectPaths`，不是 Provider 私有的旧嵌套设置：

```json
{
  "projectPaths": {
    "codex": {
      "opaque-project-key": "C:\\work\\project"
    }
  },
  "resumeCommands": {
    "claude-code": {
      "executable": "claude",
      "args": ["--resume", "{sessionId}"]
    }
  },
  "resumeShell": {
    "executable": "powershell.exe",
    "args": ["-NoLogo", "-NoProfile"]
  }
}
```

`projectPaths.<provider>` 的 key 必须是来源提供的稳定 opaque project key，value 必须是已存在的绝对目录；AgentSession 不猜测或写回该映射。`resumeCommands` 只覆盖 resume 命令，`resumeShell` 只定义受信任的本地宿主。`allowTerminalLaunch` 是启动时开关，不写入保存配置。

常用环境变量：`PORT`、`AGENTSESSION_DB_PATH`、`XDG_DATA_HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_HOME`、`HERMES_HOME`、`PI_CODING_AGENT_DIR`、`DSH_HOME`、`AGENTSESSION_META_PATH`、`AGENTSESSION_CONFIG`。

## AgentSession-MCP

`@acetamido/agentsession-mcp` 是独立的 read-only stdio MCP server。它查询 Provider 本地仍存在的 session，不写入 Provider 数据，也不受 Viewer 隐藏或排除元数据影响。工具边界是 `session_search`、`session_get`、`session_timeline`、`session_get_context` 和 `session_get_event`；返回内容带有长度上限和不可信来源边界。

```bash
npx --yes --prefer-online @acetamido/agentsession-mcp@latest install
```

## Development and verification

```bash
npm run typecheck
npm test
npm run build
```

真实数据验证应检查 `/api/providers`、一个代表性 session 的 `/protocol` 和四个 Runtime API，并在桌面与 390px viewport 运行 `npm run qa:e2e`。请使用 [provider contribution guide](./docs/CONTRIBUTING-PROVIDER.md) 添加 Provider；协议规格位于 [`docs/specs/runtime-protocol-workbench/`](./docs/specs/runtime-protocol-workbench/)。

## License

MIT
