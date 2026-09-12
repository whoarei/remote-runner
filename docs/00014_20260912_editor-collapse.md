# 00014 文件编辑区可折叠

日期：2026-09-12
状态：已实现

## 背景

00008 让 Workspace / Run History / 控制台三个区域都可折叠，唯独中间的文件编辑区
始终占满剩余高度。长时间盯终端输出（如刷日志的脚本）时，无法把编辑区收起来给
控制台腾出整个工作台高度。

目标：

1. 编辑区可折叠为一条标题条，释放的高度由展开中的控制台自动占满。
2. 折叠 / 展开不丢失 CodeMirror 的撤销历史、滚动位置与选区。
3. 折叠状态随布局持久化，重启后恢复。

## 非目标

- 不做编辑区的显隐开关（菜单「视图」不新增条目）；未打开文件的空态不提供折叠。
- 不做多标签编辑器；折叠粒度是整个编辑区，不是单个文件。

## 设计

### 布局状态（`src/layoutState.ts`）

`LayoutState` 新增 `editorCollapsed: boolean`，默认 `false`；`DEFAULT_LAYOUT` 与
`normalizeLayout` 各加一行逐字段回落。持久化 key 不变（`remote-runner.layout.v1`），
旧数据缺该字段时自动回落 `false`。

### 折叠交互（`src/components/Editor.tsx`）

- 折叠入口是 `.editor-title` 标题条内文件名左侧的 chevron 按钮
  （`.editor-collapse`，`aria-expanded` + 「折叠/展开编辑区」aria-label）。
  不使用 `PanelTitle`：标题条上已有语言选择、保存按钮等交互控件，
  整条点击切换会误触。
- 折叠后只保留标题条（文件名、脏标记 ●、语言选择、保存按钮仍可用）；
  CodeMirror 与 `.editor-status` 包在 `.editor-body` 容器内，折叠时加
  `.collapsed`（`display: none`）隐藏。
- 编辑器保持挂载、仅 CSS 隐藏（同 RunConsole 折叠终端的做法），撤销历史、
  滚动位置、选区全部保留，展开即恢复；CodeMirror 依赖自身 ResizeObserver
  重新测量，无需手动 refresh。
- 未打开文件时（空态提示页）不渲染折叠按钮。

### 布局行为（`App.tsx`）

- `.center` 在 `editorCollapsed` 时改为 `flex: 0 0 auto`，收缩为标题条高度。
- `.app-footer` 高度逻辑：`consoleCollapsed` 时不变（内容自适应）；否则
  `editorCollapsed` 时用 `flex: 1` 撑满工作台剩余高度（忽略 `consoleHeight`），
  其余情况维持固定 `consoleHeight`。重新展开编辑区后控制台恢复原高度。
- 控制台高度分隔条在编辑区折叠期间隐藏（拖拽它当时没有可见效果），
  展开编辑区后恢复。
- 编辑区折叠 + 控制台也折叠 / 隐藏时，工作台中部留空，与侧栏双面板都折叠的
  现有行为一致。
- `store.openWorkspaceFile` 打开文件成功后，若 `editorCollapsed` 则自动展开，
  避免点了文件却看不到内容。

## 测试

- `tests/layout.test.ts`：`normalizeLayout` 保留合法 `editorCollapsed`、
  对错误类型回落默认值。
- 验证：`npm test`、`npm run build`、`git diff --check`。

## 风险与限制

- 折叠期间控制台以 `flex: 1` 撑满，`consoleHeight` 的拖拽结果在编辑区重新展开
  前不可见，但值本身仍被保存，不会出现高度跳变。
- 编辑区折叠时保存、语言切换、冲突提示等标题条功能不受影响；`Esc` 焦点转移
  仅在编辑器可见时可达。
