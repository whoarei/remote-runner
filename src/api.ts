import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AuthMethod =
  | { type: "password"; password: string }
  | { type: "key"; key_path: string | null };

export interface DeviceProfile {
  id: string;
  name: string;
  transport: "ssh" | "serial";
  serial?: { port: string; baud_rate: number } | null;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  workspace_root: string;
}

export type ScriptKind = "python" | "shell" | "command";
export type ConsoleMode = "pty" | "pipe";

export interface RunRequest {
  device_id: string;
  workspace_dir?: string | null;
  kind: ScriptKind;
  entry?: string | null;
  args?: string[];
  env?: Record<string, string>;
  command?: string | null;
  console_mode?: ConsoleMode;
  cols?: number;
  rows?: number;
  timeout_secs?: number;
}

export interface RunStatus {
  run_id: string;
  device_name: string;
  label: string;
  state: string; // preparing | syncing | starting | running | stopping | exited | failed | canceled
  exit_code: number | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export type RunEvent =
  | { type: "output"; run_id: string; stream: string; data: string }
  | { type: "status"; status: RunStatus };

export interface WorkspaceEntry {
  name: string;
  is_dir: boolean;
}

export interface WorkspaceDocument {
  content: string;
  revision: string;
  eol: "lf" | "crlf";
  bom: boolean;
}

export interface SaveWorkspaceRequest {
  dir: string;
  name: string;
  content: string;
  expectedRevision: string;
  eol: "lf" | "crlf";
  bom: boolean;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

export const api = {
  listDevices: () => invoke<DeviceProfile[]>("list_devices"),
  saveDevice: (device: DeviceProfile) =>
    invoke<DeviceProfile>("save_device", { device }),
  deleteDevice: (id: string) => invoke<void>("delete_device", { id }),
  testDevice: (device: DeviceProfile) =>
    invoke<string>("test_device", { device }),
  listSerialPorts: () => invoke<string[]>("list_serial_ports"),

  listWorkspace: (dir: string) =>
    invoke<WorkspaceEntry[]>("list_workspace", { dir }),
  readWorkspaceFile: (dir: string, name: string) =>
    invoke<WorkspaceDocument>("read_workspace_file", { dir, name }),
  writeWorkspaceFile: (request: SaveWorkspaceRequest) =>
    invoke<{ revision: string }>("write_workspace_file", { request }),

  runScript: (request: RunRequest) => invoke<string>("run_script", { request }),
  stopRun: (runId: string) => invoke<void>("stop_run", { runId }),
  sendRunInput: (runId: string, data: string) =>
    invoke<void>("send_run_input", { runId, data }),
  resizeRunConsole: (runId: string, cols: number, rows: number) =>
    invoke<void>("resize_run_console", { runId, cols, rows }),
  getRunStatus: (runId: string) =>
    invoke<RunStatus | null>("get_run_status", { runId }),
  listRunningRuns: () => invoke<RunStatus[]>("list_running_runs"),
  getRunHistory: () => invoke<RunStatus[]>("get_run_history"),
};

export function onRunEvent(cb: (ev: RunEvent) => void) {
  return listen<RunEvent>("run-event", (e) => cb(e.payload));
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 根据入口文件推断脚本类型 */
export function inferKind(entry: string): ScriptKind {
  const lower = entry.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh")) return "shell";
  return "command";
}
