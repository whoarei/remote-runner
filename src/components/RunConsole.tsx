import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import { useAppStore } from "../store";

/**
 * Run Console：绑定的是“远程进程”的 stdin/stdout/stderr，不是 SSH shell。
 */
export function RunConsole() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** 每个 run 已写入的字节数 */
  const writtenRef = useRef<Record<string, number>>({});
  const lastRunRef = useRef<string | null>(null);

  const { activeRunId, consoleSeq, outputBuffers, runs } = useAppStore();

  // 初始化 xterm
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      theme: { background: "#1e1f24" },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const input = term.onData((data) => {
      const { activeRunId: runId, runs } = useAppStore.getState();
      if (runId && runs[runId]?.state === "running") {
        void api.sendRunInput(runId, data).catch(() => {});
      }
    });

    // Ctrl+C：优先作为远程进程的 SIGINT（无选中文本时）
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.ctrlKey && ev.key === "c") {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        if (!sel) {
          const runId = useAppStore.getState().activeRunId;
          if (runId) void api.stopRun(runId).catch(() => {});
          return false;
        }
      }
      return true;
    });

    termRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => {
      fit.fit();
      const runId = useAppStore.getState().activeRunId;
      if (runId) {
        void api.resizeRunConsole(runId, term.cols, term.rows).catch(() => {});
      }
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      input.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = {};
      lastRunRef.current = null;
    };
  }, []);

  // 输出写入 / 切换 run 时重放缓冲
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (activeRunId !== lastRunRef.current) {
      term.reset();
      writtenRef.current = {};
      lastRunRef.current = activeRunId;
      if (activeRunId) {
        const status = useAppStore.getState().runs[activeRunId];
        if (status) {
          term.writeln(`\x1b[90m▶ ${status.label}  @ ${status.device_name}\x1b[0m`);
        }
      }
    }

    if (!activeRunId) return;
    const buffer = outputBuffers[activeRunId];
    if (!buffer) return;
    const { chunks, start } = buffer;
    let written = writtenRef.current[activeRunId] ?? 0;
    if (written < start) {
      term.reset();
      term.writeln("[较早的输出已超过缓冲上限，仅保留最近 2 MiB / 4096 个数据块]");
      written = start;
    }
    if (start + chunks.length > written) {
      for (let i = written - start; i < chunks.length; i++) {
        term.write(chunks[i]);
      }
      writtenRef.current[activeRunId] = start + chunks.length;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, consoleSeq]);

  // 状态行
  const activeRun = activeRunId ? runs[activeRunId] : null;

  useEffect(() => {
    const term = termRef.current;
    if (term && activeRunId && activeRun?.state === "running") {
      void api.resizeRunConsole(activeRunId, term.cols, term.rows).catch(() => {});
    }
  }, [activeRunId, activeRun?.state]);

  return (
    <div className="run-console">
      <div className="console-header">
        <span>Run Console</span>
        {activeRun && (
          <span className={`run-state state-${activeRun.state}`}>
            {activeRun.run_id} · {activeRun.state}
            {activeRun.exit_code != null && ` · exit=${activeRun.exit_code}`}
          </span>
        )}
      </div>
      <div ref={containerRef} className="console-body" />
    </div>
  );
}
