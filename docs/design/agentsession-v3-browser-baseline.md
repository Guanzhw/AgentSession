# AgentSession 3.0：冻结的 2.0 浏览器基线

本次观察于 2026-09-26 在 `http://127.0.0.1:3468` 的冻结 2.0 服务上完成，
基线提交为 `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`。
本文记录旧产品行为，不构成 3.0 验收通过的证据。

## 环境与证据

Agent-browser 使用隔离的 Chromium 会话（`v3-baseline-3468`）、
1440 × 1000 桌面视口和已有的隔离功能验证服务。
按 provider 和语料角色从 `tmp/v3-corpus/manifest.private.json` 选择会话。
服务使用 `tmp/v3-corpus/v2-functional-meta.db`。观察结束后已关闭浏览器会话。

截图、可访问性快照、导航输出和私有定位信息均位于被 Git 忽略的目录
`tmp/v3-corpus/browser-baseline/`。这些文件包含私有会话文本和标识符，
必须保留在本地。下文公开结论仅使用语料角色标识。
本次未执行收藏、重命名、删除、恢复会话或设置操作，也未操作已有的 3456 端口服务。

## 观察结果

| 语料案例 | 检查与结果 | 本地证据文件名 |
| --- | --- | --- |
| Pi，`available-live` 短会话 | 打开 provider 列表，点击实际会话链接，目视确认初始请求与助手回复同时可读。两个目录条目均存在；点击最后一个条目可定位到已存在的消息目标。浏览器后退恢复 `/pi` 列表；前进恢复详情及用户、助手两类消息。 | `pi-list.txt`, `pi-detail.txt`, `pi-final.png`, `pi-repeat.txt`, `pi-anchor-back.txt`, `pi-anchor-forward.txt` |
| Codex，`long-team-compaction` | 打开 provider 列表并点击选定会话链接。初始请求与助手回复可读。桌面目录显示用户、助手、任务和压缩检查点条目。点击第一个续载按钮后，剩余分段按钮从 6 个减少为 5 个，已加载 37 个消息元素。 | `codex-list.txt`, `codex-detail.txt`, `codex-detail.png`, `codex-segment2.png` |
| Codex，后段目录与来源导航 | 点击最后一个目录链接未能加载对应消息，页面显示 **“Unable to load recorded event.”**（无法加载记录事件）。直接重新打开详情后可复现同一失败。链接指向同一个规范会话。点击第一个 `a[data-reader-source]` 也未能建立目标定位（无 hash 目标，阅读器状态非空）。后段跳转失败后执行后退、前进仍未建立目标，因此本案例尚未验证来源跳转历史能够成功恢复。 | `codex-toc.private.json`, `codex-late-anchor.png`, `codex-late-anchor-repeat.png`, `codex-source.png`, `codex-back.txt`, `codex-forward.txt` |
| DeepSeek Harness，`native-v3-packed-compaction` | 打开 provider 列表并点击选定会话链接。初始请求与助手回复可读。首次续载后，剩余分段按钮从 10 个减少为 9 个，已加载 13 个消息元素。点击 327 个目录链接中的最后一个后加载了后段内容：共 27 个消息元素、8 个剩余按钮，hash 目标存在，阅读器状态为空。截图显示最后一个助手条目被选中，其回复出现在视口内。从新打开的详情页重复后段跳转后，后退移除了 hash，前进恢复了已存在的目标。 | `dsh-list.txt`, `dsh-detail.txt`, `dsh-detail.png`, `dsh-late-anchor.png`, `dsh-history.txt` |

DSH 的语料角色描述 provider 记录的原生 v3 文件格式；本次观察的应用仍为 AgentSession 2.0。

## 失败与覆盖范围

上述 Codex 后段锚点失败是本次观察到的 2.0 基线缺陷，应作为明确的对照案例保留，
不能计为导航成功，也不能作为 3.0 必须复制的预期行为。
本次只读浏览器检查未调查其根因。

检查结束时，浏览器 `errors` 和 `console` 捕获均为空（`errors.txt`、`console.txt`）；
即使没有捕获到控制台错误，页面可见的 Codex 错误仍属于有效观察结果。
检查脚本出现两次操作错误：PowerShell 中未加引号的元素引用触发缺少参数错误；
一次 DOM 探测使用了无效 CSS 选择器。相关 Pi 导航已使用有效选择器重做，
并明确断言后退、前进结果。首次 Pi 快照在导航稳定前截取，结果为空；
后续检查使用 `wait --load networkidle`，捕获了加载完成的页面。

本次覆盖三个选定会话的有限桌面观察，未覆盖完整 E2E 套件、性能基准、
全部来源链接审计或 provider 内容正确性评估，也未作出耗时验收结论。
