# 后端演进 · 任务 D：有界 Execution Usage 的诚实展示

## 已验证事实

真实 DeepSeek Harness alpha.2 会话
`session-a9f5b448-9851-4872-a266-fdc3381a5061` 的 native v3 包含 508 个经
`turn:step` fold 选出的 request usage，总计 102,197,093 Token；
`RawSession.tokenCount`、详情 Metrics direct total 与 v3 全量 usage 一致。

Runtime Workbench 默认 `maxItems=100` 是跨 actors、runs、usageRecords 共用的构造
上限，因此 Execution 投影只包含其中 96 条请求和 10,634,337 Token，并正确返回
`truncated=true`、`usage.complete=false`。当前 UI 仍把该数标为“总 Token”，容易被
误读成会话全量，也曾导致错误的重复统计判断。

DSH 未记录 request context 的 direct/inherited/shared origin slices。因此现阶段只能
确认 provider settlement 的请求级去重，不能进一步扣除后台会话继承或共享的上下文。

## 目标

让 Workbench 在投影被截断或 usage 不完整时明确表达“当前有界投影中的可见请求”和
“至少这些 Token”，只有 `usage.complete === true` 时才称为请求总量。协议/API 的
有界语义保持不变。

## 实现边界

1. 只修改服务端 Runtime Workbench 的 Execution usage 展示、英中 locale、相关视图
   测试和必要文档；不修改 provider parser、统计 fold、Session Protocol、投影算法、
   索引或数据库。
2. `usage.complete === true` 时保留完整语义：请求数与总 Token 是投影覆盖范围内的完整
   请求用量。
3. `usage.complete !== true` 时：
   - 请求数标为“可见请求”而不是“请求总数”；
   - 已知数值以“Token 下限”与 `≥` 语义展示（例如 `≥ 10.6m`），不能称为总量；
   - 组件值同样不能暗示完整；
   - 保留现有 incomplete 状态并说明结果受有界投影限制或 evidence 不完整。
4. origin slices 不完整时不要显示或暗示 direct/inherited/shared 为 0；已有 origin 展示
   若无误无需扩展。
5. 增加稳定 data hooks，覆盖 complete 与 incomplete/truncated 两种渲染，便于 E2E
   验证 request count、token value 和 completeness。
6. 添加 focused regression tests；本阶段是局部文案/展示修正，不新建架构 decision。

## 验收

- `npm run build` 与相关 focused tests；与后续 UI 小改一起做完整 review。
- 真实 DSH 页面默认有界投影显示 96 个可见请求、至少 10,634,337 Token，详情 Metrics
  继续显示正确的 selected-session 全量 102,197,093 Token。
- 检查中英文、控制台、服务日志和 320px 横向溢出。
- 不提交 `dist/`、日志、截图和 `tmp/`。
