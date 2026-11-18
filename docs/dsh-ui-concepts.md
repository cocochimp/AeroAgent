# AeroAgent DSH UI Concepts

这四个名称用于代码、测试、文档和后续对话，避免同一区域被叫成不同东西。

| 概念 | 英文名 | 位置 | 技术实现 |
|---|---|---|---|
| 业务导航 | Business Navigation | DSH 左侧栏上部 | `sidebar.panellist`；当前为「退改对话 / 我的订单 / Listing / 低价监控」 |
| 学习导航 | Learning Navigation | DSH 左侧栏下部、「当前用户」上方 | `sidebar.footer.action` 内的单列行式导航；当前为「评测 / 规则 / 数据」 |
| 执行观测栏 | Execution Inspector | DSH 右侧栏 | `sidebarRightTabs` + `sidebar.right.pane.tab`；含流程、检索、记忆、校验 |
| 客票上下文条 | Order Context Bar | DSH 原生对话 composer 上方 | `conversation.input.dock`；展示当前绑定客票与退改快捷操作 |

## 约束

- 业务导航只打开 DSH 原生主面板或原生会话，不创建第二个应用外壳。
- 「退改对话」进入 DSH 原生会话，确保执行观测栏保持挂载。
- 学习导航与当前用户共享一个原生 footer action，内部纵向排列并使用与业务导航相同的整行样式。
- 客票上下文条只绑定客票或填充草稿，不自动发送消息、不创建案件。
- 执行观测栏只使用 DSH 右侧栏生命周期，不自行绘制固定右栏。

## 稳定选择器

- 学习导航：`[data-aeroagent-learning-nav]`
- 当前用户：`[data-native-user]`
- 执行观测栏：`[data-aeroagent-execution-inspector]`
- 客票上下文条：`[data-aeroagent-order-context-bar]`