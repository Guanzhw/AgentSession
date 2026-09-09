# 前端实现 · P5：Execution 有界公平与任务状态去重

## 已验证事实

在 2026-09-09 对当前 `main` 重建并重启后，真实 Codex 会话
`01a0576a-98e2-7c31-a265-6d98d5fbff12` 的默认 Execution API 返回：

- `truncated=true`
- 50 actors、49 runs
- 0 个可见 usage records，`usage.requestCount=0`、`usage.total=null`

同一会话用 `maxItems=300` 可看到 152 个 request usage records 和非零 Token。
因此默认投影中的“0 请求”不是无用量证据，而是 actors/runs 按固定顺序耗尽了
跨集合共享的 100 项构造预算。现有 incomplete 文案避免把 null 称为完整总量，但仍把
“被预算完全饿死”呈现成 0 条可见请求，无法支持使用者判断后台工作实际产生的请求用量。

同一真实会话的 Work 任务表把 task 状态和唯一 run 状态直接拼接，形成
`completed · completed`。两个状态相同时没有新增信息。

重建后的 `#tab-conversation` 深链已正确选中 Conversation，但从 Work 点击
“打开对话检查器”后，界面虽然切到 Conversation，URL 仍停在 `#tab-work`；刷新或复制
链接会回到错误标签。Library 的 OpenClaw storage notice 对应真实 `legacy-only` 状态，
不属于本阶段缺口。

## 目标

1. Execution 的单一全局 `maxItems` 构造上限保持不变，但非空的 actors、runs、
   usageRecords 不能仅因固定集合顺序而被完全饿死；默认长会话必须暴露有界、诚实的
   request usage 下限。
2. Work 任务表只呈现有区别的信息：task/run 状态相同只显示一次，不同状态仍完整保留。
3. 详情页标签切换后，URL hash 与当前可见标签保持一致，使刷新和复制链接恢复同一视图。

## 实现边界

1. 只修改 provider-neutral 的 v3 Execution 投影、Runtime Workbench 呈现、相关类型／
   locale（确有需要时）、回归测试和本设计状态文档；不得修改任何 provider adapter、
   parser、provider-owned protocol builder 或数据源。
2. `maxItems` 仍是整个 Execution 投影的硬构造上限，不得通过遍历所有 usageRecords 后
   只截断返回值来绕开构造上限。
3. 在 `maxItems` 足以覆盖非空主集合数量时，actors、runs、usageRecords 每个非空集合
   至少获得一个构造项；其余预算采用确定性的 provider-neutral 公平分配。关系项也必须
   计入同一个上限，`truncated` 必须继续准确。
4. 若极小 `maxItems` 小于非空集合数量，保持确定性并明确 incomplete/truncated；不要
   声称未观察到的集合为空。不得引入第二个隐式上限或 provider 特判。
5. usage aggregate 与 origin aggregate 必须只基于实际投影出的同一批 request records；
   `requestCount`、`recordsTruncated`、component/total 下限和 `complete` 语义保持一致。
6. Work task 状态展示按顺序去重相同的 normalized label；例如
   `completed + completed` 显示一次，`active + completed` 仍显示两种状态。不得改变协议
   task/run 状态或用 UI 猜测聚合状态。
7. 建立 implemented decision record，记录公平预算机制、硬边界与真实证据。更新
   `docs/design/ui-v2.md` 的 P5 状态；不要改写 P0–P4 历史结论。
8. OpenClaw provider 冻结：不得修改 `src/providers/openclaw/`、其 fixtures 或 provider
   语义。共享测试可以验证所有 provider-neutral 输入，但不得借本任务扩展 OpenClaw。
9. 顶层 Work / Conversation / Events 标签的任意用户触发切换都要同步当前 panel id 到
   hash；初始化时继续接受合法深链，缺失/非法 hash 继续使用 Work 默认。不得让嵌套的
   Runtime lenses 改写顶层 hash，也不得触发页面重载。沿用现有渐进增强与可访问 tab
   语义，不新增 provider 分支。

## 回归覆盖

- 50 actors、49 runs、至少 152 usageRecords、默认 `maxItems=100`：三个非空主集合均有
  可见项，总构造项不超过 100，usage 为明确的不完整下限而非 0。
- actors/runs/usage 的稀疏组合、单集合超过上限、`maxItems=1/2`、完整未截断用例。
- origin aggregate 的 inspected records 与投影 usage records 严格一致。
- task 与 run 状态相同／不同／多个重复 run 状态的 SSR 用例。
- 直接深链初始化、顶层 tab 点击、`data-detail-tab` 内链，以及嵌套 Runtime lens 不改写
  顶层 hash 的静态/浏览器回归。

## 验收

- `npm run typecheck`、focused tests、`npm test`、`npm run review`、
  `npm run pre-push`、`git diff --check`。
- 重启本地服务后，真实 Codex 默认 Execution API 显示非零可见 request usage、
  `complete=false`、`truncated=true`，且扩大到 `maxItems=300` 的结果仍不回归。
- 浏览器验证 1280/768/320、light/dark、zh/en 中 Work 与 Conversation；任务状态不重复，
  usage 不再给出虚假的 0 请求印象，标签切换后的 hash 与可见 panel 一致，控制台和
  服务日志无新增错误。
- 不提交 `dist/`、日志、截图或 `tmp/`。
