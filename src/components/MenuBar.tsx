import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorMessage } from "../api";
import { dirtyDocument } from "../editorDocument";
import { useAppStore } from "../store";
import { openWorkspace } from "../workspacePicker";

interface MenuEntry {
  type?: "item" | "checkbox" | "separator";
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: MenuEntry[];
}

interface TopMenu {
  label: string;
  entries: MenuEntry[];
}

function MenuItem({ entry, close }: { entry: MenuEntry; close: () => void }) {
  const [subOpen, setSubOpen] = useState(false);

  if (entry.type === "separator") return <div className="menu-separator" role="separator" />;

  if (entry.children) {
    return (
      <div
        className="menu-submenu"
        onMouseEnter={() => setSubOpen(true)}
        onMouseLeave={() => setSubOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={subOpen}
          className="menu-item"
          disabled={entry.disabled}
        >
          <span className="menu-check" />
          <span className="menu-label">{entry.label}</span>
          <span className="menu-arrow" aria-hidden="true">▸</span>
        </button>
        {subOpen && (
          <div className="menu-dropdown menu-subdropdown" role="menu">
            {entry.children.map((child, index) => <MenuItem key={index} entry={child} close={close} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      role={entry.type === "checkbox" ? "menuitemcheckbox" : "menuitem"}
      aria-checked={entry.type === "checkbox" ? entry.checked : undefined}
      className="menu-item"
      disabled={entry.disabled}
      onClick={() => {
        close();
        entry.onSelect?.();
      }}
    >
      <span className="menu-check" aria-hidden="true">{entry.checked ? "✓" : ""}</span>
      <span className="menu-label">{entry.label}</span>
    </button>
  );
}

export function MenuBar({ onAbout }: { onAbout: () => void }) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const resetLayout = useAppStore((state) => state.resetLayout);
  const recentWorkspaces = useAppStore((state) => state.recentWorkspaces);
  const dirty = useAppStore(dirtyDocument);

  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const menus: TopMenu[] = [
    {
      label: "文件",
      entries: [
        { label: "打开工作区…", onSelect: () => void openWorkspace() },
        {
          label: "最近的工作区",
          disabled: recentWorkspaces.length === 0,
          children: recentWorkspaces.length > 0
            ? recentWorkspaces.map((dir) => ({ label: dir, onSelect: () => void openWorkspace(dir) }))
            : [{ label: "（无最近记录）", disabled: true }],
        },
        { type: "separator" },
        { label: "保存文件", disabled: !dirty, onSelect: () => void useAppStore.getState().saveFile() },
        { type: "separator" },
        {
          label: "退出",
          disabled: !isTauri(),
          onSelect: () => void getCurrentWindow().close().catch((error) => {
            useAppStore.setState({ editorError: `窗口操作失败：${errorMessage(error)}` });
          }),
        },
      ],
    },
    {
      label: "视图",
      entries: [
        { type: "checkbox", label: "工作区面板", checked: layout.workspaceVisible, onSelect: () => setLayout({ workspaceVisible: !layout.workspaceVisible }) },
        { type: "checkbox", label: "历史面板", checked: layout.historyVisible, onSelect: () => setLayout({ historyVisible: !layout.historyVisible }) },
        { type: "checkbox", label: "控制台面板", checked: layout.consoleVisible, onSelect: () => setLayout({ consoleVisible: !layout.consoleVisible }) },
        { type: "separator" },
        {
          label: "侧栏位置",
          children: [
            { type: "checkbox", label: "左侧", checked: layout.sidebarPosition === "left", onSelect: () => setLayout({ sidebarPosition: "left" }) },
            { type: "checkbox", label: "右侧", checked: layout.sidebarPosition === "right", onSelect: () => setLayout({ sidebarPosition: "right" }) },
          ],
        },
        { type: "separator" },
        { label: "重置布局", onSelect: () => resetLayout() },
      ],
    },
    {
      label: "帮助",
      entries: [
        { label: "关于 Remote Runner…", onSelect: onAbout },
      ],
    },
  ];

  return (
    <div className="menubar" role="menubar" aria-label="应用菜单" ref={barRef}>
      {menus.map((menu, index) => (
        <div className="menubar-entry" key={menu.label}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenu === index}
            className={`menubar-title${openMenu === index ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === index ? null : index)}
            onMouseEnter={() => { if (openMenu !== null) setOpenMenu(index); }}
          >
            {menu.label}
          </button>
          {openMenu === index && (
            <div className="menu-dropdown" role="menu">
              {menu.entries.map((entry, entryIndex) => (
                <MenuItem key={entryIndex} entry={entry} close={() => setOpenMenu(null)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
