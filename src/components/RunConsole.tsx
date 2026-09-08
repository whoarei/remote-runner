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
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    term.onData((data) => {
      const runId = useAppStore.getState().activeRunId;
      if (runId) void api.sendRunInput(runId, data).catch(() => {});
    });

    // Ctrl+C：优先作为远程进程的 SIGINT（无选中文本时）
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.ctrlKey && ev.key === "c") {
        const sel = term.getSelection();
        if (!sel) {
          const runId = useAppStore.getState().activeRunId;
          if (runId) void api.sendRunInput(runId, "\x03").catch(() => {});
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
    return () => observer.disconnect();
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
    const chunks = outputBuffers[activeRunId] ?? [];
    const written = writtenRef.current[activeRunId] ?? 0;
    // chunks 按追加顺序写入；用计数比对简化（store 里只增不减）
    if (chunks.length > written) {
      for (let i = written; i < chunks.length; i++) {
        term.write(chunks[i]);
      }
      writtenRef.current[activeRunId] = chunks.length;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, consoleSeq]);

  // 状态行
  const activeRun = activeRunId ? runs[activeRunId] : null;

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
