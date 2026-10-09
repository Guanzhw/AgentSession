# AgentSession 3.0：Codex 子代理结果的来源搜索 golden

2026-09-27，用独立来源 oracle 复核固定五 provider、九项查询的完整 3.0 MCP 候选。候选九项均完成翻页且无错误或重试；全部结果的数量、排序、canonical 会话／事件引用、匹配字段／角色和摘录与原始来源推导一致。私有来源报告与新 golden 分别位于 `tmp/v3-performance/source-search-agent-v3-20260927-a/source-verification.private.json` 和同目录的 `search-golden.private.json`。旧 2.0 golden 保留在 `tmp/v3-performance/source-search-reverified-20260927-k/search-golden.private.json`，未被改写。

| 查询 | 2.0 来源 golden | 3.0 来源 golden | 3.0 首命中角色为 agent |
| --- | ---: | ---: | ---: |
| `codex-user-assistant` | 689 | 689 | 4 |
| `chinese-one` | 340 | 340 | 4 |
| `chinese-two` | 46 | 49 | 3 |
| `literal-percent` | 90 | 94 | 10 |
| `multi-term` | 260 | 261 | 4 |
| `common-one` | 830 | 830 | 1 |
| `no-hit` | 0 | 0 | 0 |
| `metadata-title-directory` | 478 | 478 | 0 |
| `tool-name` | 123 | 123 | 0 |

六项正文查询共有 26 个子代理首命中，来自 19 个 Codex 源文件。其中 8 个是新增会话命中（`chinese-two` 3、`literal-percent` 4、`multi-term` 1），另外 18 个会话原有命中，但按原始记录顺序，首次匹配现在落在更早的子代理结果上。oracle 仅在原始 JSONL 中看到 `collaboration.spawn_agent` 调用、同 `call_id` 的输出回执、匹配的作者和接收者，以及完整 `FINAL_ANSWER` 信封后，才把答案正文作为 `assistant` 搜索字段；结果仍保留 `matchRole=agent`。私有报告为每个首命中保存源文件 SHA-256、spawn／回执／答案的行号、任务名、actor 路径、答案正文哈希和首匹配文档序号。26 项逐一检查了 `spawn < acknowledgement < answer`、源哈希和候选的首事件引用；均通过。oracle 不导入产品 parser、adapter、search 或 index。

冻结 Codex 来源仍是 840 个 JSONL、3,400,267,634 bytes，stat manifest SHA-256 为 `0819d9d3232a22252a2dfcc4ae29463583678c3aea6ca5d96d9d5ba2193d7db0`；逐文件内容 manifest SHA-256 为 `bd1c8412d186979b498ae2092537b19b725144cc727c4aac6df74fe3a317b298`，与此前冻结记录一致。其余四 provider 的前后来源签名也一致。九项的 `source-verified` 状态均成立，未解决的会话和不匹配项均为 0。新 golden SHA-256 为 `4dee5a4ad6bf9a0e782d8a8ec2c124fd7b3167adb4722cd05d6b2419f963b32d`；旧 2.0 golden SHA-256 仍为 `73a9bfce28bc08a06167e13ff61d7385fca28035f77c4c941504c79323f86676`。

复核输入是 `tmp/v3-performance/search-final-d403-cutoff-20260927-a/rep-1-v3/record.private.json`（SHA-256 `3a0d7d806e435fe553fa82a3bb8eb216cac773cdbe630cb9b17ed2bf6131a2c2`），对应候选 binary SHA-256 `d403d241c280477fe14b80899e93303e98c728340c04074c19581a0f58961b74`。查询仍用固定 `updatedBefore=1790417752133` 和 `limit=20`。oracle 位于 `scripts/v3-verify-search-golden.mjs`，本轮文件 SHA-256 `eb7b48eb0e8364fb3ce60670eb1c91fa057a54fa78364613eb325326c396be94`，工作树 HEAD 为 `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`。先添加手写来源测试并观察失败，再补推导后得到 16/16 通过；`npm run review` 也通过。来源扫描耗时 26.62 秒、峰值 RSS 547,893,248 bytes，属于准备成本。本轮只校验冻结九项查询与固定来源的语义，不构成完整 MCP-03 或性能验收；性能配对须用新 3.0 golden 和明确记录的最终 binary 另跑，不能沿用旧 2.0 golden 的匹配判定。
