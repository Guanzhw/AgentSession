# 前端实现 · P6：长会话视觉可读性收尾

## 已验证事实

2026-09-09 在当前 `main`、真实 Codex 长会话
`01a0576a-98e2-7c31-a265-6d98d5fbff12` 上完成 P5 后的浏览器复核显示：

1. 1280px 桌面 rail 宽 176px，但底部搜索 input 的实际矩形从约 `x=175` 开始、仅
   34px 宽，落在 rail 外形成孤立方块；可见 label 与输入框没有形成一个可理解的控件。
2. 1280px 的 Work overview 把 Current context 与五列 Recorded tasks 并排；任务表只余
   约 586px，`completed` 和长 agent path 被逐字断行。768px 下两区已经堆叠，任务表
   反而更可读，说明问题属于可用宽度／断点，而非 provider 文本。
3. session metrics 把 label/value 直接相邻输出成 `messages2,155`、`steps200`；长跨度
   显示为 `runtime13257m 18s` 并折行。该 `runtimeMs` 是记录首尾时间形成的会话跨度，
   不能暗示连续活跃执行时间。
4. metrics 的标签、Token 组件和 top-tools 文案是硬编码英文，中文页面仍显示英文。
5. 768px 与 320px 当前没有页面级横向溢出；窄屏 rail 搜索按既有设计隐藏。必须保留。

## 目标

- 让桌面 rail 搜索成为完整、边界内、可聚焦的搜索控件。
- 让 Work context 与任务表根据真实可用宽度布局，避免状态和标识符无意义逐字断行。
- 让 metrics 形成清楚的 label/value 层级，使用诚实的“记录跨度”语义和紧凑的
  day/hour/minute/second 时长格式。
- 补齐上述区域的英中本地化，不改变任何统计值、协议字段或 provider 语义。

## 实现边界

1. 只修改共享 SSR views/helpers、`src/static/style.css`、英中 locale、相关测试与 UI v2
   状态文档；不得修改 provider adapter/parser/protocol builder、Session Protocol、索引、
   数据库或 token 计算。
2. 桌面 `.app-rail` 内的 search form、可见 label 和 input 必须共同受 rail 内宽约束；
   label 可换行，input 保持完整宽度和可见 focus。`max-width:768px` 的既有隐藏行为不变。
3. Work overview 在并排布局无法给五列表格提供可读宽度时必须堆叠；1280px 可以保留
   并排，但任务表须有足够宽度。状态 label 和 Evidence 控件不应逐字断开；canonical
   path 仍允许在必要时换行，不能截掉身份。
4. `.session-stat` 明确分隔 label 与 value，并在 1280/768/320 自适应；不得删除任何
   messages/steps/tools/branches/span/cost 或 Token 明细。
5. 将 `runtime` 标签改为英中“Recorded span / 记录跨度”。只改变呈现语义；值仍是
   `totals.runtimeMs`。超过一小时／一天的时长用最大两个非零单位，例如 `6h 35m`、
   `9d 4h`，不再输出数千分钟。共享 duration helper 与 Work task elapsed 应保持一致的
   分级规则；零值和无效值沿用既有边界语义。
6. metrics labels、selected/inclusive Token 明细组件名、top tools 文案全部通过现有 i18n
   边界输出；英中 key 集保持一致。工具名和数值保持 provider/source 原文。
7. 不新增运行时依赖或客户端状态；不通过隐藏内容解决拥挤。
8. 建立 implemented decision record并更新 `docs/design/ui-v2.md` P6 状态，记录真实浏览器
   截图/矩形证据、语义选择和验证结果。
9. OpenClaw provider 继续冻结；不得修改 `src/providers/openclaw/` 或其 fixtures。

## 回归覆盖

- layout/CSS hooks：桌面 rail search form 为有界纵向布局，input 使用 border-box 且不从
  rail 外溢；窄屏仍隐藏。
- Work overview 的中间宽度堆叠与桌面最小任务表宽度；status/evidence 不逐字断行。
- duration helper 覆盖 seconds、minutes、hours、days、无效／零值，以及 start/end wrapper。
- 英中 metrics SSR：所有 label 和详情本地化，`Recorded span / 记录跨度` 正确，数值不变。
- 现有 session page、Work overview、library card duration 回归不丢字段。

## 验收

- `npm run typecheck`、focused tests、`npm test`、`npm run review`、
  `npm run pre-push`、`git diff --check`。
- 真实 Codex 页面在 1280/1024/768/320、light/dark、zh/en 检查 rail、Work 表格、metrics；
  无页面横向溢出、逐字状态断行、孤立搜索方块或浏览器错误。
- 服务错误日志无新增错误；不提交 `dist/`、日志、截图或 `tmp/`。
