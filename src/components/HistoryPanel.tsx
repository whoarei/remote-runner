import { useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage, RunStatus } from "../api";
import { canExportOutput, exportOutput, exportRecord } from "../historyExport";
import { isActiveRun } from "../runState";
import { useAppStore } from "../store";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { ContextMenu, contextMenuPosition, MenuState } from "./ContextMenu";
import { PanelTitle } from "./PanelTitle";

export function HistoryPanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { history, setActiveRun, runs, activeRunId } = useAppStore(useShallow((s) => ({
    history: s.history, setActiveRun: s.setActiveRun, runs: s.runs, activeRunId: s.activeRunId,
  })));
  const running = Object.values(runs).filter(isActiveRun);
  const report = (e: unknown) => useAppStore.setState({ editorError: errorMessage(e) });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const openEntryMenu = (event: MouseEvent, entry: RunStatus) => {
    event.preventDefault();
    event.stopPropagation();
    const entries = [
      {
        label: "导出记录 (JSON)",
        onSelect: () => void exportRecord(entry).catch(report),
      },
      {
        label: "导出输出日志 (.log)",
        // 只有本会话起持久化了输出的 run 有日志可导出
        disabled: !canExportOutput(entry),
        onSelect: () => void exportOutput(entry)
          .then((warning) => { if (warning) report(new Error(warning)); })
          .catch(report),
      },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  // 面板空白区右键：清空全部历史
  const openPanelMenu = (event: MouseEvent) => {
    event.preventDefault();
    const entries = [
      {
        label: "清空历史记录",
        danger: true,
        disabled: history.length === 0,
        onSelect: () => setConfirmClear(true),
      },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  const confirmRequest: ConfirmRequest | null = useMemo(() => confirmClear ? {
    title: "清空历史记录？",
    message: `将删除全部 ${history.length} 条历史记录及其输出日志，且不可恢复。运行中的任务不受影响。`,
    confirmLabel: "清空",
    danger: true,
    onCancel: () => setConfirmClear(false),
    onConfirm: () => {
      setConfirmClear(false);
      void useAppStore.getState().clearHistory().catch(report);
    },
  } : null, [confirmClear, history.length]);

  return (
    <div className="history-panel" onContextMenu={openPanelMenu}>
      <PanelTitle title="Run History" collapsed={collapsed} onToggle={onToggleCollapse} />
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
              <li key={h.run_id} onClick={() => viewable && setActiveRun(h.run_id)}
                onContextMenu={(event) => openEntryMenu(event, h)}>
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
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <ConfirmDialog request={confirmRequest} />
    </div>
  );
}
