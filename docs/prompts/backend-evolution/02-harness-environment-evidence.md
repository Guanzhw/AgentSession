# 后端演进 · 任务 B:harness 环境证据(启用清单 + 环境重载)—— 后续可选增强

```text
定位:后续可选增强,排在核心 provider/ownership 工作(任务 A + provider-native v3 映射)
之后评估。证据优先——先调研,再决定是否落协议;若没有 provider 记录证据,
backlog 如实标注 waiting-evidence,不落代码、不建 UI 单点。

任务:回答两个问题——"会话启用了什么(skill/plugin/hook)"与"会话中何时重载了
harness 环境"。二者都是环境域证据,一起做证据调研,产出 spec 决策。

工作流:主 agent 提供本 spec;由 pi-wsl `pi_task` 执行;独立 `pi_review` 只读审查。

步骤:
1. 证据调研(先看证据再定方案):逐个检查已安装 provider 的真实数据与 parser,
   是否记录了技能/插件/钩子的启用清单或会话中途的环境变更;
   OpenCode 侧重点看系统提示词重构机制(src/providers/opencode/ 与
   shared/system-prompt-evidence.ts,resolved 来源)能否给出"启用了什么";
   Codex/Claude/Pi/OpenClaw/Hermes 逐一确认;DSH(运行时热更新)暂不考虑;
2. 决策一(启用清单):基于证据在两条路线中选择并写进 work-graph spec backlog §2——
   a) 不新增协议域,沿用 artifact kind=skill + resolved 系统提示词证据;
   b) 协议新增 environment/inventory 域。给推荐与理由;
3. 决策二(环境重载):若找到记录证据,在 runtime-protocol-workbench §10 定义
   normalized kind(建议 environment.reloaded / environment.loaded,category control),
   并更新 session-protocol.ts 事件词汇与 fixtures;若没有 provider 记录,
   如实把 backlog 标注为 waiting-evidence,不落代码;
4. 证据结论补充进 docs/specs/work-graph-protocol/evidence-matrix.md;
   非平凡决策建决策记录;同步 docs/design/ui-v2.md §4.6/§7 相关行;
5. 验证:npm run build && npm test && npm run check:governance。

完成动作:交独立 pi_review 只读审查;主 agent 汇总验收。
```
