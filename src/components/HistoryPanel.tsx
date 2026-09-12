import { useShallow } from "zustand/react/shallow";
import { api, errorMessage } from "../api";
import { isActiveRun } from "../runState";
import { useAppStore } from "../store";
import { PanelTitle } from "./PanelTitle";

export function HistoryPanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { history, loadHistory, setActiveRun, runs, activeRunId } = useAppStore(useShallow((s) => ({
    history: s.history, loadHistory: s.loadHistory, setActiveRun: s.setActiveRun, runs: s.runs, activeRunId: s.activeRunId,
  })));
  const running = Object.values(runs).filter(isActiveRun);
  const report = (e: unknown) => useAppStore.setState({ editorError: errorMessage(e) });

  return (
    <div className="history-panel">
      <PanelTitle title="Run History" collapsed={collapsed} onToggle={onToggleCollapse}>
        <button onClick={() => void loadHistory().catch(report)}>刷新</button>
      </PanelTitle>
      {running.length > 0 && <ul className="history-list" aria-label="运行中的任务">
        {running.map((run) => <li key={run.run_id}>
          <button aria-pressed={activeRunId === run.run_id} onClick={() => setActiveRun(run.run_id)}>
            {run.label} · {run.device_name} · {run.state}
          </button>
          <button className="danger" aria-label={`停止 ${run.label}`} disabled={run.state === "stopping"}
            onClick={() => void api.stopRun(run.run_id).catch(report)}>Stop</button>
        </li>)}
      </ul>}
      {!collapsed && (
        <ul className="history-list">
          {history.map((h) => {
            // 只有本次会话内的 run 有输出缓冲可回看
            const viewable =
              runs[h.run_id] != null;
            return (
              <li key={h.run_id} onClick={() => viewable && setActiveRun(h.run_id)}>
                <span className={`run-state state-${h.state}`}>{h.state}</span>
                <span className="history-label">{h.label}</span>
                <span className="history-meta">
                  {h.device_name} · exit={h.exit_code ?? "-"} ·{" "}
                  {new Date(h.started_at).toLocaleTimeString()}
                </span>
              </li>
            );
          })}
          {history.length === 0 && <li className="empty">暂无记录</li>}
        </ul>
      )}
    </div>
  );
}
