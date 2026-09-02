# 后端演进 · 任务 C:会话 ↔ git commit 关联(评审,暂不实现)—— 后续可选增强

```text
定位:后续可选增强、低优先级,排在核心 provider/ownership 工作(任务 A +
provider-native v3 映射)之后。当前只做**评审**,不实现。
决策记录 .agents/decisions/proposed/2026-09-03-session-git-commit-association.md
保持 proposed。

本能力(若未来实现)的边界(已有计划):本地 git 只读;会话时间窗与 git log
相关;**目前会话 summary 只有文件数量(+N −N),没有文件路径**——基于路径的匹配
必须延期:若未来能从会话内已记录 tool/edit evidence 有界提取路径,需先调研
证明(记录形状、有界提取规则、提取证据),在此之前只能做时间窗重叠相关,
且必须明确展示为“时间窗重叠(弱相关)”,不得表述为“提交关联”;
在会话详情展示为**查看器侧派生关联**(非 provider 事实,标注派生);
无 git 仓库或无可疑匹配时不显示;不得新增 opt-in 配置项或 API/安全面,除非有
真实消费者(当前没有;**“用户问题真实”不等于“已有实现消费者”**)。

工作流:主 agent 提供本 spec;由 pi-wsl `pi_task` 执行;独立 `pi_review` 只读审查。

任务:
1. 读决策记录与 docs/design/ui-v2.md §11 第 11 条、§7(信息设计对"文件改动"的展示);
2. 评审匹配启发式是否证据有界:时间窗宽度、路径匹配口径(注意:当前会话
   summary 无路径,路径匹配未经调研证明,只能作为前瞻方向不能作为既有事实)、
   多提交并列时的呈现、派生关联标注是否清晰、是否遵守"不写 git、不写 provider
   数据"的边界;纯时间窗相关必须降级展示为弱相关,不得宣称提交关联;
3. 评审结论写回决策记录(Consequences/Verification),保持 proposed;
   若评审发现原则性问题(例如无法做到有界/只读),转 rejected 并写明理由;
4. 不实现:不写 server 端 git 模块、不动 API/SSR/UI、不新增配置面;
5. 验证:npm run check:governance(记录格式与链接)。

完成动作:交独立 pi_review 只读审查(评审意见本身有界,不扩散);主 agent 汇总验收。
```
