# AgentSession 3.0：2.0 接口清单与迁移裁决入口

核验：2026-09-26；2.0 源码基线 `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`。
本清单服务 [3.0 交付计划](agentsession-v3-delivery-plan.md) S0；架构处理见
[Rust-first 方案](agentsession-rust-first-architecture.md)。表内注册入口与消费者证据冻结于该
2.0 基线。四个已文档化列表路径现已在 3.0 候选中实现为 JSON-only 迁移适配器；具体裁决、响应字段
及验证边界见[决策记录](../../.agents/decisions/implemented/2026-09-28-v3-json-only-list-responses.md)。
其余行中的处理建议仍是待验收事项，不构成已完成的兼容承诺。

## 分类、记号与覆盖范围

- **P（documented/public）**：README 明列的 API，或产品向用户提供的页面/下载链接。
  建议 3.0 保持路径、身份与行为；JSON/下载不能静默变成 SPA shell。
- **B（browser-internal）**：已有浏览器代码或服务端生成页面中的消费者；未找到 README
  API 承诺。建议可由 Svelte/JSON 取代内部传输，但先冻结阅读/操作语义并登记接口裁决。
- **U（unknown consumer）**：确认已注册或测试覆盖，当前检索未确认生产消费者/公开承诺。
  建议保留待裁决，继续查文档、历史和实际调用；不能据此删除。

P/B/U 描述的是目前证据，**B 不证明不存在外部消费者，U 不等于无人使用**。兼容范围
变化须单独裁决。表中行号为上述基线的定位提示，点击文件后按行号核对；后续改动可能
改变行号。`Pfx` 表示 `/api/:provider/session/:id`，`:provider` 正则通常为
`[a-z][a-z0-9-]*`，匹配后仍由 providerMap 判定注册/可用性；`:id` 为单个编码路径段。
`{a,b}` 在表中表示分别存在的注册入口，不是实际 URL 语法。

[server.ts](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/server.ts) L43–52 挂载路由；
[settings-stats-trash.ts](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/settings-stats-trash.ts) L46、657 再挂载 settings/trash。
本次枚举到 **62 个 `app.get/post` 注册语句**（其中一个匹配五种 mutation action），
以及 server 的四个内联路径分支。Router 当前只注册 GET/POST，按顺序精确匹配；见
[router.ts](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/router.ts) L38–44、68–96。没有把静态文件逐个计成路由，也没有把
未知 URL 的 404/非 GET 的 405 fallback 计成产品接口。

## HTTP：入口、Library、设置与统计

| Method / 路径 | 分类与消费者证据 | 注册位置 | 3.0 处理／决策 |
| --- | --- | --- | --- |
| 任意方法 `/` | P；产品入口，当前有 provider 时 302 到 `/sessions`，否则 500 | [server](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/server.ts) L154 | 保留浏览器入口；非 GET 的当前行为另登记，不直接当作设计要求 |
| 任意方法 `/favicon.ico` | B；浏览器资源入口，当前 204 | server L164 | 随静态前端保留可用资源响应 |
| 任意方法 `/static/*` | B；静态资源通路 | server L170 | 可换嵌入资源布局；保留离线可用性和正确类型 |
| GET `/api/providers` | P；[README](../../README.md) L254 明列真实验证入口 | server L176 | 保留 provider 状态 JSON |
| GET `/api/library/sessions` | P；固定 2.0 README L80；[app.js](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app.js) L689 | [2.0 sessions](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/sessions.ts) L123 | 3.0 用[JSON 适配器](../../v3/crates/app/src/legacy_lists.rs)返回 `{sessions,total,offset,hasMore,matchingSessions}`；家族行保留 canonical ID、`href`、匹配／子项计数和边界事实，不返回 HTML。过滤、排序与 offset 分页延续原语义；见[路由测试](../../v3/test/legacy-list-routes.test.mjs) |
| GET `/api/library/children` | P；固定 2.0 README L81 | sessions L146 | 3.0 返回 `{children,total,offset,shown,nextOffset}`；每页最多 20 个子项，行中保留父子身份与 `href`，不返回 HTML。筛选、排序与 offset 分页见[JSON-only 裁决](../../.agents/decisions/implemented/2026-09-28-v3-json-only-list-responses.md) |
| GET `/api/sessions` | P；固定 2.0 README L83 明确保留平铺结构 | sessions L171 | 3.0 返回 `{sessions,total,offset,hasMore}`；平铺行保留 `href`、原有列表统计及内容搜索匹配信息，不返回 HTML。过滤、排序与 offset 分页见[路由测试](../../v3/test/legacy-list-routes.test.mjs) |
| GET `/sessions` | P；根跳转目标、Library 页面 | sessions L210 | 保留导航、查询参数、返回状态 |
| GET `/sessions/search` | P；用户可访问搜索页面 | sessions L247 | 保留可分享搜索地址与结果语义 |
| GET `/api/:provider/sessions` | P；固定 2.0 README L83 的 provider 列表 API；app.js L689 | sessions L276 | 3.0 保留平铺 JSON 与 provider 过滤，响应行带 `href`；不可用 provider 仍返回 JSON 诊断。具体路由及边界见[实现](../../v3/crates/app/src/legacy_lists.rs)和[路由测试](../../v3/test/legacy-list-routes.test.mjs) |
| GET `/:provider` | P；provider 页面 | sessions L328 | 保留入口及有效 provider URL |
| GET `/:provider/search` | P；provider 搜索页面 | sessions L400 | 保留搜索导航及查询语义 |
| GET `/:provider/settings` | P；设置页面 | [settings](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/settings.ts) L10 | 保留页面能力，Svelte 可重呈现 |
| GET `/:provider/trash` | P；回收站页面 | [trash](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/trash.ts) L11 | 保留 Viewer 排除/恢复语义 |
| GET `/stats` | P；全局统计页面 | [stats routes](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/settings-stats-trash.ts) L488 | 保留跨 provider 口径及过滤 |
| GET `/api/stats/export.json` | P；[stats view](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/views/stats.ts) L920 下载链接 | stats routes L499 | 保留下载 JSON 与筛选范围 |
| GET `/:provider/stats` | P；provider 统计页面 | stats routes L513 | 保留统计及 drilldown |
| GET `/api/:provider/stats/deferred` | B；stats routes L527 生成页面延迟请求 URL；[routes tests](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/test/routes.test.mjs) L914 | stats routes L542 | 可替换片段传输；保留按 section 延迟加载和口径 |
| GET `/api/:provider/stats/export.json` | P；stats view L920 | stats routes L568 | 保留 JSON 下载 |
| GET `/api/:provider/stats/export.csv` | P；stats view L921 | stats routes L601 | 保留 CSV 下载与转义 |
| GET `/api/:provider/stats` | U；确认 JSON handler，当前未确认浏览器调用 | stats routes L638 | 保留待消费调查；不得因无 README 表格而移除 |

## HTTP：Reader、来源内容与 Runtime

以下全部 GET。Pfx 的 canonical provider/session 身份贯穿所有子路径。
[README HTTP 表](../../README.md) L88–101 是 P 类 API 的直接承诺；
[session-detail](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/session-detail.ts) 是下表未另标文件的注册来源。

| 路径 | 分类与证据 | 注册行 | 3.0 处理建议 |
| --- | --- | --- | --- |
| `/:provider/session/:id` | P；真实 Reader 地址、[session-reader](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/session-reader.js) L126 | L287 | 保留 canonical URL、来源锚点、Back/Forward |
| `Pfx/reader/process` | B；[session view](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/views/session.ts) L996 | L344 | 可替换 HTML 片段；保留 assistant 边界及工具过程展开 |
| `Pfx/reader/execution` | B；[reader-executions view](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/views/reader-executions.ts) L26 | L375 | 保留 execution ID、cursor 与连续结果 |
| `Pfx/reader/activity` | B；session view L2266 | L401 | 保留延迟 activity 内容及错误重试 |
| `Pfx/reader` | P；README L88；session-reader L269 | L433 | 保留公开响应/读取能力；字段变化单独裁决 |
| `Pfx/reader/segment` | B；session view L2044 | L460 | 保留 index/revision 一致性及完整续读 |
| `Pfx/reader/segment-location` | B；[reader-segments](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/reader-segments.js) L73 | L488 | 保留 anchor 到段落定位 |
| `Pfx/reader/work-metrics` | B；session-reader L694 | L516 | 保留 work 统计，替换内部展示可行 |
| `Pfx/reader/child/:childId` | B；session-reader L723 | L539 | 保留子历史完整性和返回位置 |
| `Pfx/inherited-context` | P；README L91；session-reader L1097 | L581 | 保留 offset 与继承/自有边界 |
| `Pfx` | U；[opencode-v2 test](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/test/opencode-v2.test.mjs) L261 覆盖；返回 session/tree/container/metrics/messages | L604 | 流式 detail JSON 不应静默改 HTML；外部消费待核实 |
| `Pfx/context-result` | P；README L93；session-reader L1028 | L640 | 保留 checkpoint/offset/limit 与缺失诊断 |
| `Pfx/artifact-evidence` | B；[artifact-evidence client](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/artifact-evidence.js) L64 | L694 | 保留 artifact/cursor/time 约束及来源证据 |
| `Pfx/content` | B；[session-workbench](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/session-workbench.js) L119 | L730 | 保留 part/field/scope、各类上下文定位及完整内容续读 |
| `Pfx/search` | P；README L92；session-workbench L517 | L845 | 保留 q/query、offset/limit 和精确命中定位 |
| `Pfx/export` | P；[components](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/views/components.ts) L681–682 下载链接 | L881 | 2.0 历史输入已冻结；3.0 的专用会话文件下载因缺少明确用户用途而移除，旧 URL 用 410 明示取消。Reader/MCP 的内容完整性与 canonical 归属继续独立来源验收；统计 JSON/CSV 导出保留。见[取舍记录](../../.agents/decisions/implemented/2026-09-27-v3-session-export-purpose.md) |
| `Pfx/protocol` | P；README L94 | L986 | 保留 finalized 协议事实和显式错误 |
| `Pfx/runtime/summary` | P；README L95 | L1016 | 保留有界 summary 与 provenance |
| `Pfx/runtime/events` | P；README L96；[runtime-events](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/runtime-events.js) L180 | L1036 | 保留 cursor/filter 身份；源码另支持 taskId/runId，不能只抄 README |
| `Pfx/runtime/graph` | P；README L97 | L1063 | 保留 depth/maxNodes 与构造工作上限 |
| `Pfx/runtime/execution/runs` | B；[runtime-workbench](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/runtime-workbench.js) L444 | L1086 | 保留 cursor/limit，HTML 部分可按内部接口裁决 |
| `Pfx/runtime/work` | P；README L98 | L1153 | 保留 maxItems 与 v3 work 事实 |
| `Pfx/runtime/execution` | P；README L99 | L1154 | 保留 maxItems 与 execution 事实 |
| `Pfx/runtime/coordination` | P；README L100 | L1155 | 保留 maxItems 与 coordination 事实 |
| `Pfx/runtime/context` | P；README L101 | L1156 | 保留 maxItems 与 context 事实 |
| `Pfx/system-prompts` | U；[routes test](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/test/routes.test.mjs) L410–414 调用，未确认前端 fetch | L1161 | 保留证据来源/不可用诊断；消费待核实 |

### Reader 协作、团队与 preview 注册

以下全部 GET，浏览器消费者可能由服务端生成 `data-*` URL 后使用通用 loader，因此
不能只 grep `fetch('/api/...')` 判断有无调用。

| 路径 | 分类与证据 | 注册来源/行 | 3.0 处理建议 |
| --- | --- | --- | --- |
| `Pfx/reader/tasks` | B；session view L2130 | [coordination routes](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/reader-coordination.ts) L66 | 保留 q/size/cursor 的任务目录 |
| `Pfx/reader/task` | B；[reader-relations](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/reader-relations.js) L101 | coordination routes L92 | 保留 key/lane/runsSize/runsCursor |
| `Pfx/reader/coordination/:observationId/content` | B；[coordination view](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/views/reader-coordination.ts) L35 | coordination routes L133 | 保留 offset/revision 与真实 owner 来源 |
| `Pfx/reader/coordination` | P；README L89；coordination view L106 | coordination routes L190 | 保留 taskId/runId/anchor/size/cursor |
| `Pfx/reader/event/:eventId` | P；README L90；session-reader L914 | coordination routes L218 | 保留事件身份及正文锚点 |
| `Pfx/reader/teams` | B；[teams view](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/views/reader-teams.ts) L11 | [teams routes](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/reader-teams.ts) L18 | 保留 q/size/cursor |
| `Pfx/reader/team` | B；teams view L17 | teams routes L45 | 保留 key/size/cursor |
| `Pfx/reader/team/tasks` | B；teams view L22 | teams routes L72 | 保留 key/size/cursor 与任务分页 |
| `Pfx/reader/team/task/:taskId/content` | B；teams view L26 | teams routes L98 | 保留 offset/revision 和完整任务内容 |
| `Pfx/reader/team/member/:actorId/content` | B；teams view L30 | teams routes L134 | 保留 offset/revision 和完整成员历史 |
| `Pfx/reader/preview` | B；reader-relations L57 | [preview routes](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/reader-preview.ts) L9 | 保留来源预览可达性，内部载荷可裁决 |

## HTTP：设置与 mutations

| Method / 路径 | 分类与证据 | [mutations.ts](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/mutations.ts) 行 | 3.0 处理建议 |
| --- | --- | --- | --- |
| GET `/api/settings` | U；已注册，当前未确认生产客户端 GET | L38 | 保留待调查，核对实际响应与敏感信息边界 |
| POST `/api/settings` | B；[settings-form](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app/settings-form.js) L48 | L50 | 保留 `{config}` 验证、保存与重启字段区分 |
| POST `Pfx/{star,rename,delete,restore,permanent-delete}` | B；[app.js](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/static/app.js) L326、442、468、483、500 | L106，一个 action 正则 | 保留五操作、provider capability 与元数据隔离；permanent-delete 不删源 |
| POST `/api/batch` | U；[management test](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/test/management.test.mjs) L268；handler 固定 opencode | L198 | 作为已存在旧入口待裁决，不能误认为跨 provider batch |
| POST `/api/sessions/batch` | B；app.js L617 | L237 | 3.0 [Axum 路由](../../v3/crates/app/src/web.rs)接收跨 provider `items/action`，按 capability 分组并返回 `{ok,affected,skipped}`；[HTTP-08](agentsession-v3-acceptance-contract.md)核对来源只读与元数据，Svelte Manage 的可读行选择另归 WEB-16 |
| POST `/api/:provider/batch` | B；app.js L617 | L287 | 保留单 provider ids/action |
| POST `/api/reindex` | U；management test L270；未确认生产前端入口 | L326 | 保留待调查；派生索引重建不能改来源/元数据 |
| POST `Pfx/resume` | B；app.js L415 | L365 | 保留结构化启动、同源 JSON/loopback、禁用开关与真实子进程验证 |

上述 mutation 的可信请求和输入检查要逐 handler 保留，不把所有 POST 视为同一种 body。
已知 batch actions 为 delete/star/unstar/restore/permanent-delete；rename 的文本、resume
参数、settings schema 应从对应 handler 固化测试。页面地址未注册全局 `/settings` 或
`/trash`；不得根据菜单名称虚构这两个路由。

## MCP：六个 2.0 工具输入 schema 与 3.0 扩展

全部 **P**：[MCP README](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/packages/agentsession-mcp/README.md) L43–53 列明六工具；
[session-history-server.ts](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/packages/agentsession-mcp/src/session-history-server.ts) 是注册
权威。测试证据见 [mcp.test.mjs](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/test/mcp.test.mjs) L624–625、832–851（schema
与边界断言），还需 S1 导出实际 `tools/list` 冻结逐字段差分。

共同定义（server L15–35、72–77）：

- `provider` enum = opencode / claude-code / codex / pi / deepseek-harness。
- `session` 是 strict object：必需 provider 与 sessionId；sessionId trim 后长 1–1000。
- `event` 扩展 session：必需 messageId（trim，1–1000）及 segment=message/thinking/tool；strict。
- 各工具输入 object 都 strict，未知字段拒绝。下表 `?` 为 optional，没有 `?` 为必需。
- `providers?` 是上述枚举数组，最多 5 项；schema 本身不声明 minItems 或 uniqueItems。
- `cursor?` / `childCursor?` 是未 trim 的字符串，长 1–4000；`updatedAfter?` / `updatedBefore?`
  是 finite number。schema 可选不等于默认值，默认/交叉字段验证由 service 契约决定。

| 工具 / 注册行 | 全部输入字段与 schema 约束 | 3.0 必须保持的读取语义 |
| --- | --- | --- |
| `session_browse` L79 | `level`: providers/projects/sessions；`providers?`；`directory?`: 空串或 trim 长 1–4000；`title?`: trim 1–500；`parent?`: session 或 null；`updatedAfter?`,`updatedBefore?`,`cursor?`；`limit?`: 正整数 ≤100 | provider→project→session 导航；parent:null 为根，ref 为直接子级；来源存在性权威，Viewer 隐藏/改标题不改此结果 |
| `session_search` L100 | `query`: trim 1–500；`providers?`；`fields?`: title/directory/user/assistant/toolName 数组，1–5 项；`lineage?`: all/roots/children；`updatedAfter?`,`updatedBefore?`；`directory?`: trim 1–4000；`cursor?`；`limit?`: 正整数 ≤100 | 默认不搜 toolName、thinking、tool payload；大小写不敏感 AND 搜索，cursor 绑定过滤/索引版本；保留 unavailable diagnostics |
| `session_get` L121 | `session`；`childCursor?`；`childLimit?`: 正整数 ≤100 | metadata、角色/工具分布、首尾 preview、直接子级分页；不是完整 transcript；跳过失效子记录可产生空续页 |
| `session_timeline` L136 | `session`；`query?`: trim 1–500；`segments?`: message/thinking/tool 数组 ≤3；`roles?`: user/assistant/system/tool 数组 ≤4；`toolNames?`: 每项 trim 1–200，数组 ≤50；`statuses?`: error/completed/unknown 数组 ≤3；`cursor?`；`limit?`: 正整数 ≤200 | 单会话有界事件；thinking 要显式 segment；query 搜消息全文/工具名，不搜工具输入输出；保留精确 event ref |
| `session_get_context` L156 | `event`；`includeThinking?`: boolean；`before?`,`after?`: 整数 0–20 | 只读同会话附近事件，不自动追父子；思考 preview opt-in |
| `session_get_event` L172 | `event`；`includeThinking?`,`includeToolInput?`,`includeToolOutput?`: boolean；`offset?`: 整数 ≥0；`maxChars?`: 正整数 ≤20000 | 内容有界且可以 continuation 读完；思考/工具输入输出分别 opt-in |

输出不是每工具独立强类型 schema：当前统一 strict
`{result: unknown, untrustedContent: true}`（L31–35），成功同时返回 text summary 与
structuredContent（L38–46）。错误返回 text + `isError:true`，SessionHistoryError 的
code 保留在消息前缀（L49–59）。annotations 均为 readOnly=true、destructive=false、
idempotent=true、openWorld=false。rmcp 重建应同时保留 schema、MCP envelope 与 service
结果语义；不能因 Rust 类型更强就擅自把 unknown 输出改成另一个公共协议。

README L52–54 声明 initialization 客户端和 stateless `2026-07-28` 客户端均可 stdio
调用；3.0 rmcp 可用性必须实测两种方式，不能从 crate 名称推定兼容。工具读取不受
Viewer 排除 metadata 限制；返回 transcript 永远是 untrusted content。

3.0 原生 MCP 另注册只读 `session_team_messages`，保留上述六工具 schema／输出不变。
`action=list` 要求 `session`，可选 `limit`（默认 50，最多 100）和 `cursor`；返回来源
revision、按来源顺序排列的 queued 消息引用、from/to session 与 participant、摘录、
provenance、可直接调用的 `readArguments` 和下一页 cursor。
引用为 `{provider,sessionId,sourceId,messageId}`，其中 `sourceId` 是 provider 自有不透明值。
`action=read` 要求 `message` 与 `revision`，可选 `offset`、`maxChars`；返回 UTF-16
`ContentPage` 与可直接再调用的 continuation。cursor 绑定来源 scope、session、revision；
unsupported provider 明确返回 `content_unavailable`。队列记录无 conversation EventRef，
不扩充旧工具的 transcript 或 usage。来源见 [MCP 决策](../../.agents/decisions/implemented/2026-09-28-v3-native-team-messages-mcp.md)。
输入 schema 用 draft-2020-12 `oneOf` 区分两个 action：缺少各自必需字段或混入另一
action 的字段均无效；真实 stdio `tools/list` schema 已由 JSON Schema validator 检查。

## 尚待冻结的证据与裁决

1. 已从固定 SHA 的真实 2.0 进程抓取两代 MCP `tools/list`，六工具的输入/输出 schema
   与 annotations 在两代中按 JSON 语义一致；公开的
   [schema 基线](../../test/fixtures/v3-mcp-tools-v2.json)不含会话内容。S1 仍须在冻结
   corpus 上逐项导出 HTTP 状态、类型、JSON/HTML 字段、下载及真实调用结果；本表的源码
   注册与消费者分级不等于逐字段兼容验收。
2. U 类入口分别补查历史、文档与实际调用，列出保留/替换的明确决定；B 类替换也须
   记录原消费者、替代路径及回归证据。不得以一次静态搜索推断外部消费者为零。
3. HTTP README 列出的部分 Reader API 当前承载 HTML/JSON 混合载荷，冻结时记录实际
   Content-Type 与字段；“read-only API”标签不自动意味着纯数据 DTO。
4. schema 默认值、错误码、cursor 身份、offset 字符计量和 bounds 的行为由
   [session-history service](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/session-history.ts) 与测试继续提取；MCP schema 表
   已包含全部注册输入字段，但不能替代这些行为用例。

本次没有复制 provider 私有数据，没有修改实现或运行 mutation。
