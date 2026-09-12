import type { OutputBuffer } from "./outputBuffer";
import type { RunStatus } from "./api";
import i18n from "./i18n";

interface ConsoleWriter {
  reset(): void;
  write(data: string | Uint8Array, callback: () => void): void;
}

/** Keep at most one write inside xterm. The store owns all pending output. */
export function createConsoleReplay(term: ConsoleWriter, snapshot: () => {
  runId: string | null; buffer?: OutputBuffer; status?: RunStatus;
}) {
  let runId: string | null = null;
  let next = 0;
  let gaps = 0;
  let writing = false;
  let disposed = false;
  const pump = () => {
    if (disposed || writing) return;
    const current = snapshot();
    let message = "";
    if (current.runId !== runId) {
      term.reset();
      runId = current.runId;
      next = 0;
      gaps = 0;
      if (current.status) message = `\x1b[90m▶ ${current.status.label}  @ ${current.status.device_name}\x1b[0m\r\n`;
    }
    const buffer = current.buffer;
    if (buffer && (buffer.gaps ?? 0) !== gaps) {
      term.reset();
      next = buffer.start;
      gaps = buffer.gaps ?? 0;
      message = `${i18n.t("replay.gap")}\r\n`;
    }
    if (buffer && next < buffer.start) {
      term.reset();
      next = buffer.start;
      message = `${i18n.t("replay.trimmed")}\r\n`;
    }
    const chunk = buffer?.chunks[next - buffer.start];
    const data = message || chunk;
    if (!data) return;
    if (!message) next++;
    writing = true;
    term.write(data, () => { writing = false; pump(); });
  };
  return { pump, dispose: () => { disposed = true; } };
}
