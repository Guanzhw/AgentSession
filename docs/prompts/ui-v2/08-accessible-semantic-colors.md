# UI v2 · 任务 08：语义色对比度收口

## 证据

现有 UI v2 视觉审计确认三个 WCAG AA 文本对比度缺口：

- 深色主题 `.runtime-status-completed` 使用 `--success-border`，约 2.44:1；
- 深色主题 Statistics 当前 provider/checked provider 使用白字叠加浅色 accent，约 2.23:1；
- 浅色主题 `.stats-provider-capability.filter` 使用 muted 文本，约 4.12:1。

## 实施

只修改 `src/static/style.css` 与必要 CSS contract 测试：

1. completed 文本使用已有 `--success-text`，边框仍可使用 `--success-border`；
2. Statistics accent 实底上的文字使用已有 `--v2-accent-foreground`，同时覆盖 current
   link 与 checked selector；
3. filter capability badge 文字使用已有 `--text-secondary`；
4. 不新增孤立色值、不改变布局、不修改生成的 `dist/`；
5. 测试锁定语义变量而非具体十六进制值。

## 验收

- `npm run build`、相关 focused tests、`git diff --check`；
- 浏览器在浅/深主题检查 Runtime completed 状态和 Statistics provider 控件；
- 与同批 Execution usage 文案一起做统一独立审查。
