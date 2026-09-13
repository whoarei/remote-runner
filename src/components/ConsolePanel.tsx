import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store";
import { useTerminalStore } from "../terminalStore";
import { errorMessage } from "../api";
import { ContextMenu, contextMenuPosition, type MenuEntry, type MenuState } from "./ContextMenu";
import { deviceLabel } from "./DeviceDialog";
import { RunToolbar } from "./RunToolbar";
import { RunConsole } from "./RunConsole";
import { TerminalPage } from "./TerminalPage";

export function ConsolePanel({ visible, collapsed, onToggleCollapse }: {
  visible: boolean; collapsed: boolean; onToggleCollapse: () => void;
}) {
  const { t } = useTranslation();
  const { tabs, activeTab, select, shuttingDown } = useTerminalStore();
  const devices = useAppStore((s) => s.devices);
  const updating = useAppStore((s) => s.updating);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const activeRunId = useAppStore((s) => s.activeRunId);
  const previousRun = useRef(activeRunId);
  useEffect(() => {
    if (activeRunId !== previousRun.current) { select("run"); previousRun.current = activeRunId; }
  }, [activeRunId, select]);

  const open = (deviceId: string) => {
    const device = devices.find((d) => d.id === deviceId);
    if (!device || device.transport === "serial") return;
    setError("");
    if (collapsed) onToggleCollapse();
    void useTerminalStore.getState().open(device.id, device.name).catch((e) => setError(errorMessage(e)));
  };
  const toggleMenu = () => {
    if (menu) { setMenu(null); return; }
    setError("");
    const entries: MenuEntry[] = devices.length
      ? devices.map((device) => ({
        label: `${deviceLabel(device)}${device.transport === "serial" ? t("console.serialNoTerminal") : ""}`,
        disabled: device.transport === "serial",
        onSelect: () => open(device.id),
      }))
      : [{ label: t("console.noDevices"), disabled: true, onSelect: () => undefined }];
    const rect = addButton.current?.getBoundingClientRect();
    setMenu({ ...contextMenuPosition(rect?.left ?? 0, (rect?.bottom ?? 0) + 4, entries.length), entries });
  };
  const contentVisible = visible && !collapsed;
  return <div className="console-panel">
    <div className="console-tabs-bar">
      <button className="console-collapse" aria-label={collapsed ? t("console.expand") : t("console.collapse")} aria-expanded={!collapsed} onClick={onToggleCollapse}>{collapsed ? "▸" : "▾"}</button>
      <div className="console-tabs" role="tablist" aria-label={t("console.tabsAria")} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        if ((event.target as HTMLElement).getAttribute("role") !== "tab") return;
        event.preventDefault();
        const ids = ["run", ...tabs.map((tab) => tab.id)];
        const index = ids.indexOf(activeTab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
        select(ids[next]); document.getElementById(`tab-${ids[next]}`)?.focus();
      }}>
        <button role="tab" id="tab-run" aria-controls="panel-run" aria-selected={activeTab === "run"} tabIndex={activeTab === "run" ? 0 : -1} onClick={() => select("run")}>{t("console.runTab")}</button>
        {tabs.map((tab, index) => <div className="console-tab" key={tab.id}>
          <button role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`} aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => select(tab.id)} title={t("console.terminalTitle", { name: tab.deviceName, index: index + 1 })}>
            <span className={`terminal-dot terminal-${tab.status?.state ?? "connecting"}`} aria-hidden="true" />
            {t("console.terminalTab", { name: tab.deviceName })} <span className="terminal-number">{index + 1}</span>
          </button>
          <button className="terminal-tab-close" disabled={tab.busy} aria-label={t("console.closeTerminalAria", { name: tab.deviceName, index: index + 1 })} onClick={() => void useTerminalStore.getState().close(tab.id)}>×</button>
        </div>)}
      </div>
      <button className="terminal-add" ref={addButton} aria-label={t("console.newTerminal")} aria-haspopup="menu" aria-expanded={!!menu} disabled={updating || shuttingDown || tabs.length >= 8} onClick={toggleMenu}>＋</button>
    </div>
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <section className="run-page" role="tabpanel" id="panel-run" aria-labelledby="tab-run" hidden={!contentVisible || activeTab !== "run"}>
      <RunToolbar />
      <RunConsole collapsed={!contentVisible || activeTab !== "run"} onToggleCollapse={onToggleCollapse} embedded />
    </section>
    {tabs.map((tab) => <TerminalPage key={tab.id} tab={tab} visible={contentVisible && activeTab === tab.id} />)}
  </div>;
}
