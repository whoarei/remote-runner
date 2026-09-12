import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { useTerminalStore } from "../terminalStore";
import { errorMessage } from "../api";
import { RunToolbar } from "./RunToolbar";
import { RunConsole } from "./RunConsole";
import { TerminalPage } from "./TerminalPage";

export function ConsolePanel({ visible, collapsed, onToggleCollapse }: {
  visible: boolean; collapsed: boolean; onToggleCollapse: () => void;
}) {
  const { tabs, activeTab, select, shuttingDown } = useTerminalStore();
  const devices = useAppStore((s) => s.devices);
  const selected = useAppStore((s) => s.selectedDeviceId);
  const updating = useAppStore((s) => s.updating);
  const [choosing, setChoosing] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState("");
  const picker = useRef<HTMLSelectElement>(null);
  const activeRunId = useAppStore((s) => s.activeRunId);
  const previousRun = useRef(activeRunId);
  useEffect(() => {
    if (activeRunId !== previousRun.current) { select("run"); previousRun.current = activeRunId; }
  }, [activeRunId, select]);
  useEffect(() => { if (choosing) picker.current?.focus(); }, [choosing]);

  const open = () => {
    const device = devices.find((d) => d.id === deviceId);
    if (!device || device.transport === "serial") return;
    setChoosing(false); setError("");
    if (collapsed) onToggleCollapse();
    void useTerminalStore.getState().open(device.id, device.name).catch((e) => setError(errorMessage(e)));
  };
  const contentVisible = visible && !collapsed;
  return <div className="console-panel">
    <div className="console-tabs-bar">
      <button className="console-collapse" aria-label={collapsed ? "展开控制台" : "折叠控制台"} aria-expanded={!collapsed} onClick={onToggleCollapse}>{collapsed ? "▸" : "▾"}</button>
      <div className="console-tabs" role="tablist" aria-label="控制台与终端" onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        if ((event.target as HTMLElement).getAttribute("role") !== "tab") return;
        event.preventDefault();
        const ids = ["run", ...tabs.map((tab) => tab.id)];
        const index = ids.indexOf(activeTab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
        select(ids[next]); document.getElementById(`tab-${ids[next]}`)?.focus();
      }}>
        <button role="tab" id="tab-run" aria-controls="panel-run" aria-selected={activeTab === "run"} tabIndex={activeTab === "run" ? 0 : -1} onClick={() => select("run")}>运行控制台</button>
        {tabs.map((tab, index) => <div className="console-tab" key={tab.id}>
          <button role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`} aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => select(tab.id)} title={`终端 · ${tab.deviceName} · ${index + 1}`}>
            <span className={`terminal-dot terminal-${tab.status?.state ?? "connecting"}`} aria-hidden="true" />
            终端 · {tab.deviceName} <span className="terminal-number">{index + 1}</span>
          </button>
          <button className="terminal-tab-close" disabled={tab.busy} aria-label={`关闭终端 ${tab.deviceName} ${index + 1}`} onClick={() => void useTerminalStore.getState().close(tab.id)}>×</button>
        </div>)}
      </div>
      <button className="terminal-add" aria-label="新建终端" aria-expanded={choosing} disabled={updating || shuttingDown || tabs.length >= 8} onClick={() => {
        const available = devices.filter((d) => d.transport !== "serial");
        setDeviceId(available.find((d) => d.id === selected)?.id ?? available[0]?.id ?? "");
        setChoosing(!choosing); setError("");
      }}>＋</button>
    </div>
    {choosing && <div className="terminal-picker">
      <label>连接设备 <select ref={picker} aria-label="终端设备" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setChoosing(false); }}>
        <option value="">选择 SSH / WSL 设备…</option>
        {devices.map((device) => <option key={device.id} value={device.id} disabled={device.transport === "serial"}>{device.name} · {device.transport.toUpperCase()}{device.transport === "serial" ? "（暂不支持终端）" : ""}</option>)}
      </select></label>
      <button className="primary" disabled={!deviceId || updating || shuttingDown} onClick={open}>打开终端</button>
      <button onClick={() => setChoosing(false)}>取消</button>
    </div>}
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <section className="run-page" role="tabpanel" id="panel-run" aria-labelledby="tab-run" hidden={!contentVisible || activeTab !== "run"}>
      <RunToolbar />
      <RunConsole collapsed={!contentVisible || activeTab !== "run"} onToggleCollapse={onToggleCollapse} embedded />
    </section>
    {tabs.map((tab) => <TerminalPage key={tab.id} tab={tab} visible={contentVisible && activeTab === tab.id} />)}
  </div>;
}
