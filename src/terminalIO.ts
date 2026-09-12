import { base64ToBytes, type TerminalRead } from "./api";
import i18n from "./i18n";

/** Drain only after xterm parsed the previous bytes. Hidden terminals use the same pump. */
export function readTerminal(
  read: () => Promise<TerminalRead>,
  write: (bytes: Uint8Array) => Promise<void>,
  status: (result: TerminalRead) => void,
  error: (error: unknown) => void,
) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const result = await read();
      if (disposed) return;
      if (result.data) await write(base64ToBytes(result.data));
      if (disposed) return;
      status(result);
      // Final status may arrive with multiple unread output batches.
      if (!result.data && ["exited", "closed", "failed"].includes(result.status.state)) return;
      timer = setTimeout(() => void poll(), result.data ? 0 : 33);
    } catch (e) {
      if (!disposed) { error(e); timer = setTimeout(() => void poll(), 1000); }
    }
  };
  // StrictMode's initial cleanup happens before the first destructive native read.
  timer = setTimeout(() => void poll(), 0);
  return () => { disposed = true; clearTimeout(timer); };
}

/** Serialize input, bound paste memory, and preserve surrogate pairs across IPC chunks. */
export function terminalInput(send: (text: string) => Promise<void>, error: (error: unknown) => void) {
  let queue: string[] = [];
  let size = 0;
  let sending = false;
  let disposed = false;
  const flush = async () => {
    if (sending || disposed) return;
    sending = true;
    try {
      while (queue.length && !disposed) {
        const chunk = queue.shift()!;
        await send(chunk);
        size -= chunk.length;
      }
    } catch (e) { queue = []; size = 0; if (!disposed) error(e); }
    finally { sending = false; }
  };
  return {
    send(text: string) {
      if (disposed || !text) return;
      if (size + text.length > 64 * 1024) { error(new Error(i18n.t("terminal.inputTooLong"))); return; }
      size += text.length;
      let chunk = "";
      for (const char of text) {
        if (chunk.length + char.length > 4096) { queue.push(chunk); chunk = ""; }
        chunk += char;
      }
      if (chunk) queue.push(chunk);
      void flush();
    },
    dispose() { disposed = true; queue = []; },
  };
}
