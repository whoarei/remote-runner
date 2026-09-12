const STORAGE_KEY = "remote-runner.layout.v1";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const CONSOLE_MIN = 120;
export const CONSOLE_MAX = 720;
export const SIDE_SPLIT_MIN = 0.2;
export const SIDE_SPLIT_MAX = 0.8;

export interface LayoutState {
  workspaceVisible: boolean;
  historyVisible: boolean;
  consoleVisible: boolean;
  /** 面板折叠：折叠后只显示标题条，展开状态独立于显隐 */
  workspaceCollapsed: boolean;
  historyCollapsed: boolean;
  /** 控制台折叠：折叠后只保留运行工具栏和标题条，终端保持存活仅隐藏 */
  consoleCollapsed: boolean;
  /** 编辑区折叠：折叠后只保留编辑器标题条，释放的高度由展开中的控制台占满 */
  editorCollapsed: boolean;
  /** 侧栏宽度 px */
  sidebarWidth: number;
  sidebarPosition: "left" | "right";
  /** 侧栏整体显隐：隐藏时保留各面板自身的显隐设置，恢复时原样展示 */
  sidebarVisible: boolean;
  /** Workspace 面板占侧栏高度的比例（剩余部分归 History） */
  sideSplit: number;
  /** 控制台区（工具栏 + 终端）高度 px */
  consoleHeight: number;
}

export const DEFAULT_LAYOUT: LayoutState = {
  workspaceVisible: true,
  historyVisible: true,
  consoleVisible: true,
  workspaceCollapsed: false,
  historyCollapsed: false,
  consoleCollapsed: false,
  editorCollapsed: false,
  sidebarWidth: 260,
  sidebarPosition: "left",
  sidebarVisible: true,
  sideSplit: 0.6,
  consoleHeight: 320,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function clampSidebarWidth(value: number): number {
  return clampNumber(value, SIDEBAR_MIN, SIDEBAR_MAX, DEFAULT_LAYOUT.sidebarWidth);
}

export function clampConsoleHeight(value: number): number {
  return clampNumber(value, CONSOLE_MIN, CONSOLE_MAX, DEFAULT_LAYOUT.consoleHeight);
}

export function clampSideSplit(value: number): number {
  return clampNumber(value, SIDE_SPLIT_MIN, SIDE_SPLIT_MAX, DEFAULT_LAYOUT.sideSplit);
}

/**
 * 侧栏整体显隐/换侧的切换逻辑（对应标题栏的左/右侧栏图标）：
 * - 侧栏显示在同侧 → 隐藏（保留各面板显隐设置）
 * - 侧栏显示在对侧 → 移到本侧
 * - 侧栏隐藏 → 在本侧显示
 */
export function toggleSidePanel(layout: LayoutState, side: "left" | "right"): Partial<LayoutState> {
  if (layout.sidebarVisible && layout.sidebarPosition === side) {
    return { sidebarVisible: false };
  }
  return { sidebarVisible: true, sidebarPosition: side };
}

/** 任意输入（坏 JSON、缺字段、越界值）逐字段回落默认值并约束到合法范围。 */
export function normalizeLayout(value: unknown): LayoutState {
  const source = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    workspaceVisible: clampBoolean(source.workspaceVisible, DEFAULT_LAYOUT.workspaceVisible),
    historyVisible: clampBoolean(source.historyVisible, DEFAULT_LAYOUT.historyVisible),
    consoleVisible: clampBoolean(source.consoleVisible, DEFAULT_LAYOUT.consoleVisible),
    workspaceCollapsed: clampBoolean(source.workspaceCollapsed, DEFAULT_LAYOUT.workspaceCollapsed),
    historyCollapsed: clampBoolean(source.historyCollapsed, DEFAULT_LAYOUT.historyCollapsed),
    consoleCollapsed: clampBoolean(source.consoleCollapsed, DEFAULT_LAYOUT.consoleCollapsed),
    editorCollapsed: clampBoolean(source.editorCollapsed, DEFAULT_LAYOUT.editorCollapsed),
    sidebarWidth: clampSidebarWidth(source.sidebarWidth as number),
    sidebarPosition: source.sidebarPosition === "right" ? "right" : "left",
    sidebarVisible: clampBoolean(source.sidebarVisible, DEFAULT_LAYOUT.sidebarVisible),
    sideSplit: clampSideSplit(source.sideSplit as number),
    consoleHeight: clampConsoleHeight(source.consoleHeight as number),
  };
}

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeLayout(raw === null ? undefined : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeLayout(layout)));
  } catch (error) {
    console.warn("Unable to save layout", error);
  }
}
