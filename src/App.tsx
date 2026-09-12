import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { onRunEvents, api } from "./api";
import { useAppStore } from "./store";
import { DeviceDialog } from "./components/DeviceDialog";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { ConsolePanel } from "./components/ConsolePanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { UnsavedDialog } from "./components/UnsavedDialog";
import { TitleBar } from "./components/TitleBar";
import { AboutDialog } from "./components/AboutDialog";
import { SplitHandle } from "./components/SplitHandle";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { anyDirty } from "./editorDocument";
import { errorMessage } from "./api";
import { requestQuit } from "./appLifecycle";
import { clampSidebarWidth, clampConsoleHeight, clampSideSplit, DEFAULT_LAYOUT } from "./layoutState";
import { checkForAvailableUpdate } from "./updateStatus";

const Editor = lazy(() => import("./components/Editor").then((module) => ({ default: module.Editor })));

export default function App() {
  const loadDevices = useAppStore((s) => s.loadDevices);
  const loadRuns = useAppStore((s) => s.loadRuns);
  const handleRunEvents = useAppStore((s) => s.handleRunEvents);
  const [closeReady, setCloseReady] = useState(false);
  const aboutDialog = useRef<HTMLDialogElement>(null);
  const [aboutAutoCheck, setAboutAutoCheck] = useState(0);

  useEffect(() => {
    const report = (error: unknown) => useAppStore.setState({ editorError: errorMessage(error) });
    void loadDevices().catch(report);
    void loadRuns().catch(report);
    return onRunEvents(handleRunEvents, report);
  }, [loadDevices, loadRuns, handleRunEvents]);

  // 启动后静默检查一次更新；发现新版本时点亮标题栏「更新」按钮，失败不打扰用户。
  useEffect(() => {
    if (!isTauri()) return;
    void checkForAvailableUpdate(api.checkAppUpdate, (info) => useAppStore.setState({ availableUpdate: info }));
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (anyDirty(useAppStore.getState())) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    let disposed = false;
    // 关闭窗口 = 最小化到托盘：隐藏不丢任何状态，无需未保存守卫。
    // 真正的退出由托盘「退出」/ 菜单「文件 → 退出」经 requestQuit() 走守卫流程。
    const unlisten = isTauri() ? getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void getCurrentWindow().hide().catch((error) => {
        useAppStore.setState({ editorError: `窗口操作失败：${errorMessage(error)}` });
      });
    }) : Promise.resolve(() => {});
    const unlistenQuit = isTauri()
      ? listen("tray://quit-requested", () => void requestQuit())
      : Promise.resolve(() => {});
    void Promise.all([unlisten, unlistenQuit])
      .then(() => { if (!disposed) setCloseReady(true); })
      .catch((error) => useAppStore.setState({ editorError: `关闭保护注册失败：${errorMessage(error)}` }));
    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", beforeUnload);
      void unlisten.then((fn) => fn()).catch(() => {});
      void unlistenQuit.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const sideRef = useRef<HTMLElement>(null);
  const sidebarVisible = layout.workspaceVisible || layout.historyVisible;
  const bothSidePanels = layout.workspaceVisible && layout.historyVisible;
  const bothExpanded = bothSidePanels && !layout.workspaceCollapsed && !layout.historyCollapsed;

  const sidebar = sidebarVisible && (
    <>
      {layout.sidebarPosition === "right" && (
        <SplitHandle
          direction="vertical"
          label="调整侧栏宽度"
          onDelta={(delta) => setLayout({ sidebarWidth: clampSidebarWidth(layout.sidebarWidth - delta) })}
          onReset={() => setLayout({ sidebarWidth: DEFAULT_LAYOUT.sidebarWidth })}
        />
      )}
      <aside className="side" style={{ width: layout.sidebarWidth }} ref={sideRef}>
        {layout.workspaceVisible && (
          <div className="side-section" style={
            layout.workspaceCollapsed ? { flex: "0 0 auto" }
              : bothExpanded ? { flexGrow: layout.sideSplit, flexBasis: 0 }
              : undefined
          }>
            <WorkspacePanel
              collapsed={layout.workspaceCollapsed}
              onToggleCollapse={() => setLayout({ workspaceCollapsed: !layout.workspaceCollapsed })}
            />
          </div>
        )}
        {bothExpanded && (
          <SplitHandle
            direction="horizontal"
            label="调整工作区与历史面板比例"
            onDelta={(delta) => {
              const height = sideRef.current?.clientHeight ?? 0;
              if (height > 0) setLayout({ sideSplit: clampSideSplit(layout.sideSplit + delta / height) });
            }}
            onReset={() => setLayout({ sideSplit: DEFAULT_LAYOUT.sideSplit })}
          />
        )}
        {layout.historyVisible && (
          <div className="side-section" style={
            layout.historyCollapsed ? { flex: "0 0 auto" }
              : bothExpanded ? { flexGrow: 1 - layout.sideSplit, flexBasis: 0 }
              : undefined
          }>
            <HistoryPanel
              collapsed={layout.historyCollapsed}
              onToggleCollapse={() => setLayout({ historyCollapsed: !layout.historyCollapsed })}
            />
          </div>
        )}
      </aside>
      {layout.sidebarPosition === "left" && (
        <SplitHandle
          direction="vertical"
          label="调整侧栏宽度"
          onDelta={(delta) => setLayout({ sidebarWidth: clampSidebarWidth(layout.sidebarWidth + delta) })}
          onReset={() => setLayout({ sidebarWidth: DEFAULT_LAYOUT.sidebarWidth })}
        />
      )}
    </>
  );

  return (
    <div className="app">
      <UnsavedDialog />
      <AboutDialog dialogRef={aboutDialog} autoCheckNonce={aboutAutoCheck} />
      <DeviceDialog />
      <TitleBar
        closeReady={closeReady}
        onAbout={() => aboutDialog.current?.showModal()}
        onCheckUpdate={() => {
          setAboutAutoCheck((nonce) => nonce + 1);
          aboutDialog.current?.showModal();
        }}
      />
      <main className="app-main">
        {layout.sidebarPosition === "left" && sidebar}
        <div className="workbench">
          <section className="center" style={layout.editorCollapsed ? { flex: "0 0 auto" } : undefined}>
            <Suspense fallback={<div className="editor empty">正在加载编辑器…</div>}>
              <Editor
                collapsed={layout.editorCollapsed}
                onToggleCollapse={() => setLayout({ editorCollapsed: !layout.editorCollapsed })}
              />
            </Suspense>
          </section>
          {(
            <>
              {layout.consoleVisible && !layout.consoleCollapsed && !layout.editorCollapsed && (
                <SplitHandle
                  direction="horizontal"
                  label="调整控制台高度"
                  onDelta={(delta) => setLayout({ consoleHeight: clampConsoleHeight(layout.consoleHeight - delta) })}
                  onReset={() => setLayout({ consoleHeight: DEFAULT_LAYOUT.consoleHeight })}
                />
              )}
              <footer className="app-footer" hidden={!layout.consoleVisible} style={
                layout.consoleCollapsed ? undefined
                  : layout.editorCollapsed ? { flex: 1 } // 编辑区折叠时控制台占满释放的高度
                  : { height: layout.consoleHeight }
              }>
                <ConsolePanel
                  visible={layout.consoleVisible}
                  collapsed={layout.consoleCollapsed}
                  onToggleCollapse={() => setLayout({ consoleCollapsed: !layout.consoleCollapsed })}
                />
              </footer>
            </>
          )}
        </div>
        {layout.sidebarPosition === "right" && sidebar}
      </main>
    </div>
  );
}
