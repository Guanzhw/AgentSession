# 前端实现 · 引导与执行边界

```text
仓库:AgentSession——本地优先、跨 7 个 provider 的 AI 编码会话查看器。Node ESM、
零运行时依赖、SSR + 原生 JS;服务器 127.0.0.1:3456。

工作流(主 agent 分派):主 agent 提供本有界 spec;由 pi-wsl `pi_task` 实现;
完成后由独立 `pi_review` 只读审查;主 agent 汇总验收。不需要新开会话或在其他会话粘贴。
执行前先读 AGENTS.md 与对应阶段 prompt。

信息设计蓝图:docs/design/ui-v2.md(逐节读透;§4.1–§4.9 是页面信息与层级,
§4.7 八个典型场景走查是验收标准,§5 是默认不显示清单,§6 交互规范,
§7 是 UI↔协议字段绑定表)。注意:详情页默认标签是**工作**(已实现决策
2026-09-02-work-graph-first-session-detail);"对话线程化 / agent 卡 / 检查器"
是对话投影的信息设计,不是默认产品轴。

三条产品原则必须贯穿:①按用户问题组织界面,不照搬后端结构;②少即是多,每屏一个主问题;
③语言自然,空态说人话("没有记录")。

硬约束:
- AGENTS.md 全部不变量:provider 数据只读、结构渲染语义(推理不跨消息边界、TOC 仅
  用户/助手/任务)、页面结构在 src/views/、交互在 src/static/app.js、样式在
  src/static/style.css、E2E 断言同步、zh/en 双 locale、不引入任何运行时依赖;
- 迁移按证据有界:只移除"所属结构已被替换且当前无消费者"的旧 CSS 选择器、旧 data-* 钩子
  与 app.js 选择器(以 grep 无引用为准);保留主题变量、语义色板、可访问性与无关行为;
  不写兼容层,不批量清理无关文件;
- 视觉:本会话没有视觉能力——视觉只做朴素、正确、可用的实现:继承现有 style.css 的
  明暗主题变量与语义色板(推理紫/工具青/任务绿等)作为起点,不发明新视觉语言;
  视觉精修由用户评审后另行指定;
- 动手前先核对后端现状:读 docs/specs/work-graph-protocol/design.md 的 Evolution
  backlog、docs/specs/runtime-protocol-workbench/design.md §10、
  .agents/decisions/proposed/ 与 implemented/ 最新记录。当前事实:Codex native v3
  映射与 0.151+ 用户消息恢复已完成;usage origin 聚合(核心后端工作)与环境事件种类
  未落地;git 关联保持 proposed、不实现。已落地的字段按 docs/design/ui-v2.md §7 接入;
  未落地的如实降级,UI 不发明;
- 验收数据:Codex 会话 01a0576a-98e2-7c31-a265-6d98d5fbff12(长会话,13 任务/
  13 子代理/10× 压缩,研究时点 2026-09-02;消息数随时间增长不作为固定事实)、OpenCode 长会话、DSH 会话;每次改动跑 npm run build、
  npm test、npm run check:governance;views/static/locales 变更补 npm run qa:e2e;
- 每阶段独立可审查提交;非平凡变更走 .agents/decisions/ 生命周期;P0 完成先给用户看。

UI 重设计前置条件(2026-09-03 已满足):
- 必需能力:前端设计翻译、真实浏览器功能/视觉 QA、持久浏览器调试、截图;
- Codex 官方 skills 已装:figma、figma-implement-design、playwright、
  playwright-interactive、screenshot;仓库可重复 E2E 路径仍是
  `scripts/qa-agent-browser.sh`(agent-browser),不依赖 playwright skills;
- figma/figma-implement-design 仅在任务包含 Figma 源文件时有用,须显式连接,
  不得声称已安装/已连接;
- 实现开始前先建 QA 清单:映射需求 → 控件/状态与预期断言、viewport(320/768/1280)/
  主题(light/dark)/locale(zh/en)覆盖、至少两个非 happy-path 场景。

按 P0→P4 顺序执行,每阶段开始前读对应 prompt。
```
