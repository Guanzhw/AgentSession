# AgentSession 3.0：匹配性能输入冻结记录

更新：2026-09-27。本文固定[同语义性能协议](agentsession-v3-performance-protocol.md)的输入。精确来源路径、查询原文、构建/调用参数保存在 Git 忽略的 `tmp/v3-performance/manifest.private.json`。查询标签和 SHA-256 可供审计，但哈希不代替结果正确性检查。

## 来源与边界

复核了旧研究的 Codex 静态副本：**840 个 JSONL 文件，3,400,267,634 bytes**，以相对路径、大小、mtime 构成的 stat manifest SHA-256 为 `0819d9d3232a22252a2dfcc4ae29463583678c3aea6ca5d96d9d5ba2193d7db0`，与[旧研究](mcp-search-performance-study.md)一致。正式运行前后均重算签名；变化则该配对运行无效，另建语料版本。另四个 provider 使用[代表性冻结语料](agentsession-v3-corpus-plan.md)的路径和哈希。只读使用来源，2.0 与 3.0 各自使用隔离的 Viewer metadata、索引与缓存。

查询结果边界固定为 Unix ms `1790417752133`，与旧 Codex 匹配实验一致。每项查询都显式传 `updatedBefore` 和 `limit=20`；完整分页必须走到 `nextCursor=null`。查询原文及其 SHA-256 在私有 manifest，公开标签如下。英文、中文、通配符字面量、多词、常见词、无命中、元数据和工具名共同检查精确语义；每项至少记录结果数、有序 canonical 引用哈希、失败与重试。性能仅在同输入正确性通过后比较。

| 标签 | 范围／字段 | 目的 |
| --- | --- | --- |
| `codex-user-assistant` | Codex；user、assistant | 延续旧匹配研究主查询 |
| `chinese-one`、`chinese-two` | Codex；user、assistant | 一字/二字中文 substring 路径 |
| `literal-percent` | Codex；user、assistant | `%` 按字面量查找 |
| `multi-term`、`common-one` | Codex；user、assistant | AND 多词与常见短词 |
| `no-hit` | Codex；user、assistant | 空结果与诊断成本 |
| `metadata-title-directory` | 五 provider；title、directory | 元数据搜索，不强迫正文解析 |
| `tool-name` | 五 provider；toolName | 工具名发现，不读取工具载荷 |

构建模式固定为 2.0 的 `npm run build` 和 3.0 的 `cargo build --release`；正式运行使用最终安装产物时另记其 digest。每个量化负载至少五次匹配运行，交替旧新版先后，保留全部原始记录并报告中位数与 nearest-rank p95。OS 文件缓存目前未受控，运行只可标记为 likely-warm/unknown，不能称冷盘。更多操作、资源指标、两个使用目标和通过条件见[性能协议](agentsession-v3-performance-protocol.md)。

输入 stat 签名已复核，九项查询和顺序已固定；统一启动两版、执行完整分页并记录资源的
MCP 搜索 runner 已实现并通过合成服务测试。2.0 固定提交的两次独立 MCP 进程已完整遍历
九项查询，结果数依标签顺序为 **689、340、46、90、260、830、0、478、123**；每项完整
有序语义哈希及首页哈希一致，五个来源的前后 stat 签名一致。私有候选及原始逐页记录位于
忽略提交的 `tmp/v3-performance/v2-candidate-20260926-a/`。随后由不导入产品 parser、
adapter、搜索或索引的来源验证器，直接读取五份冻结 provider 数据，重建九项查询的完整有序
结果、事件引用和摘录；`tmp/v3-performance/source-search-expanded-20260927-i/` 的
`verification.status=source-verified`，九项计数为 **689、340、46、90、260、830、0、478、123**，
全部语义哈希已固定，前后来源哈希未变。OpenCode 工具名 119 条、Codex 3 条、DSH 1 条，
Claude/Pi 均为 0 条，均有独立来源路径。公开摘要不含私有路径或正文。

3.0 已可运行。五次交替的[集成候选正式配对](agentsession-v3-mcp-search-integrated-20260927.md)
以固定五来源九查询完成 10/10 次无错遍历，每次 147 页、2,856 条有序语义均匹配独立
来源 golden；源与 binary 摘要前后不变。该候选的首次就绪中位数为 10.16 秒，2.0 为
22.43 秒；不变来源重启为 0.108 秒对 11.43 秒；不同查询有快有慢，原始分布和资源量
见报告。随后继续加入 Codex 协作、继承和执行事实，最终交付 binary 仍须重放受影响的
正确性与资源负载，不能将此前候选数字直接归给最终 3.0。

继承背景的[公开大前缀负载](../../v3/test/inherited-context-performance.test.mjs)
衍生 51、1,001、10,001 条同形 Codex child 来源，完整遍历 40 条列表页和 2,048 字内容页，
核对每页 ordinal、13,063 字全文、两条 owned 事件及来源哈希不变。缓存前单次 10,001 条／
251 页列表遍历约 90.35 秒，中位页 348.7 毫秒，进程峰值约 31.3 MB；provider-owned、
按选中路径／scope／canonical ID／原始字节 SHA-256／parser 版本约束的有界继承投影缓存后，
相同公开负载列表约 9.55 秒，中位页 36.5 毫秒，另七页长正文约 0.26 秒。Rust 测试已覆盖
同长度改写且恢复 mtime、路径切换与 scope 切换重新解析。此为单轮配对，不是最终发行基准；
每请求仍重新选源、读源、计算哈希，因而完整分页仍有明显 IO 成本。

独立冻结真实三级链还暴露 Reader 大来源瓶颈：约 753 MB Codex 根会话的 bootstrap
约 20.58 秒，首个 relations 页约 19.99 秒，进程峰值约 1.068 GB；请求前后三份来源 SHA-256
相同。继承投影缓存不作用于这两个端点。要把长 Reader 首屏和后续页纳入性能结论，须单独
建立源修订约束下的有界读取／派生投影，重放这条同源负载，并核对完整正文与关系归属。

Codex 持久 Reader 投影的**未配对 release 试跑**已在同一冻结根来源
（753,294,971 bytes，14,243 Reader items／1,972 relations）完成：首次缺缓存
bootstrap 4.484 秒，随后同进程 relations／segments／1,000 字内容分别为
0.622／0.603／0.621 秒；新进程重用投影分别为 bootstrap 0.603 秒、relations
0.597 秒、segments 0.584 秒、内容 0.591 秒。release binary SHA-256
`031757a2ef531e0d47836db1a96f5c534699033563fbb42d2abe66370948cb3f`，
原始来源 SHA-256 `a374ee2f3329627c806958b14ae8ae31545386459a7b3a701174cf60ccfc8cd6`
前后相同。首次请求仍同步构建，峰值 RSS 约 1,001 MiB；WAL 发布期间缓存目录
峰值约 370 MiB，最终主 SQLite 为 193,056,768 bytes。原始输出保存在隔离的
`tmp/v3-reader-frozen-release-count-probe-20260927/` 和
`tmp/v3-reader-frozen-release-probe-20260927/`；独立复核及最终五次配对仍待。
前述 20.58 秒旧 Reader 观测为不同构建／
测量条件，此处不计算加速比；调试版的同来源热页约 10 秒，也不能代表 release。
该 probe 的 binary 还早于内容偏移索引、跨进程建库锁与 SQLite pane 搜索；
后续候选必须重新记录 binary／缓存体积、冷首屏、热页及完整搜索结果，不能沿用上述
资源数字判定最终 3.0。
