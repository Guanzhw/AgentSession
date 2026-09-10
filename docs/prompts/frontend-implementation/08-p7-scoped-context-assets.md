# 前端实现 · P7：按 scope 展示长期上下文资产

## 已验证事实

1. Session Protocol v3 已有 `ContextArtifact` 的 `kind`、`scope`、`origin`、
   `contentAccess`、title/summary、source path、producer run/event、source sessions、
   consumer/citation/inheritance 关系；Context projection 已有界暴露这些实体与关系。
2. 当前 Context UI 把所有 artifact 平铺为 `title · kind · scope`，没有兑现 UI v2 对
   memory / experience / user-info 按 session / agent / project / user / organization scope
   浏览的设计，也没有呈现 metadata-first 摘要与访问状态。
3. 2026-09-10 真实 API 抽样中，长 Codex 会话
   `01a0576a-98e2-7c31-a265-6d98d5fbff12` 暴露 36 个
   `summary/session/metadata-only` artifact 且投影截断；DSH 当前样本也只有
   `summary/session/metadata-only`。Claude Code、Pi、OpenCode 最近样本未暴露 artifact。
   因而当前没有证据允许把 summary 当 memory，或为 provider 发明长期资产。
4. OpenClaw provider 已由用户冻结；不得修改或为本阶段读取其 provider 语义。

## 目标

- 在 Context lens 中提供一个默认折叠的 “Memory & experience / 记忆与经验” 检查区。
- 只收纳 kind 为 `memory`、`experience`、`user-info` 的长期资产，并按固定 scope 顺序
  `session → agent → project → user → organization` 分组。
- 每项以标题/本地化 kind、短摘要、origin、contentAccess、时间和已有来源关系呈现；
  完整证据仍通过 evidence drawer 查看，绝不复制 transcript 或 compact 文本。
- 保留其他 artifact（summary / instruction / skill / rule）的现有可达性，不重复展示。

## 实现边界

1. 只修改共享 SSR view、locale、CSS、测试、设计/决策文档和必要的 QA hook；不得修改
   Session Protocol、projection、provider adapter/parser/builder、索引、数据库或 token 计算。
2. 长期资产 section 始终是同一个可发现入口，默认折叠。无匹配项时只声明“当前有界视图未记录
   长期资产”；不得把空数组解释为 provider unsupported。若 `projection.truncated`，文案必须
   表明计数与缺失判断只覆盖当前有界视图。
3. scope 只使用协议枚举，不从路径、标题或工具名推断。只渲染有条目的 scope 组；顺序稳定。
4. 卡片标题优先 recorded title；否则使用本地化 kind，不以原始 id 充当主标题。summary 仅在
   recorded non-empty 时展示，且必须转义。`contentAccess` 只描述可用性，不暗示 UI 已加载正文。
5. 来源关系只使用 projection 中已记录的 artifactSessions / artifactRuns / artifactEvents /
   artifactInheritance 与 artifact 自身 producerRunId/producerEventId。session ref 使用 canonical
   provider/session 链接；没有关系时不显示伪造的来源。
6. 非长期 artifact 继续在一般 Context artifacts 区显示；长期资产从该列表移出，确保只出现一次。
   compact summary 必须继续属于一般 artifact，不进入“记忆与经验”。
7. 所有新增字符串进入 en/zh locale；窄屏不得产生页面横向溢出，长标题、摘要和 canonical id
   可换行，badge 不逐字断行。
8. 建立并完成 P7 decision record。OpenClaw/provider 路径保持零改动。

## 回归覆盖

- synthetic v3 fixture 覆盖三种长期 kind、五种 scope、title fallback、summary escaping、
  origin/contentAccess、source session/run/event/inheritance、稳定顺序和一次性呈现。
- summary/instruction/skill/rule 仍在一般 artifacts；summary 不进入长期资产区。
- 无长期资产、projection truncated、无来源关系均使用诚实文案。
- locale key 集一致；CSS/markup hooks 覆盖默认折叠、scope group、card 与窄屏 wrapping。

## 真实验收

- `npm run typecheck`、focused tests、`npm test`、`npm run review`、`npm run pre-push`、
  `git diff --check`。
- 真实 Codex Context API 保持 36 个 bounded summary artifacts，不出现虚构 memory；真实页面
  一般 artifacts 可达，长期资产入口为空且带 bounded 语义。
- 真实 DSH summary-only 样本同样不被误分类；Claude Code/Pi/OpenCode 空 artifact 降级正确。
- 浏览器至少覆盖 1280/768/320、英中和 light/dark，检查折叠、展开、换行、无横向溢出与错误。
