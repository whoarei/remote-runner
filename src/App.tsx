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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { dirtyDocument } from "./editorDocument";
import { errorMessage } from "./api";

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

  return (
    <div className="app">
      <UnsavedDialog />
      <AboutDialog dialogRef={aboutDialog} />
      <TitleBar closeReady={closeReady} onAbout={() => aboutDialog.current?.showModal()} />
      <header className="app-header">
        <DeviceBar />
      </header>
      <main className="app-main">
        <aside className="side">
          <WorkspacePanel />
          <HistoryPanel />
        </aside>
        <section className="center">
          <Suspense fallback={<div className="editor empty">正在加载编辑器…</div>}><Editor /></Suspense>
        </section>
      </main>
      <footer className="app-footer">
        <RunToolbar />
        <RunConsole />
      </footer>
    </div>
  );
}
