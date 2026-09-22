# Reader 反馈修订：执行账本

更新：2026-09-23。[requirements](requirements.md) 定义验收，[design](design.md) 定义实现。
此页是 R6 唯一逐项状态来源；此前 R5 结果不代替本批验收。

## 当前阶段

S1–S3 实现及 S4 本地验收完成，正在提交与发布。发布版本：1.10.0。
最终源码通过 1,070 项测试、230 个步骤的整站桌面 E2E、七类实际浏览器续读检查、
双 npm 安装包及 Windows 独立程序验收。独立审查问题已关闭。

| 阶段 | 反馈 | 实现与验收状态 |
| --- | --- | --- |
| S0 | 十五项规格与 Q1–Q3 取舍 | 已明确；以窄侧轨、最后交互收尾、同标题独立行推进 |
| S1 | F03 左右对齐 | 主/子历史用户块靠右、正文文字左对齐；真实 Codex 子历史与 E2E 通过 |
| S1 | F04 来源入口 | 单一“查看事件详情”；DSH 实录展开、打开精确事件及 Back 通过 |
| S1 | F05 子历史附着 | Codex rewrite_coordinates_lesson 子历史挂在原卡片 body；关闭返回及焦点通过，E2E 子历史路径通过 |
| S1 | F08 相邻过程合并 | 实页曾暴露协作卡片后的尾部过程遗漏，已修复；真实 teaching_devils_advocate 后 2+1 合为 3，1+5 精确回归 fixture 合为 6 |
| S1 | F12/F13 续读与格式 | 真实 retained-context 保持单 PRE、前缀不变；浏览器加载完段落、列表、嵌套列表、表格、围栏、CRLF 原文和超大不可拆分块，七类均为单一连续内容面，内容完整 |
| S2 | F06/F07/F09 成员轨道 | 10 成员 Codex 实录中所有关联卡片紧凑且样式稳定；未知虚线消除；往返滚动正文文档坐标最大差 0.00013 px，保留轨道横坐标不变 |
| S2 | F10/F11 异步任务 | 截图对应真实记录已展示命令/输出摘录、全程 37 秒/分离后 6 秒及互跳括线；合成浏览器样本验证四条独立槽位、第五条聚焦替换和未返回不补箭头 |
| S2 | F14 常驻面板 | 1920 桌面停靠、普通桌面贴边浮出；开关/aria/Escape 焦点通过；全站 E2E 改为检查新的可见入口，隐藏旧 summary 只保留 fallback 单测 |
| S2 | F15 压缩目录 | 真实 Codex 两个 checkpoint 各有目录节点；点击展开实际保留内容，修正后标题 top=95 px，不被顶栏遮住；拥有关系与多次压缩自动回归通过 |
| S3 | F01 正常库入口 | 3456 正常服务七 provider 均可用，交付重启时 843 条扫描记录；3466 是隔离 DSH Teams 验收样本，交付入口使用 3456 |
| S3 | F02 同标题辨认 | 真实评测目录 41 个独立 ID、21 个问题组；保留各行，显示问题原文摘录、精确 UTC 和 ID。审查后改为最少共享文本优先，避免公共开场白遮住后续差异 |
| S4 | 审查、完整验证、提交/推送、发布 | 本地验收完成，远端 CI 与发布确认中；最后结果追加在下方 |

## 实际验证记录

- `npm test`：1,070/1,070；无失败/跳过。日志 `logs/spec-feedback-release-test.log`。
- `npm run qa:e2e`：230 个操作/检查步骤，返回 `ok: true`，浏览器错误为空；
  日志 `logs/spec-feedback-release-e2e.log`。覆盖 Library、统计、设置、Reader、搜索、
  子历史、键盘、返回、主题与桌面 reduced-motion。无窄屏新增验证。
- E2E 调整经过：首次未声明 terminal-launch-disabled 导致设置预期错误；一次 browser
  transport timeout 后按纪律重试；旧末尾 summary 已隐藏，故更新测试为新的常驻入口而非强制聚焦隐藏元素。
- 人工实页：Codex `01a0a037-4a13-79b3-882c-aeffacb1dd03` 的成员、过程、子历史、目录；
  `01a042e8-f0d0-7282-ab5b-53982f4b551a` 的异步任务与 retained-context 续读；
  DSH 原生 Teams 样本的发送、送达、正文和事件返回；同标题评测目录。
- 独立审查发现并修正：异步摘要完整 JSON 序列化、侧栏焦点所有权、协作尾部过程遗漏、
  差异摘录误选公共文本、并行异步括线槽位重叠和 Markdown 超长结构分页。最终独立源码审查无新发现。
- 最终整合期间，一次全量测试中的两项 DSH inherited-context 测试返回 null，独立重跑 5/5、
  DSH 相关 38/38 及最终全量 1,070/1,070 均通过，尚未复现原因；撤回了缺少证据的测试顺序猜测修改。
  同次发现的 Markdown 段落边界回归已修复并纳入最终验收。
- 合成续读页直接使用 production renderer 和浏览器代码：七类内容全部加载至无 Show more，
  与一次性渲染或完整源文本比对一致；嵌套列表与表格实页视觉检查通过。
- 两个 1.10.0 npm tarball 安装至隔离目录后，Viewer、七 provider 不可用路径、内嵌资源及
  MCP 初始化/五项工具通过。Windows x64 SEA 构建和 `npm run smoke:binary` 通过。
  日志 `logs/spec-feedback-packs.json`、`logs/spec-feedback-binary.log`，样本与安装在 `tmp/`。
- `npm run review`、最终 `npm run pre-push` 与 `git diff --check` 通过。
- 3456 已恢复默认启动配置；settings API 确认 `terminalLaunchAllowed: true`，七 provider
  可用且错误日志为空。浏览器视口已恢复默认，正式 Reader 页面已重新加载。

## 发布检查

- [x] 最终分页修复及浏览器续读验收。
- [x] 最终全套测试、集中审查与打包验证。
- [ ] 恢复正常服务、最终 pre-push、窄范围提交和推送。
- [ ] 远端 main SHA 与 Node 22.15.0 / 26.5.0 CI 通过。
- [ ] 版本标签、npm 两个包与四平台 binary 发布确认。

原 provider 历史只读。运行日志、截图与合成样本留在 `logs/`、`tmp/`，不提交原始会话。
此前 lockfile 修改仅为五处版本行尾差异；本次发布只同步这五处版本值与包内依赖。
