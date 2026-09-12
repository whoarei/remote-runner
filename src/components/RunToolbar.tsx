import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, inferKind, RunRequest, ScriptKind } from "../api";
import { useAppStore } from "../store";
import { dirtyDocument } from "../editorDocument";
import { isActiveRun } from "../runState";

export function RunToolbar() {
  const {
    selectedDeviceId,
    devices,
    workspaceDir,
    workspaceFiles,
    openFile,
    activeRunId,
    runs,
  } = useAppStore(useShallow((s) => ({ selectedDeviceId: s.selectedDeviceId, devices: s.devices,
    workspaceDir: s.workspaceDir, workspaceFiles: s.workspaceFiles, openFile: s.openFile,
    activeRunId: s.activeRunId, runs: s.runs })));

  const { mode, entry, argsText, command, consoleMode, timeoutSecs } = useAppStore((s) => s.runDraft);
  const setDraft = useAppStore((s) => s.setRunDraft);
  const [busy, setBusy] = useState(false);
  const dirty = useAppStore(dirtyDocument);
  const editorBusy = useAppStore((s) => s.loading || s.saving || s.starting || s.guarding);
  const isSerial = devices.find((device) => device.id === selectedDeviceId)?.transport === "serial";
  const effectiveConsoleMode = isSerial ? "pty" : consoleMode;

  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running =
    activeRun &&
    ["preparing", "syncing", "starting", "running", "stopping"].includes(activeRun.state);


  const effectiveEntry = entry || openFile || "";

  const run = async () => {
    if (!selectedDeviceId) {
      alert("请先选择设备");
      return;
    }
    setBusy(true);
    try {
      const args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      let request: RunRequest;
      if (mode === "command") {
        if (!command.trim()) return;
        request = {
          device_id: selectedDeviceId,
          workspace_dir: workspaceDir,
          kind: "command",
          command: command.trim(),
          console_mode: effectiveConsoleMode,
          timeout_secs: timeoutSecs,
        };
      } else {
        if (!effectiveEntry) {
          alert("请选择入口脚本");
          return;
        }
        const kind: ScriptKind = inferKind(effectiveEntry);
        if (kind === "command") {
          alert("仅支持 .py / .sh 脚本，其他请用命令模式");
          return;
        }
        request = {
          device_id: selectedDeviceId,
          workspace_dir: workspaceDir,
          kind,
          entry: effectiveEntry,
          args,
          console_mode: effectiveConsoleMode,
          timeout_secs: timeoutSecs,
        };
      }
      await useAppStore.getState().startRun(request);
    } catch (e) {
      alert(`启动失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      if (activeRunId) await api.stopRun(activeRunId);
    } catch (e) { alert(`停止失败: ${e}`); }
  };

  const scriptFiles = workspaceFiles.filter(
    (f) => !f.is_dir && /\.(py|sh)$/i.test(f.name)
  );

  return (
    <div className="run-toolbar">
      {Object.values(runs).some(isActiveRun) && <select aria-label="选择运行中的任务" value={activeRun && isActiveRun(activeRun) ? activeRunId! : ""}
        onChange={(e) => { if (e.target.value) useAppStore.getState().setActiveRun(e.target.value); }}>
        <option value="">运行中的任务…</option>
        {Object.values(runs).filter(isActiveRun).map((r) => <option key={r.run_id} value={r.run_id}>{r.label} @ {r.device_name}</option>)}
      </select>}
      <select value={mode} onChange={(e) => setDraft({ mode: e.target.value as "script" | "command" })}>
        <option value="script">脚本</option>
        <option value="command">命令</option>
      </select>

      {mode === "script" ? (
        <select value={effectiveEntry} onChange={(e) => setDraft({ entry: e.target.value })}>
          <option value="">选择入口脚本…</option>
          {scriptFiles.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="command-input"
          placeholder="输入远程命令，如：cat /proc/cpuinfo | head -5"
          value={command}
          onChange={(e) => setDraft({ command: e.target.value })}
        />
      )}

      {mode === "script" && (
        <input
          className="args-input"
          placeholder="参数（空格分隔）"
          value={argsText}
          onChange={(e) => setDraft({ argsText: e.target.value })}
        />
      )}

      <select
        value={effectiveConsoleMode}
        disabled={isSerial}
        title={isSerial ? "串口：合并输出，仅启动时设置行列数" : "console 模式：pty 支持交互/TUI；pipe 分离 stdout/stderr"}
        onChange={(e) => setDraft({ consoleMode: e.target.value as "pty" | "pipe" })}
      >
        <option value="pty">{isSerial ? "串口 Console" : "pty"}</option>
        {!isSerial && <option value="pipe">pipe</option>}
      </select>

      <input
        className="timeout-input"
        type="number"
        min={0}
        title="超时（秒），0 = 不限"
        value={timeoutSecs}
        onChange={(e) => setDraft({ timeoutSecs: Number(e.target.value) || 0 })}
      />

      {running ? (
        <button className="danger" onClick={stop}>
          ■ Stop
        </button>
      ) : (
        <button className="primary" disabled={busy || editorBusy || !selectedDeviceId} onClick={run}>
          {dirty ? "▶ 保存并运行" : "▶ Run"}
        </button>
      )}

      {activeRun && (
        <span className={`run-state state-${activeRun.state}`}>
          {activeRun.state}
          {activeRun.exit_code != null && ` (${activeRun.exit_code})`}
          {activeRun.error && ` — ${activeRun.error}`}
        </span>
      )}
    </div>
  );
}
