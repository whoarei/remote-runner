import { useAppStore } from "../store";
import { PanelTitle } from "./PanelTitle";
import { useShallow } from "zustand/react/shallow";

export function WorkspacePanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const {
    workspaceDir,
    workspaceFiles,
    openFile,
    openWorkspaceFile,
    saving,
    starting,
    guarding,
  } = useAppStore(useShallow((s) => ({ workspaceDir: s.workspaceDir, workspaceFiles: s.workspaceFiles,
    openFile: s.openFile, openWorkspaceFile: s.openWorkspaceFile, saving: s.saving, starting: s.starting, guarding: s.guarding })));

  return (
    <div className="workspace-panel">
      <PanelTitle title="Workspace" collapsed={collapsed} onToggle={onToggleCollapse} />
      {!collapsed && (
        <>
          {workspaceDir && <div className="workspace-dir">{workspaceDir}</div>}
          <ul className="file-list">
            {workspaceFiles.map((f) => (
              <li
                key={f.name}
                className={f.name === openFile ? "active" : ""}
              >
                {f.is_dir ? <>📁 {f.name}</> : <button disabled={saving || starting || guarding}
                  onClick={() => void openWorkspaceFile(f.name)}>📄 {f.name}</button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
