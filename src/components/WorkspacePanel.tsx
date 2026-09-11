import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useAppStore } from "../store";

const NEW_WORKSPACE = "__new_workspace__";

export function WorkspacePanel() {
  const {
    workspaceDir,
    recentWorkspaces,
    workspaceFiles,
    openFile,
    setWorkspaceDir,
    openWorkspaceFile,
  } = useAppStore();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (recentDir?: string) => {
    setBusy(true);
    setError(null);
    try {
      const dir = recentDir ?? await open({
        directory: true,
        title: "选择脚本工作区目录",
        defaultPath: workspaceDir ?? recentWorkspaces[0],
      });
      if (typeof dir === "string") await setWorkspaceDir(dir);
    } catch (e) {
      setError(`无法打开工作区：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-panel">
      <div className="panel-title">
        <span>Workspace</span>
      </div>
      <div className="workspace-recent">
        <select
          aria-label="选择工作区目录"
          value=""
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value) void choose(value === NEW_WORKSPACE ? undefined : value);
          }}
        >
          <option value="" disabled>{busy ? "打开中…" : "选择最近的目录…"}</option>
          {recentWorkspaces.map((dir) => <option key={dir} value={dir}>{dir}</option>)}
          <option value={NEW_WORKSPACE}>新目录…</option>
        </select>
      </div>
      {workspaceDir && <div className="workspace-dir">{workspaceDir}</div>}
      {error && <div className="workspace-error" role="alert">{error}</div>}
      <ul className="file-list">
        {workspaceFiles.map((f) => (
          <li
            key={f.name}
            className={f.name === openFile ? "active" : ""}
            onClick={() => !f.is_dir && openWorkspaceFile(f.name)}
          >
            {f.is_dir ? "📁 " : "📄 "}
            {f.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
