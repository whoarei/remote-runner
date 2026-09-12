import { invoke } from "@tauri-apps/api/core";

export type AuthMethod =
  | { type: "password"; password: string }
  | { type: "key"; key_path: string | null };

export interface DeviceProfile {
  id: string;
  name: string;
  transport: "ssh" | "serial" | "wsl";
  serial?: { port: string; baud_rate: number } | null;
  wsl?: { distribution: string; user: string } | null;
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
  | { type: "status"; status: RunStatus }
  | { type: "resync"; statuses: RunStatus[] };

export interface WorkspaceEntry {
  name: string;
  is_dir: boolean;
}

export type WorkspaceEntryKind = "file" | "dir";

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

export interface AppUpdateInfo {
  current_version: string;
  latest_version: string;
  notes: string | null;
  published_at: string | null;
  download_url: string;
  /** false 表示 portable 形态，只能回退到手动下载（方案 B） */
  can_auto_install: boolean;
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
  listWslDistributions: () => invoke<string[]>("list_wsl_distributions"),

  listWorkspaceDir: (dir: string, subdir: string) =>
    invoke<WorkspaceEntry[]>("list_workspace_dir", { dir, subdir }),
  readWorkspaceFile: (dir: string, name: string) =>
    invoke<WorkspaceDocument>("read_workspace_file", { dir, name }),
  writeWorkspaceFile: (request: SaveWorkspaceRequest) =>
    invoke<{ revision: string }>("write_workspace_file", { request }),
  createWorkspaceEntry: (dir: string, name: string, kind: WorkspaceEntryKind) =>
    invoke<void>("create_workspace_entry", { dir, name, kind }),
  renameWorkspaceEntry: (dir: string, oldName: string, newName: string) =>
    invoke<void>("rename_workspace_entry", { dir, oldName, newName }),
  deleteWorkspaceEntry: (dir: string, name: string) =>
    invoke<void>("delete_workspace_entry", { dir, name }),

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
  drainRunEvents: () => invoke<RunEvent[]>("drain_run_events"),

  checkAppUpdate: () => invoke<AppUpdateInfo | null>("check_app_update"),
  installAppUpdate: (expectedVersion: string) => invoke<void>("install_app_update", { expectedVersion }),
};

// One bounded IPC response at a time: a slow/hidden WebView cannot accumulate
// unbounded native event deliveries. StrictMode cleanup waits for an in-flight
// response to be consumed before the next subscriber starts draining.
let drainInFlight: Promise<void> = Promise.resolve();
export function onRunEvents(cb: (events: RunEvent[]) => void, onError: (error: unknown) => void) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => {
    drainInFlight = drainInFlight.then(async () => {
      if (disposed) return;
      try { cb(await api.drainRunEvents()); }
      catch (error) { if (!disposed) onError(error); }
    }).finally(() => {
      if (!disposed) timer = setTimeout(poll, 33);
    });
  };
  poll();
  return () => { disposed = true; clearTimeout(timer); };
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
