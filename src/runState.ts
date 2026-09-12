import type { RunStatus } from "./api";

export const isActiveRun = (run: RunStatus) =>
  ["preparing", "syncing", "starting", "running", "stopping"].includes(run.state);

const phase = ["preparing", "syncing", "starting", "running", "stopping"];
export function newestStatus(current: RunStatus | undefined, incoming: RunStatus): RunStatus {
  if (current && (!isActiveRun(current) || phase.indexOf(current.state) > phase.indexOf(incoming.state) && isActiveRun(incoming))) return current;
  return incoming;
}

export interface RunDraft {
  mode: "script" | "command";
  entry: string;
  argsText: string;
  command: string;
  consoleMode: "pty" | "pipe";
  timeoutSecs: number;
}

export const DEFAULT_RUN_DRAFT: RunDraft = {
  mode: "script", entry: "", argsText: "", command: "", consoleMode: "pty", timeoutSecs: 0,
};
