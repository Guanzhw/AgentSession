# AgentSession 3.0 MCP 搜索匹配测量（阶段证据）

本轮在 Windows 上用固定五 provider 来源、九项查询和五次交替配对测量了 2.0 与一份冻结的 3.0 binary。两版共 10 次尝试全部成功；九项查询每次均完整翻页，全部有序结果和首次响应均匹配独立来源 golden，来源签名及运行产物内容哈希前后不变。可复核的脱敏原始统计见[公开摘要](agentsession-v3-mcp-search-20260927.public.json)；包含查询原文、匹配项和进程记录的账本保留在忽略提交的 `tmp/v3-performance/matched-formal-20260927-a/`。

| 指标（5 次中位数；括号内为 nearest-rank p95） | 2.0 | 3.0 |
| --- | ---: | ---: |
| 无派生状态启动至首个经校验的搜索首页 | 22.67 秒（22.73） | 10.36 秒（10.49） |
| 来源未变化时，新 MCP 进程至可回答首页 | 11.47 秒（11.60） | 0.277 秒（0.280） |
| 九项重复首页查询中的最差 p95 | 7.417 秒 | 0.338 秒 |
| MCP 主进程峰值 RSS 的中位数 | 3.45 GB | 1.29 GB |
| 两阶段 MCP 主进程 CPU 时间中位数 | 274.11 秒 | 34.86 秒 |
| 派生状态占用中位数 | 40.44 MB | 71.10 MB |
| MCP 响应 JSON 载荷总量中位数 | 1.75 MB | 3.72 MB |

被测 3.0 binary 通过预先固定的“未变化重启可回答 <2 秒”和“同进程重复搜索首页 p95 <1 秒”目标。重复查询的 p95 按九项分别计算，上表取其中最大值；这不是完整分页耗时。该 binary 的 `rmcp::CallToolResult::structured` 将完整 JSON 同时写入 text 与 `structuredContent`，而 2.0 的 text 是短摘要，因此本轮 3.0 的传输量约为 2.12 倍；后续源码已修复六工具的重复载荷，但不能回填本轮成绩。

完整分页的逐次耗时按每个原始记录的 `pages[].wallMs` 求和，再取五次中位数：

| 查询标签 | 结果数／页数 | 2.0 | 3.0 |
| --- | ---: | ---: | ---: |
| codex-user-assistant | 689／35 | 1.70 秒 | 8.66 秒 |
| chinese-one | 340／17 | 0.84 秒 | 1.77 秒 |
| chinese-two | 46／3 | 0.08 秒 | 0.29 秒 |
| literal-percent | 90／5 | 0.14 秒 | 0.49 秒 |
| multi-term | 260／13 | 0.72 秒 | 3.23 秒 |
| common-one | 830／42 | 4.91 秒 | 4.37 秒 |
| no-hit | 0／1 | 0.03 秒 | 0.26 秒 |
| metadata-title-directory | 478／24 | 176.37 秒 | 3.60 秒 |
| tool-name | 123／7 | 0.44 秒 | 0.58 秒 |

3.0 的九项重复首页查询中有七项比 2.0 慢，完整分页也呈相同方向；元数据查询和不变来源重启则大幅改善。35 页正文查询的逐页开销是后续需要定位的性能缺口。此测量只支持 stdio MCP 搜索及进程就绪结论，不替代 Reader 正文、来源变化、Web 与多个 MCP 并行、安装或最终 3.0 binary 的性能验收。

## 来源与产物资格

- 2.0 固定提交为 `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`；重建后的 Viewer/MCP 运行树和 lockfile 的组合摘要为 `d01277bcd9b69de6cb1faf6d536be28f8aae8f658950a544039de3da969d92b4`。3.0 被测 binary 的 SHA-256 为 `e43386901793caf2b9ff86b6f0e4fc89b8baabe601c9432899a8cd2a4e7f44a4`，配对产物摘要为 `b452ac8f2dce8679baec329b07eb08f237ee7633b38f2c7d369b05188af723f8`。3.0 当时含未提交改动，因此其 Git HEAD 仅是基线，不是实现身份；以 binary 哈希识别本轮产物。
- 冻结 Codex 来源含 840 个文件、3,400,267,634 bytes；测量前后校验文件大小／修改时间的 stat manifest。其余四 provider 同时校验内容 manifest。没有把正式测量说成对 3.4 GB Codex 原文又做了两次内容哈希。
- 10 次尝试、90 项完整翻页查询与 20 次首次／重启首查均成功；所有进程退出码为 0，错误与重试均为 0。九组计数依固定顺序为 689／340／46／90／260／830／0／478／123。原始查询与会话内容不进入公开报告。

首次生成 golden 时，来源报告内一条无命中证据带有 `firstMatch: undefined`：旧指纹函数将该键计入哈希，JSON 文件却省略该键。公开回归先 RED 后 GREEN，`acceptedSearchGolden()` 现先按 JSON 持久化语义规范化再计算来源报告哈希；`node --test test/v3-verify-search-golden.test.mjs` 为 15/15。重新扫描同一冻结来源得到 `tmp/v3-performance/source-search-reverified-20260927-k/`，新来源报告指纹 `c0d3d9b00f28b3a11a52524bed34d98b92b999ec74bf5b9e0449d59e8a317d35` 可从落盘 JSON 重算。新旧 golden 的五来源统计、九项计数、完整有序语义及首页哈希全部一致；旧账本和旧 golden 保持原样。原始运行摘要引用旧 golden 哈希 `23068b3b6c3969e42909dd1ae18f9e5905de4ebd008fc2b28415e51842040a6f`，新可复算 golden 哈希为 `ad65fc5aa00382300c622501cc9946313f4c08599bd09dffa0ad4f0b2088cae1`。这修复的是来源指纹的可复算性，不改变搜索结果或测量数据。

测量未控制 OS 文件缓存；来源预扫描可能暖化文件数据和元数据。RSS 与 CPU 只覆盖 MCP 主进程，未覆盖子进程树和物理磁盘读取。每次尝试的两个 MCP 进程是先后启动，进程数 `2` 不代表并发运行。当前阶段继续按[性能协议](agentsession-v3-performance-protocol.md)测来源变更、完整读取与 Web/MCP 并行，再在最终 3.0 包上复测受改动影响的指标。
