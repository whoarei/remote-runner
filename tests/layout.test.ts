import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LAYOUT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  CONSOLE_MIN,
  CONSOLE_MAX,
  SIDE_SPLIT_MIN,
  SIDE_SPLIT_MAX,
  clampSidebarWidth,
  clampConsoleHeight,
  clampSideSplit,
  normalizeLayout,
  loadLayout,
  saveLayout,
} from "../src/layoutState";
import { useAppStore } from "../src/store";

function mockLocalStorage(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return data;
}

test("normalizeLayout falls back to defaults for garbage input", () => {
  assert.deepEqual(normalizeLayout(undefined), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout("broken"), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout(42), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout([]), DEFAULT_LAYOUT);
});

test("normalizeLayout keeps valid fields and fills missing ones", () => {
  const layout = normalizeLayout({ sidebarWidth: 300, consoleVisible: false, sidebarPosition: "right", workspaceCollapsed: true, consoleCollapsed: true });
  assert.equal(layout.sidebarWidth, 300);
  assert.equal(layout.consoleVisible, false);
  assert.equal(layout.sidebarPosition, "right");
  assert.equal(layout.workspaceCollapsed, true);
  assert.equal(layout.consoleCollapsed, true);
  assert.equal(layout.historyCollapsed, DEFAULT_LAYOUT.historyCollapsed);
  assert.equal(layout.workspaceVisible, DEFAULT_LAYOUT.workspaceVisible);
  assert.equal(layout.sideSplit, DEFAULT_LAYOUT.sideSplit);
});

test("normalizeLayout clamps out-of-range values and rejects wrong types", () => {
  const layout = normalizeLayout({
    sidebarWidth: 99999,
    consoleHeight: -5,
    sideSplit: 0,
    sidebarPosition: "up",
    workspaceVisible: "yes",
  });
  assert.equal(layout.sidebarWidth, SIDEBAR_MAX);
  assert.equal(layout.consoleHeight, CONSOLE_MIN);
  assert.equal(layout.sideSplit, SIDE_SPLIT_MIN);
  assert.equal(layout.sidebarPosition, "left");
  assert.equal(layout.workspaceVisible, DEFAULT_LAYOUT.workspaceVisible);
});

test("clamp helpers bound values and fall back on non-finite input", () => {
  assert.equal(clampSidebarWidth(SIDEBAR_MIN - 1), SIDEBAR_MIN);
  assert.equal(clampSidebarWidth(SIDEBAR_MAX + 1), SIDEBAR_MAX);
  assert.equal(clampSidebarWidth(NaN), DEFAULT_LAYOUT.sidebarWidth);
  assert.equal(clampConsoleHeight(CONSOLE_MIN - 1), CONSOLE_MIN);
  assert.equal(clampConsoleHeight(CONSOLE_MAX + 1), CONSOLE_MAX);
  assert.equal(clampConsoleHeight(Infinity), DEFAULT_LAYOUT.consoleHeight);
  assert.equal(clampSideSplit(SIDE_SPLIT_MIN - 0.1), SIDE_SPLIT_MIN);
  assert.equal(clampSideSplit(SIDE_SPLIT_MAX + 0.1), SIDE_SPLIT_MAX);
  assert.equal(clampSideSplit(NaN), DEFAULT_LAYOUT.sideSplit);
});

test("loadLayout/saveLayout round-trip and survive corrupted storage", (t) => {
  const data = mockLocalStorage(t);
  // 无存储 → 默认布局
  assert.deepEqual(loadLayout(), DEFAULT_LAYOUT);

  const custom = { ...DEFAULT_LAYOUT, sidebarWidth: 333, consoleVisible: false, sidebarPosition: "right" as const };
  saveLayout(custom);
  assert.deepEqual(loadLayout(), custom);

  // 损坏的 JSON → 默认布局
  data.set("remote-runner.layout.v1", "{not json");
  assert.deepEqual(loadLayout(), DEFAULT_LAYOUT);

  // 合法 JSON 但字段越界 → normalize 后回落
  data.set("remote-runner.layout.v1", JSON.stringify({ sidebarWidth: -100 }));
  assert.equal(loadLayout().sidebarWidth, SIDEBAR_MIN);
});

test("store setLayout merges patches, normalizes, and persists", (t) => {
  mockLocalStorage(t);
  const original = useAppStore.getState().layout;
  t.after(() => useAppStore.setState({ layout: original }));

  const { setLayout, resetLayout } = useAppStore.getState();
  setLayout({ sidebarWidth: 280, historyVisible: false });
  let layout = useAppStore.getState().layout;
  assert.equal(layout.sidebarWidth, 280);
  assert.equal(layout.historyVisible, false);
  assert.equal(layout.workspaceVisible, DEFAULT_LAYOUT.workspaceVisible);
  assert.deepEqual(loadLayout(), layout);

  // 越界 patch 会被 clamp
  setLayout({ sidebarWidth: 1 });
  layout = useAppStore.getState().layout;
  assert.equal(layout.sidebarWidth, SIDEBAR_MIN);

  resetLayout();
  assert.deepEqual(useAppStore.getState().layout, DEFAULT_LAYOUT);
  assert.deepEqual(loadLayout(), DEFAULT_LAYOUT);
});
