import { useEffect } from "react";
import { onRunEvent } from "./api";
import { useAppStore } from "./store";
import { DeviceBar } from "./components/DeviceBar";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { Editor } from "./components/Editor";
import { RunToolbar } from "./components/RunToolbar";
import { RunConsole } from "./components/RunConsole";
import { HistoryPanel } from "./components/HistoryPanel";

export default function App() {
  const { loadDevices, handleRunEvent } = useAppStore();

  useEffect(() => {
    void loadDevices();
    const unlisten = onRunEvent(handleRunEvent);
    return () => {
      unlisten.then((f) => f());
    };
  }, [loadDevices, handleRunEvent]);

  return (
    <div className="app">
      <header className="app-header">
        <DeviceBar />
      </header>
      <main className="app-main">
        <aside className="side">
          <WorkspacePanel />
          <HistoryPanel />
        </aside>
        <section className="center">
          <Editor />
        </section>
      </main>
      <footer className="app-footer">
        <RunToolbar />
        <RunConsole />
      </footer>
    </div>
  );
}
