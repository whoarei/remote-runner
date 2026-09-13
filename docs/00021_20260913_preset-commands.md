# 00021 预置命令面板

日期：2026-09-13
状态：已实现

## 背景与目标

常用远程命令（查 CPU、看日志、清理磁盘等）每次都要在运行工具栏手工输入。目标是在侧栏加一个「预置命令」面板：用户配置名称 + 命令 + 运行参数，双击即对当前选中的设备执行，无需重复输入。

## 方案

- 数据模型（`src/presetCommands.ts`）：`PresetCommand { id, name, command, consoleMode, timeoutSecs }`。`normalizePresets` 对任意输入逐条校验——丢弃缺名称/命令的条目、id 去重（缺失则生成）、名称 60 / 命令 2000 字符截断、超时钳制到 0–86400 秒、总数上限 100 条。
- 持久化：localStorage（`remote-runner.presets.v1`），与布局、语言偏好同级；读写包 try/catch，损坏数据静默回落空列表。不经过 Rust——命令文本最终在 `startRun` → `run_script` 时仍走后端既有校验，安全模型不变。
- 面板（`src/components/CommandsPanel.tsx`）：复用 `PanelTitle`（可折叠 + 标题栏 ＋ 添加按钮）、`ContextMenu`（条目右键运行/编辑/删除）、`ConfirmDialog`（删除确认）。新增/编辑走模态对话框（`PresetEditDialog`，`<dialog>` 元素，模式同 `ConfirmDialog`）：命令可能是长命令或多行脚本，用 `textarea`（等宽字体、可纵向拉伸）编辑；名称或命令为空时保存按钮禁用，Esc/取消关闭不保存。
- 双击执行：以 `kind: "command"` 构造 `RunRequest`，设备取运行工具栏当前选中项，工作区取当前工作区，复用 `startRun` 全流程（含脏文件先保存、状态跟踪、历史记录）。串口设备只有合并输出，强制 `pty`（与 `RunToolbar` 行为一致）。未选设备时在状态栏报错。
- 布局（`layoutState.ts` / `App.tsx`）：新增 `commandsVisible` / `commandsCollapsed` 两个字段，旧布局数据经 `normalizeLayout` 自动回落默认值（显示、展开）。预置命令面板不参与 `sideSplit`（工作区/历史比例保持原语义）：有其他展开面板时 `flex: 0 1 auto` 且 `max-height: 45%`，独占侧栏时占满。侧栏整体显隐条件纳入 `commandsVisible`。
- 菜单：「视图 → 预置命令面板」开关，与另外两个面板一致。

## i18n

新增 `commands.*` 域与 `menu.commandsPanel`，zh 为事实标准、en 编译期约束。表单中的 console 模式 / 超时提示复用 `run.consoleModeTitle` / `run.timeoutTitle`，取消按钮复用 `dialog.cancel`。

## 测试

`tests/presetCommands.test.ts`（已加入 `scripts/test.mjs` 条目）：normalize 对垃圾输入/缺字段/重复 id/超长字段/超上限的处理，以及 load/save 往返与损坏存储的回落。

## 明确不做

- 预置命令不绑定固定设备（双击总是对当前选中设备执行，保持心智简单）。
- 不做导入/导出与跨机同步（localStorage 本机持久化已满足场景）。
- 不支持变量插值（如 `${workspace}`），命令原样发送。
- 不拖动排序；顺序即添加顺序。
