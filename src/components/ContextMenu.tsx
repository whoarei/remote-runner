import { useEffect, useRef } from "react";

export type MenuEntry =
  | { label: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | "separator";

export interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

/** 依据点击位置计算菜单坐标，避免超出窗口右/下边缘 */
export function contextMenuPosition(clientX: number, clientY: number, entryCount: number) {
  return {
    x: Math.max(0, Math.min(clientX, window.innerWidth - 200)),
    y: Math.max(0, Math.min(clientY, window.innerHeight - entryCount * 30 - 16)),
  };
}

export function ContextMenu({ menu, disabled, onClose }: {
  menu: MenuState | null;
  /** 面板级禁用（如运行期间禁止文件修改）；单项禁用用 entry.disabled */
  disabled?: boolean;
  onClose: () => void;
}) {
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
          disabled={disabled || entry.disabled}
          onClick={() => { onClose(); entry.onSelect(); }}
        >
          <span className="menu-check" aria-hidden="true" />
          <span className="menu-label">{entry.label}</span>
        </button>)}
    </div>
  );
}
