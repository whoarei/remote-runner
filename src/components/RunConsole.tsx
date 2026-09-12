import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import { useAppStore } from "../store";
import { PanelTitle } from "./PanelTitle";
import { useShallow } from "zustand/react/shallow";
import { createConsoleReplay } from "../consoleReplay";

/**
 * Run Console：绑定的是“远程进程”的 stdin/stdout/stderr，不是 SSH shell。
 * 折叠时终端保持挂载，仅隐藏 DOM，避免 xterm 重新附着和输出丢失。
 */
export function RunConsole({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const replayRef = useRef<ReturnType<typeof createConsoleReplay> | null>(null);

  const { activeRunId, buffer, activeRun } = useAppStore(useShallow((s) => ({
    activeRunId: s.activeRunId, buffer: s.activeRunId ? s.outputBuffers[s.activeRunId] : undefined,
    activeRun: s.activeRunId ? s.runs[s.activeRunId] : undefined,
  })));

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
    useAppStore.getState().setConsoleSize(term.cols, term.rows);

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
    const replay = createConsoleReplay(term, () => {
      const s = useAppStore.getState();
      return { runId: s.activeRunId, buffer: s.activeRunId ? s.outputBuffers[s.activeRunId] : undefined,
        status: s.activeRunId ? s.runs[s.activeRunId] : undefined };
    });
    replayRef.current = replay;
    replay.pump();

    const observer = new ResizeObserver(() => {
      fit.fit();
      useAppStore.getState().setConsoleSize(term.cols, term.rows);
      const runId = useAppStore.getState().activeRunId;
      if (runId) {
        void api.resizeRunConsole(runId, term.cols, term.rows).catch(() => {});
      }
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      input.dispose();
      replay.dispose();
      replayRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => { replayRef.current?.pump(); }, [activeRunId, buffer]);

  // 状态行

  useEffect(() => {
    const term = termRef.current;
    if (term && activeRunId && activeRun?.state === "running") {
      void api.resizeRunConsole(activeRunId, term.cols, term.rows).catch(() => {});
    }
  }, [activeRunId, activeRun?.state]);

  return (
    <div className="run-console">
      <PanelTitle className="console-header" title="Run Console" collapsed={collapsed} onToggle={onToggleCollapse}>
        {activeRun && (
          <span className={`run-state state-${activeRun.state}`}>
            {activeRun.run_id} · {activeRun.state}
            {activeRun.exit_code != null && ` · exit=${activeRun.exit_code}`}
          </span>
        )}
      </PanelTitle>
      <div ref={containerRef} className={`console-body${collapsed ? " collapsed" : ""}`} />
    </div>
  );
}
