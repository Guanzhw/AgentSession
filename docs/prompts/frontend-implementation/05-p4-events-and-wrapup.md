# 前端实现 · P4:事件标签 + 收尾

```text
P4 目标:事件标签落地 + 全局收尾(§4.5/§4.7 场景 5–8、§6)。

范围:
1. 事件标签:页首用途说明一句话;事件类型分布(可点过滤)+ 事件流(序列号/类型/摘要/
   原始·推断标识)+ 事件详情抽屉(原生 dialog);协议版本号、覆盖状态、原始 ID 放这里;
2. 统计页(§4.8)与设置页(§4.9)对齐新信息结构(数据源状态一行式);
3. ⌘K 命令面板、键盘规范(§6 表:1–3、/、j/k、t/d、Esc);
4. 后端已落地的能力接入:git“相关提交”区——决策记录保持 proposed、不实现;若未来
   implemented,仅接只读派生展示(有界、标注派生、非 provider 事实);
   环境事件种类——若协议已定义(§10 backlog 的 normalized kind)才接;
   只接已落地的,未落地如实降级;
5. E2E:scripts/qa-agent-browser.sh 断言随新结构更新——只重写被替代结构的断言
   (新标签结构、新选择器),保留仍成立的选择器与断言(证据有界,与 src/static/app.js
   同步重命名);双 locale 全部新文案补齐;
6. docs/design/ui-v2.md §7 绑定表与实际字段核对一致,§9 各阶段验收打勾。

验收:npm run build && npm test && npm run check:governance && npm run qa:e2e
(中英双实例)全绿;§4.7 八个场景走查全部通过;git status 干净,无 dist/ 与临时产物。
完成动作:UI v2 决策记录更新 Verification 为最终结果;README/README.en.md 用户可见
变化(导航、标签)同步。
```
