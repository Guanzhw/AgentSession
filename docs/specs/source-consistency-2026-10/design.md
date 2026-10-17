# 读取与发布边界

对应[需求](requirements.md)；执行状态见[任务](tasks.md)。

## Codex

现有目录先取 inventory，随后 `load_codex` 解析并重新 hash 全文件，
`capture_for_index` 校验初始 signature，最终 `validate_inventory` 再比较全目录。
合法追加会触发这些检查中的任一层并取消整个 provider 的发布。

为目录建立 provider 拥有的捕获批次。批次将 inventory observation 与前缀验证
凭据一起构造，shared index 只调用其捕获、精确复用与最终验证接口。
Codex 凭据保存固定前缀长度/hash、选定路径与 identity、authority/membership、
native title 和实际影响投影的 child dependency。复用已有 Reader 前缀读取与
hash 原语；pair/compressed 保持严格读取路径。

新捕获从观察边界读取；最终验证同一前缀及依赖，允许边界后的追加。未重新捕获的
缓存行维持 opening observation 语义，并继续核对选源、标题及依赖。持久化初始
observation signature，不能用较新的文件状态假称尾部已被索引。既有 authority
与 ABA 断言继续有效，不能只放宽最终 ID 集合比较。

## OpenCode

SQLite 在首次 SHM opener 时可先将文件截为零，再建立共享内存区域；已
checkpoint 的 WAL 即使有读取 main DB 的事务，也可能被合法 TRUNCATE。
独立文件 metadata 与 header 读取之间没有 SQLite 生命周期锁。

修订采样期间持有现有 `open()` 创建的只读连接/事务，保护 SHM 映射。WAL
metadata 已存在后发生的消失或短读属于观察失效，最多进行三次采样，耗尽后返回
`SourceChanged`。保持 DB/WAL header 与 SHM 两份 commit header 证据，普通
I/O 和 SQLite/schema/payload 错误继续上报。该方案保留既有乐观一致性检查，
没有将多连接 Protocol bundle 改称为单一 SQL snapshot。

legacy stats 复用现有 `ApiError` 映射，公开 availability 与 diagnostic
（code、message、retryable）。已有 summary 数字保留其来源，Protocol 缺失项
保持 null。桌面使用现有 StatsPage 的错误/重试以及 Reader 实际读取验收；
不为廉价 families 列表新增逐行完整 Protocol 读取。
