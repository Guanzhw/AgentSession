# AgentSession 1.10.1

## 会话阅读与 Agent Runtime

- 以完整会话为主线：默认阅读用户请求、Agent 回复与关键协作节点，逐层展开执行过程和子历史。
- 用户消息靠右、Agent 回复靠左；连续执行过程合并呈现，保留各次消息、用量与原始定位。
- 子历史在触发的协作卡片内展开，支持关闭返回、目录、搜索及多级历史导航。
- 成员侧轨用颜色和箭头连接创建、通信与结果返回；滚动保持正文和已有轨道位置稳定。
- 异步任务直接显示动作/结果摘录、启动至返回和分离后两个时间区间，并用局部括线连接分离与返回。
- 任务与协作面板在宽桌面停靠，普通桌面提供随时可用的贴边入口；记住展开选择。
- 上下文压缩进入会话目录，点击即可定位并读取实际保留的上下文。
- Show more 在同一内容面继续阅读，保持原文和 Markdown 结构的连续性；极大的不可拆分块明确标注为分页原文。

## 会话库

同标题、同项目的独立会话显示精确 UTC、短 ID 及可取得的实际问题摘录。
这不会合并或删除原始记录。Codex 摘录在启动扫描时写入本地 viewer 索引，不增加逐行解析开销。

## 安装

```sh
npm install -g @acetamido/agentsession@1.10.1
npm install -g @acetamido/agentsession-mcp@1.10.1
```

也可使用 GitHub Release 中 Windows x64、Linux x64/arm64、macOS arm64 的独立可执行包。
Node 安装方式要求 Node.js 22.15 或更高版本。原有 provider 历史保持只读。

1.10.1 同时修正 Windows checkout 对上游 fixture 的换行转换，保持字节哈希校验一致。
Reader 功能与 1.10.0 一致；1.10.1 提供统一验收的 npm 包及四平台独立程序。

逐项反馈与验证结果见 [执行账本](https://github.com/Guanzhw/AgentSession/blob/main/docs/specs/reader-feedback-2026-09/tasks.md)。
