import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { onRunEvent } from "./api";
import { useAppStore } from "./store";
import { DeviceBar } from "./components/DeviceBar";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { RunToolbar } from "./components/RunToolbar";
import { RunConsole } from "./components/RunConsole";
import { HistoryPanel } from "./components/HistoryPanel";
import { UnsavedDialog } from "./components/UnsavedDialog";
import { TitleBar } from "./components/TitleBar";
import { AboutDialog } from "./components/AboutDialog";
import { SplitHandle } from "./components/SplitHandle";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { dirtyDocument } from "./editorDocument";
import { errorMessage } from "./api";
import { clampSidebarWidth, clampConsoleHeight, clampSideSplit, DEFAULT_LAYOUT } from "./layoutState";

const Editor = lazy(() => import("./components/Editor").then((module) => ({ default: module.Editor })));

export default function App() {
  const { loadDevices, handleRunEvent } = useAppStore();
  const [closeReady, setCloseReady] = useState(false);
  const aboutDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    void loadDevices();
    const unlisten = onRunEvent(handleRunEvent);
    return () => {
      unlisten.then((f) => f());
    };
  }, [loadDevices, handleRunEvent]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyDocument(useAppStore.getState())) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    let closing = false;
    let disposed = false;
    const unlisten = isTauri() ? getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      const state = useAppStore.getState();
      if (state.loading || state.saving || state.starting || state.guarding) return;
      closing = true;
      try {
        if (await state.confirmUnsaved()) await getCurrentWindow().destroy();
      } catch (error) { useAppStore.setState({ editorError: errorMessage(error) }); }
      finally { closing = false; }
    }) : Promise.resolve(() => {});
    void unlisten.then(() => { if (!disposed) setCloseReady(true); }).catch(() => {});
    void unlisten.catch((error) => useAppStore.setState({ editorError: `关闭保护注册失败：${errorMessage(error)}` }));
    return () => { disposed = true; window.removeEventListener("beforeunload", beforeUnload); void unlisten.then((fn) => fn()).catch(() => {}); };
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
      <AboutDialog dialogRef={aboutDialog} />
      <TitleBar closeReady={closeReady} onAbout={() => aboutDialog.current?.showModal()} />
      <header className="app-header">
        <DeviceBar />
      </header>
      <main className="app-main">
        {layout.sidebarPosition === "left" && sidebar}
        <div className="workbench">
          <section className="center">
            <Suspense fallback={<div className="editor empty">正在加载编辑器…</div>}><Editor /></Suspense>
          </section>
          {layout.consoleVisible && (
            <>
              {!layout.consoleCollapsed && (
                <SplitHandle
                  direction="horizontal"
                  label="调整控制台高度"
                  onDelta={(delta) => setLayout({ consoleHeight: clampConsoleHeight(layout.consoleHeight - delta) })}
                  onReset={() => setLayout({ consoleHeight: DEFAULT_LAYOUT.consoleHeight })}
                />
              )}
              <footer className="app-footer" style={layout.consoleCollapsed ? undefined : { height: layout.consoleHeight }}>
                <RunToolbar />
                <RunConsole
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
