# 活动来源读取一致性修复

范围：[issue #8](https://github.com/Guanzhw/AgentSession/issues/8) 与
[issue #9](https://github.com/Guanzhw/AgentSession/issues/9)。基线为 `7c48a1e`。

## 已复现问题

- Windows 上合法 Codex JSONL 持续追加时，目录请求连续 5 次返回
  `source_changed`，停止追加后恢复；同来源健康会话也被整批发布失败阻断。
- 正常 SQLite commit、checkpoint 与连接开关期间，独立 SQL 读取成功且
  `integrity_check` 通过，原生修订采样却出现 WAL/SHM 短读。
- legacy 列表仅向 stderr 输出 Protocol 统计失败，HTTP 200 的逐行结果没有
  可用性诊断。当前桌面 Library 使用廉价的 v3 families 投影；统计页已有错误与重试入口。

## 必须满足

1. Codex 单个选定的未压缩 JSONL，包括 recorded authority 选定的文件，
   持续追加时可发布经过验证的完整记录前缀；健康行保持可用。
2. 前缀内容、canonical identity、选源及 authority、成员集合、标题、相关
   child dependency 必须匹配；rewrite、truncate、ABA 或来源切换不得发表错误事实。
3. 缓存仅代表已观察/验证的边界。停止写入后正常刷新与重启能纳入最终记录。
   完整无换行记录保留，未完成尾记录等待后续读取，完整坏 JSON 保留明确错误。
4. OpenCode 修订采样遵守 SQLite 的 SHM 生命周期；合法 checkpoint 导致
   已观察 WAL 截短时进行有限重采样，耗尽后保留明确 `source_changed`。
   真实数据库、schema、payload 与普通 I/O 错误不得隐藏。
5. 保留同大小/时间戳 WAL 提交的失效检测。legacy 列表必须公开逐行统计
   可用性、原始错误与可重试性，不将未取得的 Protocol 统计填为零。
6. 对受控副本补充确定性回归、正常并发对照、真实来源/API/MCP 与桌面验收，
   通过适用的跨平台 CI 后合并并关闭两项 issue。

## 数据与工作树

provider 原始数据库、记录与事件日志保持只读。制造追加、checkpoint 或损坏仅限
任务自有副本；保留失败、来源与产物证据。主工作树既有 21 项改动保持状态和哈希。
