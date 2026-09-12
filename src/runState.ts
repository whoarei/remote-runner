import type { RunStatus } from "./api";
import i18n from "./i18n";

export const isActiveRun = (run: RunStatus) =>
  ["preparing", "syncing", "starting", "running", "stopping"].includes(run.state);

/** 运行状态的界面展示名；后端未知状态原样显示。CSS class 仍用原始 state。 */
export function runStateLabel(state: string): string {
  const key = `state.${state}`;
  return i18n.exists(key) ? i18n.t(key) : state;
}

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
