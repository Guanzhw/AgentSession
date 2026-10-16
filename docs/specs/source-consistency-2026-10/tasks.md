# 执行账本

## 根因与基线

- [x] 保存主工作树状态/hash，并从 `7c48a1e` 创建隔离工作树。
- [x] 使用该基线成功 CI 的 Windows native artifact 复现 Codex 合法追加
  5/5 HTTP 409；稳定及停止追加对照 HTTP 200，健康 sibling 同受阻断。
- [x] 正常 SQLite 生命周期复现 SHM/WAL 短读；12,960 次独立 SQL 成功，
  最终 integrity_check=ok。确定性 PASSIVE→采样→TRUNCATE 调度验证 WAL 竞态。
- [x] 独立审查两类一致性边界与缓存语义。

## 实施

- [x] Codex provider-owned 捕获批次与完整前缀发布，保留 authority/ABA 检查。
- [x] OpenCode 读事务内生命周期保护与有界 WAL 重采样。
- [x] legacy stats 显式可用性和逐行诊断。
- [x] 根因确定性回归、尾部/重写/来源切换及已有相关回归。

## 验收与交付

- [x] 修复前后相同受控追加/SQLite 生命周期实验及错误计数对照。
- [x] 真实 Codex/OpenCode 来源只读读取，Reader 续页、Protocol、统计与 MCP。
- [x] 独立最终 review；完整 Rust 测试、UI/release 构建和 pre-push gate。

Windows 最终 release 的新增 HTTP 回归为 3/3 通过。Rust workspace 为 core
258 passed / 18 明确 ignored，app 7 passed。SQLite 正常并发实验中，修复前
SHM EOF 11、WAL EOF 61；修复后两者均为 0，20,964 次独立 SQL 读取成功，
integrity_check=ok。162 次暂态统计失败继续通过 stderr 和逐行 API diagnostic
报告为可重试 source_changed，没有以 HTTP 200 隐藏失败。

真实源包括 2,033 个 Codex JSONL/ZST（约 3.06 GB）及 OpenCode v2 数据库。
Codex 冷/热目录均 200（175.3s / 50.9s），canonical total=494、首屏 30 行；
其中一条活动会话统计仍明确报告可重试 source_changed。既有 2 条多来源未合并
诊断保留。OpenCode total=78、首屏 30 行统计均 available；其 Reader、Protocol、
统计接口均 200。两条稳定真实 Codex 会话 Reader 及续页均 200，原文件前后 SHA-256
相同。实际 native MCP 有界调用 4/4 通过。目录成功并不表示所有 Protocol 统计
同时可用，以上实测耗时也没有构成大库性能门槛已通过的声明。

### 交付验收记录

提交前的实现证据已在上面列明。桌面目录→Reader/续页、OpenCode 统计与重试，
全量 Node、跨平台 CI，以及合并后源码树/关闭 issue/原工作树保全/任务资源关闭的
最终结果，随本变更的 PR 验收记录和 [#8](https://github.com/Guanzhw/AgentSession/issues/8)、
[#9](https://github.com/Guanzhw/AgentSession/issues/9) 的关闭记录更新。通过相应验收前
不合并或关闭；平台 CI 的受控来源验证不替代该平台真实用户来源验收。

本机详细复现、失败与验收证据保存于任务的 ignored `tmp/` 证据目录。
已记录的失败不由后续通过结果覆盖；本账本仅更新实际完成的项。
