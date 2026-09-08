import { useState } from "react";
import { api, inferKind, RunRequest, ScriptKind } from "../api";
import { useAppStore } from "../store";

export function RunToolbar() {
  const {
    selectedDeviceId,
    workspaceDir,
    workspaceFiles,
    openFile,
    activeRunId,
    runs,
    setActiveRun,
  } = useAppStore();

  const [mode, setMode] = useState<"script" | "command">("script");
  const [entry, setEntry] = useState<string>("");
  const [argsText, setArgsText] = useState("");
  const [command, setCommand] = useState("");
  const [consoleMode, setConsoleMode] = useState<"pty" | "pipe">("pty");
  const [timeoutSecs, setTimeoutSecs] = useState(0);
  const [busy, setBusy] = useState(false);

  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running =
    activeRun &&
    ["preparing", "syncing", "running", "stopping"].includes(activeRun.state);

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
          console_mode: consoleMode,
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
          console_mode: consoleMode,
          timeout_secs: timeoutSecs,
        };
      }
      const runId = await api.runScript(request);
      setActiveRun(runId);
    } catch (e) {
      alert(`启动失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (activeRunId) await api.stopRun(activeRunId);
  };

  const scriptFiles = workspaceFiles.filter(
    (f) => !f.is_dir && /\.(py|sh)$/i.test(f.name)
  );

  return (
    <div className="run-toolbar">
      <select value={mode} onChange={(e) => setMode(e.target.value as never)}>
        <option value="script">脚本</option>
        <option value="command">命令</option>
      </select>

      {mode === "script" ? (
        <select value={effectiveEntry} onChange={(e) => setEntry(e.target.value)}>
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
          onChange={(e) => setCommand(e.target.value)}
        />
      )}

      {mode === "script" && (
        <input
          className="args-input"
          placeholder="参数（空格分隔）"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
        />
      )}

      <select
        value={consoleMode}
        title="console 模式：pty 支持交互/TUI；pipe 分离 stdout/stderr"
        onChange={(e) => setConsoleMode(e.target.value as never)}
      >
        <option value="pty">pty</option>
        <option value="pipe">pipe</option>
      </select>

      <input
        className="timeout-input"
        type="number"
        min={0}
        title="超时（秒），0 = 不限"
        value={timeoutSecs}
        onChange={(e) => setTimeoutSecs(Number(e.target.value) || 0)}
      />

      {running ? (
        <button className="danger" onClick={stop}>
          ■ Stop
        </button>
      ) : (
        <button className="primary" disabled={busy || !selectedDeviceId} onClick={run}>
          ▶ Run
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
