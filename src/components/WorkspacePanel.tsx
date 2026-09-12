import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorkspaceEntry } from "../api";
import { useAppStore } from "../store";
import { joinPath, WORKSPACE_ROOT, WorkspacePath, WorkspaceTree } from "../workspaceTree";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { PanelTitle } from "./PanelTitle";

type MenuEntry = { label: string; danger?: boolean; onSelect: () => void } | "separator";

interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

type Editing =
  | { mode: "create-file"; dir: WorkspacePath }
  | { mode: "create-dir"; dir: WorkspacePath }
  | { mode: "rename"; dir: WorkspacePath; entry: WorkspaceEntry };

interface PendingDelete {
  path: WorkspacePath;
  isDir: boolean;
}

interface TreeProps {
  dir: WorkspacePath;
  depth: number;
  tree: WorkspaceTree;
  openFile: string | null;
  /** 打开文件与增删改期间禁用条目点击；目录展开始终可用 */
  disabled: boolean;
  editing: Editing | null;
  onOpen: (path: WorkspacePath) => void;
  onToggle: (path: WorkspacePath) => void;
  onMenu: (event: MouseEvent, dir: WorkspacePath, entry: WorkspaceEntry | null) => void;
  onEditing: (editing: Editing | null) => void;
}

function InlineInput({ initial, label, onSubmit, onCancel }: {
  initial: string; label: string; onSubmit: (name: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    // 重命名时只选中主文件名，扩展名保持可见
    const dot = initial.lastIndexOf(".");
    if (dot > 0) element.setSelectionRange(0, dot);
    else element.select();
  }, [initial]);
  const submit = () => {
    const name = value.trim();
    if (name && name !== initial) onSubmit(name);
    else onCancel();
  };
  return <input
    className="tree-input"
    ref={input}
    aria-label={label}
    value={value}
    onChange={(event) => setValue(event.target.value)}
    onBlur={onCancel}
    // 输入框内保留原生文本编辑菜单（复制/粘贴），不弹面板菜单
    onContextMenu={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      // 中文输入法组词期间的 Enter/Esc 是确认/取消候选词，不是提交或取消输入
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); submit(); }
      else if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    }}
  />;
}

function TreeLevel(props: TreeProps) {
  const { dir, depth, tree, openFile, disabled, editing, onOpen, onToggle, onMenu, onEditing } = props;
  const node = tree[dir];
  if (!node) return null;
  const creating = editing && editing.mode !== "rename" && editing.dir === dir ? editing : null;
  return (
    <ul className="file-list" style={depth ? { paddingLeft: depth * 12 } : undefined}>
      {creating && <li>
        <InlineInput
          initial=""
          label={creating.mode === "create-file" ? "新建文件名" : "新建文件夹名"}
          onSubmit={(name) => {
            onEditing(null);
            void useAppStore.getState().createWorkspaceEntry(dir, name, creating.mode === "create-file" ? "file" : "dir");
          }}
          onCancel={() => onEditing(null)}
        />
      </li>}
      {node.entries.map((entry) => {
        const path = joinPath(dir, entry.name);
        const child = entry.is_dir ? tree[path] : undefined;
        const renaming = editing?.mode === "rename" && editing.dir === dir && editing.entry.name === entry.name;
        return (
          <li key={entry.name} className={path === openFile ? "active" : ""}>
            {renaming ? (
              <InlineInput
                initial={entry.name}
                label={`重命名 ${entry.name}`}
                onSubmit={(name) => {
                  onEditing(null);
                  void useAppStore.getState().renameWorkspaceEntry(path, name);
                }}
                onCancel={() => onEditing(null)}
              />
            ) : (
              <button
                type="button"
                className="tree-row"
                disabled={disabled && !entry.is_dir}
                aria-expanded={entry.is_dir ? !!child?.expanded : undefined}
                onClick={() => (entry.is_dir ? onToggle(path) : onOpen(path))}
                onContextMenu={(event) => onMenu(event, dir, entry)}
              >
                <span className="tree-chevron" aria-hidden="true">
                  {entry.is_dir ? (child?.expanded ? "▾" : "▸") : ""}
                </span>
                <span className="tree-icon" aria-hidden="true">{entry.is_dir ? "📁" : "📄"}</span>
                <span className="tree-name">{entry.name}</span>
              </button>
            )}
            {entry.is_dir && child?.expanded && <TreeLevel {...props} dir={path} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

function ContextMenu({ menu, disabled, onClose }: { menu: MenuState | null; disabled: boolean; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  return (
    <div className="menu-dropdown context-menu" role="menu" ref={container} style={{ left: menu.x, top: menu.y }}>
      {menu.entries.map((entry, index) => entry === "separator"
        ? <div key={index} className="menu-separator" role="separator" />
        : <button
          key={index}
          type="button"
          role="menuitem"
          className={`menu-item${entry.danger ? " menu-item-danger" : ""}`}
          disabled={disabled}
          onClick={() => { onClose(); entry.onSelect(); }}
        >
          <span className="menu-check" aria-hidden="true" />
          <span className="menu-label">{entry.label}</span>
        </button>)}
    </div>
  );
}

export function WorkspacePanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const {
    workspaceDir,
    workspaceTree,
    workspaceError,
    openFile,
    disabled,
  } = useAppStore(useShallow((s) => ({
    workspaceDir: s.workspaceDir, workspaceTree: s.workspaceTree, workspaceError: s.workspaceError,
    openFile: s.openFile,
    disabled: s.saving || s.starting || s.guarding || s.workspaceMutating,
  })));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // 折叠面板或切换工作区时收起菜单与行内输入，避免操作落到错误的目录
  useEffect(() => { setMenu(null); setEditing(null); }, [collapsed, workspaceDir]);

  const startCreate = async (dir: WorkspacePath, mode: "create-file" | "create-dir") => {
    const node = useAppStore.getState().workspaceTree[dir];
    // 折叠目录（包括从未展开、还没有缓存节点的目录）中新建时先展开，
    // 否则行内输入框会落在不可见的子树里
    if (dir !== WORKSPACE_ROOT && !node?.expanded) await useAppStore.getState().toggleWorkspaceDir(dir);
    setEditing({ mode, dir });
  };

  const openMenu = (event: MouseEvent, dir: WorkspacePath, entry: WorkspaceEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (!workspaceDir) return;
    const path = entry ? joinPath(dir, entry.name) : dir;
    const entries: MenuEntry[] = [];
    if (!entry) entries.push({ label: "刷新", onSelect: () => void useAppStore.getState().loadWorkspaceDir(dir) });
    // 新建入口只出现在目录与空白区；文件条目上只有打开/重命名/删除
    if (!entry || entry.is_dir) {
      entries.push({ label: "新建文件", onSelect: () => void startCreate(path, "create-file") });
      entries.push({ label: "新建文件夹", onSelect: () => void startCreate(path, "create-dir") });
    }
    if (entry) {
      entries.push("separator");
      if (!entry.is_dir) entries.push({ label: "打开", onSelect: () => void useAppStore.getState().openWorkspaceFile(path) });
      entries.push({ label: "重命名", onSelect: () => setEditing({ mode: "rename", dir, entry }) });
      entries.push({ label: "删除", danger: true, onSelect: () => setPendingDelete({ path, isDir: entry.is_dir }) });
    }
    setMenu({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - entries.length * 30 - 16)),
      entries,
    });
  };

  const confirmRequest: ConfirmRequest | null = useMemo(() => pendingDelete ? {
    title: pendingDelete.isDir ? "删除文件夹？" : "删除文件？",
    message: pendingDelete.isDir
      ? `将递归删除 ${pendingDelete.path} 及其全部内容，且不可恢复。`
      : `将永久删除 ${pendingDelete.path}，且不可恢复。`,
    confirmLabel: "删除",
    danger: true,
    onCancel: () => setPendingDelete(null),
    onConfirm: () => {
      const path = pendingDelete.path;
      setPendingDelete(null);
      void useAppStore.getState().deleteWorkspaceEntry(path);
    },
  } : null, [pendingDelete]);

  return (
    <div
      className="workspace-panel"
      onContextMenu={collapsed ? undefined : (event) => openMenu(event, WORKSPACE_ROOT, null)}
    >
      <PanelTitle title="Workspace" collapsed={collapsed} onToggle={onToggleCollapse} />
      {!collapsed && (
        <>
          {workspaceDir && <div className="workspace-dir">{workspaceDir}</div>}
          {workspaceError && <div className="workspace-error" role="alert">
            <span>{workspaceError}</span>
            <button onClick={() => useAppStore.getState().dismissWorkspaceError()}>关闭</button>
          </div>}
          {workspaceDir ? (
            <div className="file-tree">
              <TreeLevel
                dir={WORKSPACE_ROOT}
                depth={0}
                tree={workspaceTree}
                openFile={openFile}
                disabled={disabled}
                editing={editing}
                onOpen={(path) => void useAppStore.getState().openWorkspaceFile(path)}
                onToggle={(path) => void useAppStore.getState().toggleWorkspaceDir(path)}
                onMenu={openMenu}
                onEditing={setEditing}
              />
            </div>
          ) : <p className="workspace-empty">尚未选择工作区目录</p>}
        </>
      )}
      <ContextMenu menu={menu} disabled={disabled} onClose={() => setMenu(null)} />
      <ConfirmDialog request={confirmRequest} />
    </div>
  );
}
