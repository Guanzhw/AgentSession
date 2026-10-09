# AgentSession 3.0 Rust-first 架构方案

状态：**Rust/Svelte 3.0 为工作区唯一实现和默认运行入口；产品与平台验收按逐项契约记录**。更新：2026-10-09。

历史 2.0 基线 `50a32e7` 包含搜索索引 PR #6 的合并，其比较与验收记录保留原有归属。
用户于 2026-10-09 明确要求把最新 3.0 整合到主工作区并移除 2.0 runtime；
[整合决策](../../.agents/decisions/implemented/2026-10-09-sole-v3-workspace.md)
记录当前默认入口与 Git 恢复边界。发布、用户服务和 provider 数据仍按各自授权处理。

当前独立候选采用 **Rust core + Axum + rusqlite/SQLite + rmcp + Svelte
静态前端**。目标是功能和阅读体验与现有产品等价，视觉可以重新设计；无需像素级复刻。
不估算工期或费用。Rust 的产品级性能与资源收益必须通过同语义实验验证。

相关依据：

- [产品与当前能力](../../README.md)、[英文能力说明](../../README.en.md)
- [五-provider 范围与发布状态](agentsession-v2-provider-scope.md)
- [阅读呈现规范](runtime-presentation-contract.md)、[交付计划](runtime-delivery-plan.md)
- [六工具 MCP 契约](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/packages/agentsession-mcp/README.md)
- [搜索与启动研究](mcp-search-performance-study.md)、[Rust parser probe](../benchmark-rust-codex-parse.md)
- [provider 证据与贡献规范](../CONTRIBUTING-PROVIDER.md)
- [已实现的候选架构决策](../../.agents/decisions/implemented/2026-09-26-rust-first-architecture.md)

## 1. 决策与适用范围

AgentSession 是本地历史读取工具：持续处理多种 provider 的大文件和数据库，既服务
浏览器，也可能被多个 agent host 分别启动为 stdio MCP。Rust-first 的主要价值在于
统一数据引擎、控制内存生命周期、降低多进程运行基线，以及直接分发原生 executable。
选择它不以“项目很大”为前提，也不意味着 Rust 自动解决索引或读取语义。

Rust 已是 provider/core 的唯一实现。历史 TypeScript 版本通过固定 Git 修订、
比较产物和证据记录保留；当前源码目录仅维护 Rust 所有者。fixtures 和实录继续作为
有明确来源的知识与验收资产。

根 [AGENTS.md](../../AGENTS.md) 和 [v3/AGENTS.md](../../v3/AGENTS.md) 规定当前
Rust/Svelte 工程约束。验证用任务自有端口与隔离派生状态；历史对照的相同只读来源、
独立配置和原始版本继续归入历史证据，不构成当前双核心维护要求。

## 2. 产品与兼容边界

唯一 provider 集合为 `claude-code`、`codex`、`opencode`、`deepseek-harness`、`pi`。
OpenClaw 和 Hermes 不注册、不跟进、不增加旧引用解析器；已经保存的相关元数据和
历史索引行继续保留，不因升级自动删除。

| 必须保留的能力 | 新架构所有者与要求 |
| --- | --- |
| Library、项目/日期/收藏过滤、家族分页、标题与内容搜索 | Rust catalog/search；Svelte 呈现和导航恢复 |
| 完整 Reader、自有/继承背景、工具与 reasoning、长文续读 | Rust 有界 Reader 投影与内容定位；前端逐层展开，任意可读内容可到达末尾 |
| 子历史、协作、Teams、异步和后台执行 | adapter 提供来源事实，core 组织位置与关系；浏览器只负责布局与交互 |
| 目录、来源锚点、搜索命中定位、Back/Forward | 稳定 canonical refs 与 locator；每个阅读 pane 独立状态 |
| Protocol v2/v3、运行数据、原始事件、诊断 | 保留公开语义与 recorded/derived/unknown，提供有界查询 |
| Compact、context result、memory 产物及后续证据 | provider-owned 来源与版本，按需读取；未知结果不补造 |
| Usage、模型、请求明细、上下文长度 | 统一 request ownership；复制的旧 usage 不计新请求，实际新请求共享输入仍计入 |
| Settings、标题、收藏、排除、统计导出、resume | Viewer 元数据独立；resume 保持结构化命令、loopback、同源与禁用开关 |
| 系统提示来源、runtime environment、附件和产物 | 保留现有可解析内容、来源及不可用诊断，不声称恢复隐藏数据 |
| 六个 read-only stdio MCP 工具及 installer | Rust core + rmcp；保留工具契约与实际支持的 host 配置行为 |

保留五-provider canonical session/event identity、既有有效来源链接和已公开 HTTP
能力。迁移前登记 README 所列公开路由和实际消费者；内部 HTML-fragment 通路可以
由 JSON/组件取代，公开响应则保留薄适配或经过独立明确的契约变更，不悄悄改成 SPA
shell。迁移不引入第二套 session ID。

## 3. 运行结构与依赖

```text
Svelte + TypeScript 静态资源
           │ HTTP JSON
           ▼
     Axum Web routes                  rmcp stdio tools
           │                                │
           └──────── agentsession-core ──────┘
                    │             │
            五 provider adapters  Viewer metadata
                    │
        catalog / search / Reader / runtime read model
                    │
                  SQLite
```

采用 Cargo workspace 中的 core library 和应用入口，加一个前端目录。初始只按真实
所有权划分模块，不为五个 provider 各建发布包，不拆微服务。Web 与 MCP 是独立进程，
各自在进程内直接调用同一 Rust core library；一个 executable 可提供 `serve`、`mcp`、安装管理等
子命令，保留现有 `agentsession`、`agentsession-mcp` 用户命令入口。

| 部分 | 选择 | 具体职责 |
| --- | --- | --- |
| 数据核心 | Rust、Serde/serde_json | 边界解析、类型化事实、投影和错误；先不引入 SIMD parser |
| HTTP | Axum + Tokio，按需使用 tower-http | loopback listener、JSON routes、静态资源；不另加 Node server |
| 本地存储 | rusqlite + SQLite，显式 SQL | provider SQLite 只读；派生索引事务与 Viewer 元数据操作 |
| MCP | 官方 rmcp，启用 server/transport-io 等实际使用 features | schema、stdio、协议协商、六工具绑定 |
| 前端 | Svelte + TypeScript + Vite | 静态编译，原生 History API 与受控路由层，Reader pane 状态与视觉 |
| Markdown | 前端 markdown-it + 本地 highlight.js | raw HTML 关闭，安全链接与渲染出口集中处理；块定位由 core 提供 |
| 资源 | 编译时静态资源嵌入 | HTML/CSS/JS/字体/图标/许可随 binary 离线分发 |
| 契约 | Rust 序列化类型与 JSON Schema 为来源 | 生成 TS DTO；生成工具在纵向样例中验证 nullable、枚举和 tagged union 后固定 |

HTTP handler 和 MCP tool handler 都只做边界转换。core 不依赖 Axum/rmcp；provider
不依赖 UI，不认识 DOM。serde 类型稳定后，内部不重复检查同一字段形状。

阻塞 SQLite、解压、解析不直接占用 Tokio async executor。使用拥有连接的专用
DB worker 和有界解析任务，传递有界结果；先不增加 Rayon 或通用作业系统。
rusqlite Connection 为 Send、非 Sync，不能将一个连接任意并发借给 handlers。
取消与关闭应在记录/批次边界协作检查，不能假设 spawn_blocking 开始后可直接 abort。

实施前的依赖核查（2026-09-26）：[rmcp 3.x 迁移说明](https://github.com/modelcontextprotocol/rust-sdk/discussions/969)
表明新版支持 MCP 2026-07-28 和较旧协议，但 `resultType` 等字段受协商版本约束；
纵向切片必须用两代真实客户端各自完成初始化、工具发现与调用，不能只凭库版本推断兼容。
[rusqlite OpenFlags](https://docs.rs/rusqlite/latest/rusqlite/struct.OpenFlags.html) 要求显式以
`SQLITE_OPEN_READ_ONLY` 打开 provider SQLite；普通 `open` 具有读写/创建语义。
[Tokio spawn_blocking](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html) 在任务开始后
不能靠 abort 停止阻塞工作，因而取消点必须落在自身批次边界。
[zstd stream Decoder](https://docs.rs/zstd/latest/zstd/stream/read/struct.Decoder.html)
默认连续解码多个 frame，DSH 多 frame 来源应据此建立真实输入回归；不能只验首 frame。

## 4. 事实、读模型与本地存储

provider 文件/数据库是会话存在性及来源事实的权威；Viewer 元数据是用户偏好的权威；
派生索引可以重建。重建索引不能清空或迁移用户元数据。

不把一次完整 `Vec<Message>` 或全部 JSON 对象树设为每个查询的必经输入。按消费者
拆成 catalog、search、Reader、runtime 查询，共享下列最小事实：

| 实体 | 核心字段与含义 |
| --- | --- |
| SessionRef / EventRef | provider + 原 canonical sessionId；事件/消息 ID 与 segment 保持现有含义 |
| SourceScope | 规范化后的实际五-provider 来源配置 fingerprint；隔离派生存储、刷新锁与 revision，不改变公共身份 |
| SourceRevision | provider-owned 来源版本、捕获的 extent、parser/projection 版本、必要的父来源依赖 |
| SessionCatalog | 标题、项目、时间、父关系、轻量摘要、可用性；不加载所有工具正文 |
| Message/Event | 稳定身份、来源顺序、role/phase、来源 locator、内容块引用、provenance |
| ReaderSegment | 消息/块范围、目录及插入位置；属于某 source revision，不创造 provider turn |
| RuntimeFacts | 保留 v2 事实及 v3 work/execution/coordination/context 证据，区分 task 与 run |
| UsageRequest | provider request 身份、归属、模型、输入/输出/cache 和覆盖情况 |
| SearchDocument | 原有 title/directory/user/assistant/toolName 查询所需内容与引用 |
| ViewerMetadata | 收藏、自定义标题、隐藏/排除和配置，key 包含 provider + sessionId |

catalog 与 search 在一次增量刷新中产生；详细 Reader/runtime 投影可以在首次访问该
session 时建立并按版本缓存。无需启动时为全库生成所有 Runtime graph、HTML、工具
正文和 Markdown AST。payload 按需读取；仅在随机访问压缩内容确有需要时建立可重建
的 session 内容块缓存，不能无限期复制所有来源形成第二份历史仓库。

JSONL locator 可以是捕获 extent 内的记录/字节位置；SQLite 使用 provider 稳定 key
与快照；Zstd 使用选定 generation/记录身份及派生内容块，不能把压缩偏移当明文偏移。
raw provenance 保留准确来源，未知或不可读内容返回显式诊断。

## 5. 增量索引、一致性与并行进程

启动先打开持久化 catalog，再枚举 provider 来源签名；未变化 session 不解析正文。
默认不依赖 watcher 保证正确性：相关查询前检查必要来源版本，watcher 只能是以后有
证据需要时的优化。无索引首次构建和已有索引的未变化启动分别呈现与计时。

一次 refresh 的流程：

1. adapter 枚举来源、选定 canonical representation，并捕获 source extent。
2. 比较来源签名、parser/projection 版本及 ownership 所依赖的父证据。
3. 仅处理变化 session。JSONL 只有经 provider 验证的 append 形状才做尾部增量；
   rewrite、truncate、generation 切换和归属变化重建该 session。
4. 解析为有界批次，构建新 projection；检查捕获范围的一致性后事务发布。
5. 发布新 revision；失败保留诊断，旧结果只能带明确旧版本/失效状态，不能冒充最新。

来源签名由 adapter 定义，不能一概用目录 mtime，也不能每次启动对全 corpus 重做
内容 hash。JSONL、SQLite/WAL、压缩来源的变更检测和活跃写入行为分别验收；读取中
观察到 rewrite/截断时返回 source changed，不能静默拼接不同 extent。

cursor 绑定 source scope、查询/过滤、排序、session scope、相关 read-model revision 和位置。
索引变化时沿用当前明确的 stale-cursor/restart 语义。正文续读绑定自己的 source
revision；来源不再可读时报告变化或缺失。首屏、目录、协作和后续段不能各自随意
选择不同版本。

来源配置先按生效值规范化并形成稳定 source-scope fingerprint，至少包含五个 provider
实际使用的数据根/DB 路径，以及确实改变派生事实的 provider 配置。CLI、环境变量和
配置文件的优先级先解析完成，再计算 scope；不能以 config 文件名或 metaPath 代替。
纯语言、主题、端口不纳入；来源内容变化属于 revision，不改变 scope。

只有规范化来源配置等价的 Web/MCP 进程共享派生 namespace、刷新锁和 revision。
即便使用同一 AGENTSESSION_META_PATH，不同 roots 的 catalog/search/Reader/runtime
派生缓存也逻辑隔离；一个 scope 的刷新、删除判定和回收不能触及另一个 scope。
物理实现可采用同 DB 分区或独立 sidecar，先不锁定布局。公共 canonical refs 与
Viewer metadata key 仍为 provider + sessionId；source scope 是内部读取身份，
不添加进公开 session ID。因而两套来源中的同 ID 仍使用相同 Viewer 元数据 key，
但各自读取自己的来源事实。跨 scope cursor 明确拒绝，不能续读另一套结果。

同 scope 的 Web 与多个 stdio MCP 进程共享磁盘派生数据，不互相要求服务在线。
刷新采用该 scope 内的进程间互斥，取得刷新所有权后重新检查 revision，避免重复扫描；SQLite 短事务发布结果，
不在长解析期间持有写事务。具体跨平台锁实现必须通过进程崩溃、等待、取消和恢复
试验后固定。读取使用一致快照；OS page cache 的共享不等于共享 Rust 对象缓存。
每个进程缓存和任务并发都有限额。先不增加后台 daemon、IPC 服务或连接管理平台。

MCP 可先建立协议连接，具体调用等待其所需刷新完成；首轮等待/错误必须可诊断。
“连接成功”“旧 catalog 可见”“本次查询已完成来源核验”是不同状态，验收分别记录。

## 6. 搜索与公开读取契约

保留大小写不敏感、空白分词 AND substring matching、原排序与完整结果分页。
先移植当前已验证的索引及 matcher，不用默认 FTS 分词语义替换现有搜索。
FTS5 trigram 只能在证明不会漏项后作为候选缩减优化，短词仍有完整路径。

必须差分检查中文一/二字、标点、通配符字面量、Unicode case、NUL、UTF-16
half-surrogate、常见词、无命中、末尾命中与跨页顺序。Rust UTF-8 String 和 JS
UTF-16 字符串不等价：在搜索输入、JSON 解码、长度/offset/截断边界明确现有可观察
行为，用现有测试决定最小实现，不能静默替换或新增泛用字符串兼容层。

Web 全局搜索、Reader 搜索、MCP 搜索保持各自范围：Viewer 排除状态应用于其列表
和全局结果；MCP 不以 Viewer 元数据过滤来源；Reader 完整范围搜索包含当前选中
pane 可用的自有正文、reasoning 和工具内容；MCP 普通搜索不包含 reasoning 或工具
payload。继承背景单独处理。命中必须能定位其准确 owner/message/segment。

Protocol v2/v3 的身份、recorded/derived、capabilities、validation、completeness
继续成立；v3 不改写同源 v2 事实。bounded event/graph 查询同时约束输出与构建工作，
完整事件内容由 Reader/MCP 显式请求和续读；3.0 不提供专用会话文件下载，见[用途决策](../../.agents/decisions/implemented/2026-09-27-v3-session-export-purpose.md)。缺失/不支持/无效不返回伪造空成功。

## 7. Reader 等价与首屏选择

采用静态 shell + 一次有界 bootstrap JSON，不保留 Node SSR 服务。bootstrap 包含
root identity、首段、必要导航信息、revision 与 continuations。目录可以分页，但
全部条目仍可到达；深链接先解析准确位置并读取对应段，不遍历加载之前全部正文。
这增加了 shell 后的一次本地请求，是否改善首个正文可见时间需实测；shell paint
不能当作正文就绪。产品当前不要求无 JavaScript 阅读。

前端状态显式分为 root page 和 Reader pane：

- root page 固定 URL 所属 session、页头、管理与 resume owner。
- 每个 pane 有 canonical ref、revision、已加载段、展开状态、查询、命中位置、
  入口锚点与返回焦点。同一 child 在当前阅读树只挂载一份，重复打开定位已有实例。
- URL 存可复现的 root/child 路径、source 和查找条件；history entry 保存展开、
  已载段与位置。关闭 child 恢复父入口与焦点；独立打开才改变整个页面 owner。
- 默认连续阅读保留请求、回复、协作转折、异常及 context checkpoint。已知过程可
  折叠，未知 phase 文本保持可读；工具与 reasoning 不跨 assistant 归属。
- dispatch、follow-up、子侧完成、父侧接收、异步分离/返回是不同有源节点。协作图
  的视觉可以重设计，但不能改关系含义或要求读者先进入技术面板才能看懂。
- 分段同时受内容量约束；超大单 turn 按 Markdown 块续读，不让一个巨大输入绕过
  加载上限。不可分大块提供明确的可续读原文；任何内容都不能只给摘要而丢掉全文。
- 首版使用按需段落加载，不默认引入会反复卸载正文的全页虚拟列表。选择文字、
  来源锚点、协作连线、Back/Forward 与父位置恢复是必须保持的实际消费者。

复用呈现规范 P1–P14 验收：短问答、长工具/未知 phase、多轮协作、多级 child、
compact/memory、继承背景、迟加载搜索、来源/历史导航、Teams、后台执行、缺失来源。
桌面中英、明暗、键盘、reduced-motion 仍须真实浏览器检查；已有响应式能力保留，
不新增窄屏验收。实页阅读与用户视觉确认不能由 schema/tests 代替。

## 8. 六工具 MCP 与两代协议

| 工具 | 保留的行为 |
| --- | --- |
| session_browse | provider → project → session；directory/time/title/parent 过滤、来源检查和 index revision cursor |
| session_search | 当前 fields/lineage/排序/AND substring、完整分页、准确 event ref 和 provider diagnostics |
| session_get | 可见消息/role/tool facets、preview、canonical 父子；child 默认 50/最大 100，172-child 等场景可读完 |
| session_timeline | message/tool/thinking 分段、过滤、全文定位；thinking 显式选取、空白 message segment 不伪造事件 |
| session_get_context | 有界邻域和内容 opt-in；默认不泄露 reasoning/tool payload |
| session_get_event | 准确 segment、完整正文续读、显式敏感内容 opt-in、可复用 continuation 参数 |

输入/输出 schema、默认值、硬上限、错误、untrustedContent、工具 annotations 以
当前 MCP bindings 和 README 为差分基线。child 索引候选继续在来源检查 canonical
ID 和父关系，允许缺失候选导致空 continuation 页但保留后续真实 child。

官方 rmcp 已发布文档支持 stdio、legacy initialize 和现代 discover/per-request
协议。新实现须通过旧 initialization 客户端和 `2026-07-28` 客户端的真实进程测试，
不能只看版本常量或内存 transport。stdout 仅协议，stderr 仅诊断。

最终采用原生 rmcp，不默认保留常驻 TS MCP 桥。只有确认的协议缺口才允许临时薄层，
并记录具体缺口与退出条件。installer 的 Codex/Claude Code/OpenCode 用户级目标、
不覆盖手工配置、managed update 和 `--config` 语义保留；Pi 读取支持不等于 Pi 有
原生 MCP installer 入口。npm launcher 仍可启动 native binary。

## 9. 五 provider 的格式与旧历史

下表是仓库已有证据快照，**不是对 2026-09-26 所有上游 latest 的新一轮认证**。
实施各 adapter 前按贡献规范更新官方 release/tag/source 和本机样本；区分上游源码
核验、fixture 核验和真实记录核验。支持最新格式与保留五-provider 旧历史并行推进，
不是借重写删除已支持历史，也不承诺读取没有证据的未来格式。

| Provider | 现有证据/格式基线 | Rust 移植必须保留 |
| --- | --- | --- |
| Claude Code | 仓库上游快照 2.1.263，本地 2.1.207；transcripts/projects JSONL | response ID、sidechain/task notification、compact boundary、request usage 去重；旧形状有实录/fixture 才保留；无新版本 live 样本就明确缺口 |
| Codex CLI | 上游快照 0.153.0，本地 0.152.1；JSONL 与冷文件 .jsonl.zst | 旧 token_count 与新 token_usage_record、NEW_TASK/父历史 ownership、inter-agent communication、异步 exec/wait、memory/context；不能用 parent_id 单独去重 |
| OpenCode | v1 message/part 与 v2 schema；本机 v2.0.16 已验证 | 按 schema 选择 reader、v2 seq 顺序、父/分叉关系；v1 native v3 与 v2 已记录能力区别；不因新 schema 不完整静默退回旧库 |
| DeepSeek Harness | v0/v1 packed 与 v2/v3 event JSONL/Zstd；完整基线 0.1.5-alpha.2，0.1.6-alpha.2 Teams 局部实录 | 每 root 最高 generation、编码冲突诊断、append-origin 与 context replacement 分离、goal/team/mailbox/workflow、parent-owned child catalog；无官方 resume 默认命令就不编造 |
| Pi | 上游快照 @earendil-works/pi-coding-agent 0.85.1/session format v3，本地 0.80.10 | branch topology、firstKeptEntryId、compaction summary、request usage；历史扩展与当前标准分开，pi-subagents 的文件目录不直接证明 lineage |

规范化错误与未知领域由 adapter 返回，不在 Axum、MCP bindings 或 Svelte 加 provider
ID 分支。旧格式只留在该 provider 内；旧 provider 已退役这一事实不影响五个活跃
provider 的历史读取。具体 OpenCode 规则见[存储兼容说明](../opencode-storage-compatibility.md)。

## 10. 发布产物与迁移

目标平台沿用 Windows x64、Linux x64/arm64、macOS arm64。静态前端资源编入发行
binary，两个产品入口调用相同 core。npm 包提供平台 binary 与轻量启动/安装入口，
用户不需要 Cargo；直接 binary 不需要 Node。Linux libc、SQLite/Zstd 链接、Windows
文件锁/子进程与 macOS 签名在最早的发行样例中验证，不推迟到完整 UI 完成之后。

配置继续使用 AgentSession 公共名称、现有选定配置路径及五-provider 设置。Web
只监听 loopback，同源 mutation/terminal launch 边界保留；命令仍是 executable、
args、cwd，不能转成拼接 shell。provider 数据始终只读。

迁移以新版本派生库旁路构建，记录 schema/parser/projection 版本，成功后切换使用；
旧派生库保留到用户明确清理。新核心直接读写已兼容的 Viewer metadata schema；如
确需 schema 变化，先做备份和单独可审查迁移，不能把重建 catalog 当作元数据迁移。
升级不重写 provider 文件，不清除 v1 index 或 retired-provider 行。历史程序可以
从 Git 恢复，其保留的原派生库与新格式索引分开；当前工作区不提供旧 runtime 回退入口。

切换前从元数据快照演练，比较 source hashes、metadata 行、标题/星标/排除状态、
配置和五-provider refs。先在独立目录/端口运行。装包后验证命令、静态资源、离线
运行、六工具和所有平台产物；合并后的发布仍须独立授权。

## 11. 实施顺序

[3.0 交付计划](agentsession-v3-delivery-plan.md)的 S0–S5 是阶段状态和退出门槛的唯一入口；
[验收契约](agentsession-v3-acceptance-contract.md)逐项定义可观察结果。本方案提供各阶段的
技术约束，不单独维护另一套通过条件。

| 交付计划阶段 | 本方案的技术重点 |
| --- | --- |
| S0–S1 | 冻结五 provider 来源与公开 API/MCP schema、Reader P1–P14；以来源事实裁决旧行为，建立能识别身份、顺序、归属、完整性错误的对照器。 |
| S2 | 用大型 Codex 与 DSH 压缩/团队样本贯通 Rust core、Axum、静态 Reader、rmcp；验证真实晚期定位、bounded event 续读、两代 MCP 客户端和当前宿主平台可启动的最小发行样例。其他目标平台尽早做构建/链接可行性检查，未实际运行的产物仍待 S4 验收。 |
| S3 | 完成五 adapter 的 source-order refs、父子/branch、usage、context、诊断，以及按 revision 增量的 catalog/search 和完整 Reader、Library、Usage、Settings、统计导出、resume、installer。 |
| S4 | 检验不变启动不解析正文、追加/重写/删除/父变化/坏尾行/压缩代切换，以及 Web+多个 MCP 并发与崩溃恢复；两配置同 metaPath、不同 roots，含重叠 ID 与独有 sessions，不得串读、互删或混用 cursor。完整运行目标平台产物并完成桌面 P1–P14、MCP、安装与迁移复核。 |
| S5 | 当前交付唯一 3.0 启动入口、产物、证据和明确限制；历史固定 2.0 比较保留原记录与 Git 恢复路径，保持未发布状态。 |

失败时修复拥有该行为的边界，不增加静默旧实现 fallback 使验收看似通过。
历史迁移双跑用于对照与渐进交付；本次整合已移除旧 runtime 路径，逐项验收仍需真实证据。

## 12. 性能证据、决策门槛与未决项

当前已有证据：固定 Windows Codex corpus 为 840 文件、约 3.4 GB。A1 已有索引的
五次交替测量中，启动中位数 12.681 s、首次搜索 90.7 ms、重复搜索 73.8 ms、启动
峰值 RSS 中位数约 3.134 GB。Rust parser probe 的 Node/Rust wall 中位数为
13.227/7.621 s、峰值 RSS 为 1,048,084,480/772,317,184 bytes，raw digest 相等。
后者只证明读取、解析及 envelope hashing 的差异，**不是 Rust 产品或五-provider
正确性/端到端性能结果**。host filesystem cache 未清空，不称为 cold disk。

对比 Rust 和 TS 时，两者都使用持久化、按来源 revision 增量的读模型，使用相同
冻结 corpus、查询和完整 cursor 遍历。先验证结果/引用/归属相等，再比较：首次
构建、未变化 fresh process、单来源变化、首查/重复/全页查询、长 event、Reader
首个正文、Web 与多个 MCP 的合计进程 RSS、索引体积及发布产物。记录全部失败和重试，
轮换执行顺序；不能把 Rust 热索引与 TS 全量冷扫描比较。

沿用研究中的目标：固定 corpus 重复查询 p95 < 1 s、未变化 fresh-process startup
< 2 s。当前精确Windows83在816文件共同语义集合的五轮native实测中，各查询重复首页nearest-rank p95最大171.1723ms、未变化新MCP首个正确答复最大124.3596ms，两个绝对目标通过，见最终报告 (`../../tmp/v3-performance/final-native-83edfddc-20261001/REPORT.md`, local evidence)。本次没有当前2.0配对数值，正式共享第四轮browse续页失败且cause未决，故不能以单进程目标通过关闭整体资源验收。Reader 记录正文可见时间、HTML/JSON/JS
传输、DOM、source reads 和 projection 次数，不能只以 shell paint 或响应体缩小
宣称体验提升。测量首屏 bootstrap 是否重复携带正文、是否每片段重建全历史。

Rust-first 已用于独立候选；正式产品采纳仍以功能/读取正确性、互操作、发行与目标
工作负载的实测为门槛。如果同样优化的 TS 已满足资源/启动目标，Rust 未呈现所需
收益且引入明显实际问题，应保留 TS 或缩小 Rust 范围，记录证据而不维护无消费者
的双核心。不要为达成选型而改低正确性门槛。

审阅时需要明确的剩余决定：

1. 静态 shell + bootstrap 的实页首屏体验是否满足阅读要求；未通过时先解决 payload
   和数据准备，再比较 SSR，不预先加入 Node sidecar。
2. DTO 生成与 UTF-16/Unicode 边界怎样保留现有可观察契约；以实际测试定案。
3. 跨进程刷新锁、派生缓存回收和平台 binary 链接/安装布局；由 S2 发行样例和 S4
   并发/平台验收的失败与成功证据固定具体机制，不先做通用基础设施。
4. 五 provider 最新实录可得性、公开 API 消费者清单及 metadata 兼容性；实施前更新
   基线，不能把本表的历史上游版本写成未核验的 latest。

## 13. 外部技术依据

以下官方/项目主源于 2026-09-26 查阅，用于确认能力边界，不作为 AgentSession
集成验证。实施时锁定实际版本并保存升级证据。

- [Axum 文档](https://docs.rs/axum/latest/axum/)：Tokio/Hyper 路由与 Tower 集成。
- [rusqlite Connection](https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html)：连接、事务与 Send/非 Sync 边界。
- [Tokio spawn_blocking](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)：CPU 并发限制与不可直接取消的执行边界。
- [官方 Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)、[rmcp 发布文档](https://docs.rs/rmcp/latest/rmcp/)：查阅版本 3.4.1，stdio 与两代生命周期支持；仍需真实客户端验收。
- [rmcp ServerHandler](https://docs.rs/rmcp/latest/rmcp/handler/server/trait.ServerHandler.html)：initialize/discover 与 supported_protocol_versions。
- [SQLite FTS5](https://www.sqlite.org/fts5.html)：trigram 短词限制，不能直接替代 substring 契约。
- [SvelteKit static adapter](https://svelte.dev/docs/kit/adapter-static)：静态部署能力；本提案前端不依赖 Node SSR。
- [rust-embed](https://docs.rs/rust-embed/latest/rust_embed/)：静态资源嵌入 executable。
- [markdown-it](https://github.com/markdown-it/markdown-it)：浏览器 Markdown 解析实现；完整续读仍由产品负责。

2026-09-26 方案审查只覆盖文档、引用和治理，未新增 Rust 实现或完成产品级验证。
3.0 实施中的实际进度和验收证据由独立交付计划记录，不以本方案的设计描述代替通过结果。
