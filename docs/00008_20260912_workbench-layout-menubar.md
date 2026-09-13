# 00008 可调整工作台布局与标题栏菜单

日期：2026-09-12
状态：已实现（布局状态结构与渲染机制已由 00022 重构为统一 Dock / Panel 注册表架构，
本文的字段定义以 00022 为准）

## 背景

原界面布局完全固定：左侧栏（Workspace + Run History）260px，底部控制台区 42% 高，
均不可调整、不可隐藏；自定义标题栏左侧显示 "Remote Runner" 应用名，"关于" 以独立
按钮占用标题栏空间，打开工作区的入口只在 Workspace 面板内。

目标（参考 VSCode 的常用交互，但不实现完整的自由拖拽停靠系统）：

1. Workspace / History / Run Console 三个区域可拖拽分隔条调整大小，可独立隐藏，
   侧栏可在左 / 右之间切换。
2. 标题栏不再显示应用名称，改为菜单栏（文件 / 视图 / 帮助）。
3. "打开工作区"、"最近的工作区"、"关于" 移入菜单栏。
4. 布局状态（尺寸、显隐、位置）持久化到 localStorage，重启后恢复。

## 非目标

- 不做 VSCode 式的任意面板拖拽停靠（拖动面板标题到任意区域）。该能力需要自研
  docking 系统，投入产出比低。
- ~~DeviceBar（设备选择栏）保持原位，不迁入菜单。~~（后续调整：设备栏已移除，
  设备选择并入运行工具栏，添加 / 编辑设备移入「文件」菜单，对话框为 DeviceDialog.tsx。）
- Rust 后端无改动。

## 设计

### 布局状态（`src/layoutState.ts`）

```ts
interface LayoutState {
  workspaceVisible: boolean;   // Workspace 面板显隐
  historyVisible: boolean;     // Run History 面板显隐
  consoleVisible: boolean;     // 底部控制台区（RunToolbar + RunConsole）显隐
  workspaceCollapsed: boolean; // Workspace 折叠（只显示标题条），独立于显隐
  historyCollapsed: boolean;   // Run History 折叠
  consoleCollapsed: boolean;   // 控制台折叠（保留运行工具栏与标题条）
  editorCollapsed: boolean;    // 编辑区折叠（00015 新增：保留编辑器标题条，控制台占满释放的高度）
  sidebarWidth: number;        // 侧栏宽度 px，范围 [SIDEBAR_MIN, SIDEBAR_MAX]
  sidebarPosition: "left" | "right";
  sideSplit: number;           // Workspace 占侧栏高度比例，范围 [0.2, 0.8]
  consoleHeight: number;       // 控制台区高度 px，范围 [CONSOLE_MIN, CONSOLE_MAX]
}
```

- 侧栏可见性为派生态：`workspaceVisible || historyVisible`，不单独存储。
- 折叠通过面板标题条（`PanelTitle` 组件）点击或 Enter/Space 切换；两个面板都展开时
  才显示侧栏内的比例分隔条，任一折叠时另一个占满剩余空间，折叠面板收缩为标题条
  （`flex: 0 0 auto`）。
- 控制台折叠只隐藏终端区域（RunToolbar 保持可见），高度分隔条同时隐藏；xterm 实例
  保持挂载、DOM 以 `display: none` 隐藏，展开时由 ResizeObserver 自动 refit，
  避免终端重挂和输出状态丢失。
- 纯函数：`normalizeLayout(value: unknown)` 对任意输入（坏 JSON、缺字段、越界值）
  逐字段回落默认值并 clamp；`clampSidebarWidth / clampConsoleHeight / clampSideSplit`
  供拖拽时实时约束。
- 持久化：localStorage，key 为 `remote-runner.layout.v1`，读写均容错（失败仅告警），
  与 `workspaceHistory.ts` 同一模式。
- zustand store 增加 `layout` 字段和 `setLayout(patch)` / `resetLayout()` action；
  每次变更经 normalize 后写回 localStorage。

### 分隔条（`src/components/SplitHandle.tsx`）

- 通用受控组件：props 为 `direction`（vertical 调宽度 / horizontal 调高度）、
  `onDelta(deltaPx)`、`onReset`、`label`。
- Pointer Events 实现：`pointerdown` + `setPointerCapture` 捕获，`pointermove`
  上报相对上一事件的像素增量，`pointerup/pointercancel` 结束。增量语义交由父级
  解释（如右侧栏宽度 = 宽度 - delta），组件自身不持有布局状态。
- 双击调用 `onReset` 恢复默认尺寸。
- 拖拽期间给 `document.body` 加 `split-dragging-{vertical,horizontal}` class，
  禁用文本选择并固定光标。

### 菜单栏（`src/components/MenuBar.tsx`）

渲染在 TitleBar 左侧（应用图标之后，替换原 logo + 应用名组合中的名称部分），
窗口控制按钮保留在右侧。

- **文件**：打开工作区… / 最近的工作区（子菜单，来自 `recentWorkspaces`，选中即打开）/
  添加设备… / 编辑设备（子菜单列出现有设备，选中即打开 DeviceDialog 编辑该设备，
  无设备时禁用）/ 保存文件（有未保存更改时可用）/ 关闭文件（00016 新增，有打开
  文件且空闲时可用）/ 退出（仅 Tauri 桌面环境可用，
  走 `close()` 以触发未保存确认）。
- **视图**：工作区面板 ✓ / 历史面板 ✓ / 控制台面板 ✓ / 侧栏位置（左侧 · 右侧）/
  重置布局。
- **帮助**：关于 Remote Runner…（打开现有 AboutDialog）。

交互：点击菜单标题展开，展开后 hover 切换相邻菜单；点击菜单外部或按 Escape 关闭；
选择任意项后关闭。子菜单 hover 展开。使用 `role="menubar" / "menu" / "menuitem" /
"menuitemcheckbox"` 语义。菜单区不属于 `data-tauri-drag-region`，下拉框绝对定位。

### 工作区选择提取（`src/workspacePicker.ts`）

把原 `WorkspacePanel.choose()` 的目录选择逻辑提取为 `openWorkspace(recentDir?)`：
不传参数时弹出 Tauri 目录选择对话框，之后调用 `store.setWorkspaceDir`；错误写入
`editorError`。工作区选择入口统一收敛到菜单栏（打开工作区… / 最近的工作区），
WorkspacePanel 只保留当前目录展示与文件列表。

### 布局结构（`App.tsx`）

```
TitleBar(MenuBar | 工作区名+脏标记 | 窗口控制)
main (flex row):
  [侧栏 left]  →  aside(Workspace / SplitHandle / History, 宽度=sidebarWidth)
                  + SplitHandle(vertical)
  workbench (flex column):
    Editor
    SplitHandle(horizontal) + footer(RunToolbar + RunConsole, 高度=consoleHeight)
  [侧栏 right] → SplitHandle(vertical) + aside(...)
```

- 面板隐藏时对应区域条件渲染不挂载；Workspace/History 同时隐藏时整个侧栏不渲染。
- RunConsole 卸载后重挂载时，既有 buffer 重放逻辑自动恢复输出；ResizeObserver
  会在容器尺寸变化时自动 fit 并同步 PTY 尺寸。
- 侧栏左/右切换时，宽度拖拽的增量符号随位置取反。

### 样式（`styles.css`）

- 新增 `.menubar` / `.menu-dropdown` / `.menu-item`（含勾选列、子菜单箭头、
  disabled 态）、`.split-handle`（4px，hover/拖拽高亮）、body 拖拽光标 class。
- `.side` 宽度、`.app-footer` 高度改为内联受控；`.history-panel` 固定 40% 高度
  改为 flex 分配；`.workspace-panel` 与 history 之间由 `sideSplit` 分配 flexGrow。
- 标题栏左侧保留应用图标（无应用名文字），`.titlebar-about` 移除（关于样式保留在
  AboutDialog 自有 class 上）。

## 测试

- `tests/layout.test.ts`：normalizeLayout 对垃圾输入/缺字段/越界值的回落与 clamp；
  clamp 函数边界；load/save 往返；store `setLayout` 合并、normalize 并持久化；
  `resetLayout` 恢复默认。
- `scripts/test.mjs` 改为多入口打包（store.test.ts + layout.test.ts）。
- 验证：`npm test`、`npm run build`、`git diff --check`。

## 风险与限制

- 拖拽分隔条基于 Pointer Events + setPointerCapture，Tauri WebView2（Chromium）
  完全支持。
- 控制台隐藏期间运行事件仍在后台缓冲，重新显示时通过 buffer 重放，无输出丢失。
- localStorage 布局损坏时自动回落默认布局，不影响启动。
