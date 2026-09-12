import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorMessage } from "../api";
import { dirtyDocument } from "../editorDocument";
import { useAppStore } from "../store";

function reportWindowError(error: unknown) {
  useAppStore.setState({ editorError: `窗口操作失败：${errorMessage(error)}` });
}

export function TitleBar({ closeReady, onAbout }: { closeReady: boolean; onAbout: () => void }) {
  const workspaceDir = useAppStore((state) => state.workspaceDir);
  const dirty = useAppStore(dirtyDocument);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const desktop = isTauri();
  const workspaceName = workspaceDir?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workspaceDir;

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    const refreshMaximized = async () => {
      const value = await appWindow.isMaximized();
      if (!disposed) setMaximized(value);
    };
    const listeners = [
      appWindow.onResized(() => { void refreshMaximized().catch(reportWindowError); }),
      appWindow.onFocusChanged(({ payload }) => { if (!disposed) setFocused(payload); }),
    ];
    void refreshMaximized().catch(reportWindowError);
    void appWindow.isFocused().then((value) => { if (!disposed) setFocused(value); }).catch(reportWindowError);
    for (const listener of listeners) void listener.catch(reportWindowError);
    return () => {
      disposed = true;
      for (const listener of listeners) void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [desktop]);

  const windowAction = (action: "minimize" | "toggleMaximize" | "close") => {
    if (!desktop) return;
    // close() emits the close request handled by App's unsaved-document guard.
    void getCurrentWindow()[action]().catch(reportWindowError);
  };

  return (
    <div className={`titlebar${focused ? "" : " titlebar-inactive"}`}>
      <div className="titlebar-drag" data-tauri-drag-region>
        <div className="titlebar-brand">
          <svg className="titlebar-logo" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="1.5" y="2.5" width="17" height="15" rx="3" stroke="currentColor" />
            <path d="m5 7 3 3-3 3m6 0h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Remote Runner</span>
        </div>
        <div className="titlebar-workspace" data-tauri-drag-region title={workspaceDir ?? "尚未打开工作区"}>
          <span className="titlebar-workspace-name">{workspaceName ?? "未打开工作区"}</span>
          {dirty && <span className="titlebar-dirty" role="img" aria-label="有未保存的更改" />}
        </div>
      </div>
      <button type="button" className="titlebar-button titlebar-about" title="关于 Remote Runner" aria-haspopup="dialog" onClick={onAbout}>关于</button>
      <div className="titlebar-controls" role="group" aria-label="窗口控制">
        <button type="button" className="titlebar-button" aria-label="最小化" title="最小化" disabled={!desktop} onClick={() => windowAction("minimize")}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1 6.5h10" stroke="currentColor" /></svg>
        </button>
        <button type="button" className="titlebar-button" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} disabled={!desktop} onClick={() => windowAction("toggleMaximize")}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            {maximized ? <path d="M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z" stroke="currentColor" /> : <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" />}
          </svg>
        </button>
        <button type="button" className="titlebar-button titlebar-close" aria-label="关闭" title="关闭" disabled={!desktop || !closeReady} onClick={() => windowAction("close")}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" stroke="currentColor" /></svg>
        </button>
      </div>
    </div>
  );
}
