import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import { useTerminalStore, terminalActive, type TerminalTab } from "../terminalStore";
import { readTerminal, terminalInput } from "../terminalIO";

const labels = { connecting: "连接中…", connected: "已连接", closing: "关闭中…", exited: "已退出", failed: "连接失败", closed: "已关闭" };

export function TerminalPage({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fit = useRef<() => void>();
  const current = useRef({ tab, visible });
  current.current = { tab, visible };
  const sessionId = tab.status?.session_id;

  useEffect(() => {
    if (!container.current || !sessionId) return;
    const term = new Terminal({ fontSize: 13, fontFamily: "Consolas, 'Cascadia Mono', monospace",
      theme: { background: "#1e1f24" }, scrollback: 3000, convertEol: false });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(container.current);
    terminal.current = term;
    let disposed = false;
    const report = (e: unknown) => { if (!disposed) useTerminalStore.getState().report(tab.id, sessionId, e); };
    let lastSize = "";
    fit.current = () => {
      if (!current.current.visible || !container.current?.clientWidth || !container.current.clientHeight) return;
      addon.fit();
      const size = `${term.cols}:${term.rows}`;
      if (current.current.tab.status?.state === "connected" && size !== lastSize) {
        lastSize = size;
        void api.resizeTerminal(sessionId, term.cols, term.rows).catch((e) => { lastSize = ""; report(e); });
      }
    };
    fit.current();
    const observer = new ResizeObserver(() => fit.current?.());
    observer.observe(container.current);
    const input = terminalInput((data) => api.sendTerminalInput(sessionId, data), report);
    const subscription = term.onData((data) => {
      if (current.current.tab.status?.state === "connected" && !current.current.tab.busy) input.send(data);
    });
    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || !event.shiftKey || !["c", "v"].includes(event.key.toLowerCase())) return true;
      if (event.type === "keydown") {
        if (event.key.toLowerCase() === "c") void navigator.clipboard.writeText(term.getSelection()).catch(report);
        else void navigator.clipboard.readText().then((text) => { if (!disposed) term.paste(text); }).catch(report);
      }
      return false;
    });
    const stop = readTerminal(() => api.readTerminal(sessionId),
      (bytes) => new Promise<void>((resolve) => term.write(bytes, resolve)),
      ({ status }) => useTerminalStore.getState().update(tab.id, sessionId, status), report);
    return () => {
      disposed = true;
      stop(); input.dispose(); subscription.dispose(); observer.disconnect(); term.dispose();
      terminal.current = undefined; fit.current = undefined;
    };
  }, [tab.id, sessionId]);

  useEffect(() => {
    if (visible) {
      fit.current?.();
      if (tab.status?.state === "connected") terminal.current?.focus();
    }
  }, [visible, tab.status?.state, sessionId]);

  return <section className="terminal-page" role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} hidden={!visible}>
    <div className="terminal-toolbar">
      <span className={`terminal-status terminal-${tab.status?.state ?? "connecting"}`} aria-live="polite">
        {tab.busy ? "处理中…" : tab.status ? labels[tab.status.state] : "未连接"}
        {tab.status?.exit_code != null && ` · exit=${tab.status.exit_code}`}
      </span>
      <span className="terminal-hint">Ctrl+C 中断 · Ctrl+Shift+C / V 复制粘贴</span>
      {!terminalActive(tab) && <button onClick={() => void useTerminalStore.getState().reconnect(tab.id)}>重新连接</button>}
      <button disabled={tab.busy} title="关闭此终端会话及标签" onClick={() => void useTerminalStore.getState().close(tab.id)}>关闭终端</button>
    </div>
    {(tab.error || tab.status?.error) && <div className="terminal-error" role="alert">{tab.error || tab.status?.error}</div>}
    <div className="console-body" ref={container} />
  </section>;
}
