import { useEffect } from "react";
import { useAppStore } from "../store";
import { PanelTitle } from "./PanelTitle";

export function HistoryPanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { history, loadHistory, setActiveRun, runs, outputBuffers } = useAppStore();

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  return (
    <div className="history-panel">
      <PanelTitle title="Run History" collapsed={collapsed} onToggle={onToggleCollapse}>
        <button onClick={() => loadHistory()}>刷新</button>
      </PanelTitle>
      {!collapsed && (
        <ul className="history-list">
          {history.map((h) => {
            // 只有本次会话内的 run 有输出缓冲可回看
            const viewable =
              runs[h.run_id] != null || outputBuffers[h.run_id] != null;
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
