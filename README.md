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
| OpenCode | active | `$XDG_DATA_HOME/opencode/opencode.db` 或 `~/.local/share/opencode/opencode.db` | `partial/derived` message/part 事件；原生 child/session 关系、todo Task、subtask/compaction 事件与 task background AgentRun（官方 1.18.27；本机 1.17.11）。 |
| Claude Code | active | `~/.claude/transcripts/`、`~/.claude/projects/` | `partial/derived` transcript、`system/compact_boundary`（`compactMetadata`）和 sidechain/task-notification 证据；官方 npm latest 2.1.259 / upstream 已核验，本机 2.1.207，暂无 live 2.1.259 transcript。 |
| Codex CLI | active | `~/.codex/sessions/**/*.jsonl`、冷文件 `*.jsonl.zst` | `full/recorded` response/item、工具、compaction 和当前 `token_usage_record`；`inter_agent_communication` 只进入 Runtime v3 actors/coordination，不改变线性 transcript；`partial/derived` NEW_TASK 关系、Task、AgentRun。`close_agent` 归一化为 `interrupt`；本机 0.152.1 仍主要写旧 `token_count`/collaboration 形状，官方 0.153.0 release 与当前源码 HEAD 已验证新形状。 |
| OpenClaw | active — current SQLite（含 legacy/archive JSONL 回退） | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`（agent schema 19，2026-09-03 验证）；legacy/archive `sessions/*.jsonl` | `partial/derived` branch/window 代数、reasoning、工具、session_nodes parent/spawn/fork lineage；无来源证据不创建 child。Task/Run 为 `none`：current 与 legacy 构建器恒返回空数组，无已验证映射。 |
| Hermes Agent | active | `$HERMES_HOME/state.db` | `full/recorded` active-only SQLite transcript、异步 delegation handle/state；`partial/derived` 压缩延续/delegation lineage 与 metadata-only compaction，压缩不是 spawned。当前 freshness provenance：release peeled commit `29112bef…`（annotated tag object `6e8f8418…`），独立 HEAD `7b72fd12…`。 |
| Pi | active | `~/.pi/agent/sessions/**/*.jsonl` | `full/recorded` branch/compaction 和 `partial/derived` parent lineage；不虚构 spawn。当前 upstream 为 `@earendil-works/pi-coding-agent`（npm 0.84.4 / repo `earendil-works/pi-mono`,HEAD `4e69b0c2…`,官方 session format **v3**,2026-09-03 验证）；v3 读到 custom 角色消息、记录 retainedTail/fromHook 证据、token 总量按 Pi billed session total（全部记录条目：assistant + toolResult + compaction/branch_summary 的已记录 totalTokens，含 abandoned/history 分支，retainedTail 副本不重复计）；嵌套 `run-N/session.jsonl` 为 pi-subagents 产物（无 parentSession，不作 lineage）。 |
| DeepSeek Harness | active preview | `$DSH_HOME/sessions/**/session.jsonl[.zstd]` 或 `~/.dsh/sessions/**` | `full/recorded` v0 event/context；`partial/derived` workflow、team 和跨 session 关系。 |

当前 Provider 也提供消息搜索、token 统计、导出和只修改 AgentSession 元数据的本地管理。Runtime Environment 与 system-prompt evidence 仍是独立的只读能力：只展示可解析的本地来源，不声称恢复隐藏 prompt。
未检测到的安装会显示为 unavailable 并保留 Provider diagnostic，不会被报告为空的成功来源。

## OpenClaw current SQLite compatibility

OpenClaw 自 2026.7.2-beta.1 起把 session/transcript 主存储迁入每 agent 的 SQLite（agent schema 至 19）；`sessions/*.jsonl` 与 `sessions.json` 是 legacy/archive（doctor 迁移输入）。AgentSession 当前实现（2026-09-03 验证）：

- 主存储：`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`（只读打开，支持 WAL 快照签名），canonical session id = `session_nodes.session_key`（如 `agent:main:main`）；`session_windows` 是 transcript 代数（`previous_session_id` + `reason`：initial/reset/rollover/fork/rewind/switch/recovery/compaction），展示层只暴露 live 窗口并记录代数链（`metadata.windowLineage`，有界 20）。
- `transcript_events.event_json` 与 legacy JSONL record 同形，parser 复用不变；active path 直接由 raw events 计算（`session_transcript_active_events` 是派生投影，不可依赖）。
- Protocol 关系只来自记录的字段：`parent_session_key` 产生 `parent` 边，`spawned_by` 产生 `spawned` 边（两者不同时都发出，相同时去重为 `parent`）；tree/family 视图使用已记录的 structural-parent 优先级。
- legacy JSONL 保持可读；与 SQLite 暴露同一 canonical session（任意代数 window id，或 registry sessionKey）时以 SQLite 表示为准，恰好一次，不重复计数。覆盖按 agent 限定：另一 agent 记录的相同 id 不会隐藏本 agent 的 legacy session；被覆盖的旧代数 window id 仍可解析到 canonical session。
- 诊断：current SQLite / legacy-only JSONL / unsupported schema（版本 >19 或形状缺失）/ unreadable（损坏/权限）/ unavailable（无 agents 目录）状态显式区分；单个 agent 坏库不隐藏其余 agent 的可用数据。
- 验证基线：官方 HEAD `f92a12c5…` 与 release `v2026.8.2`（schema SQL 字节一致，sha256 `54fa65dc…`，agent schema 19）。本机安装 2026.7.1-2 为 pre-flip，无当前格式数据目录，真实本地数据验证未完成（已显式记录，不当作成功）。

## DeepSeek Harness compatibility

DSH 适配器当前兼容 **alpha.5 snapshot**；项目策略是跟随最近的 alpha/official HEAD（稳定 rc 不作为“最新预览”依据）。当前兼容快照为 tag `dsh-v0.1.2-alpha.5`、commit `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`、official HEAD `49a606bc5b5934603f22a26957a07dc799ab0291`、package `@deepseek-ai/dsh@0.1.2-alpha.5`，session format version `0`。Alpha.5 相对 alpha.3 未改变物理存储格式（同一 event catalog、`seedLength` 头部行、packed rows、range-encoded provenance），因此无需 parser/protocol 变更；官方 alpha.5 检查入库的 web snapshot（`snapshots/web/fresh-round-trip/session.jsonl`）已作为 fixture 入库并按 upstream `parseSessionLog` 规则在测试中合成 seq/time。本轮无新的官方 live session 证据（凭据 key 认证失败，live run 不可用），仅保留了 alpha.3 时代的本地 live 观察。

JSONL 是当前主支持后端，支持 raw `.jsonl`、multi-frame `.jsonl.zstd` 和 packed `text-chunks`、`reasoning-chunks`、`tool-call-chunks`。range-encoded `sourceEventSeqs` 会在 Provider 边界统一解码（alpha.3 引入，alpha.5 沿用）。适配器保留 zero-based source sequence、`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`request/header` 与 `request/context`、surface/source-event citations、`session/end-seed`、fork `parentSession`/`seedLength`、compaction、cancellation/interruption、workflow/subagent、`agent/inbox/spliced` 和 Agent Teams `team/member`、`team/task`、`team/message/queued`、`team/message/delivered`。alpha.3 起还记录 `model/selection`、`subagent/model-selection-policy`、`session-log-deepseek/delivery-accepted`（alpha.5 相同）。这些属于 control/model/delivery facts，不会变成普通 conversation message。

alpha.3 已移除 SQLite persistence backend，alpha.5 仍未恢复（现有 SQLite 包只是 storage-kv facet 与 FTS5 session-query 后端）。检测到遗留 schema 17 store 时仍会明确显示 **unsupported backend/schema diagnostic**；它不会静默消失，也不会被当作空 Provider。官方 headless CLI 没有声明默认 resume 参数，因此 AgentSession 不伪造 DSH resume 命令。

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
