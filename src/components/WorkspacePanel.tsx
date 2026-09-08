import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";

export function WorkspacePanel() {
  const {
    workspaceDir,
    workspaceFiles,
    openFile,
    setWorkspaceDir,
    openWorkspaceFile,
  } = useAppStore();

  const pick = async () => {
    const dir = await open({ directory: true, title: "选择脚本工作区目录" });
    if (typeof dir === "string") await setWorkspaceDir(dir);
  };

  return (
    <div className="workspace-panel">
      <div className="panel-title">
        <span>Workspace</span>
        <button onClick={pick}>{workspaceDir ? "更换" : "选择目录"}</button>
      </div>
      {workspaceDir && <div className="workspace-dir">{workspaceDir}</div>}
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
