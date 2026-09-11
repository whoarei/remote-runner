import { create } from "zustand";
import { api, DeviceProfile, RunEvent, RunStatus, WorkspaceEntry } from "./api";
import { appendOutput, OutputBuffer } from "./outputBuffer";
import { loadWorkspaceHistory, rememberWorkspace, saveWorkspaceHistory } from "./workspaceHistory";

interface AppState {
  devices: DeviceProfile[];
  selectedDeviceId: string | null;

  workspaceDir: string | null;
  recentWorkspaces: string[];
  workspaceFiles: WorkspaceEntry[];
  openFile: string | null;
  fileContent: string;

  runs: Record<string, RunStatus>;
  /** 每个 run 的输出缓冲（base64 拼接前的原始字节已转成 string 存储代价大，直接存字节数组） */
  outputBuffers: Record<string, OutputBuffer>;
  activeRunId: string | null;
  consoleSize: { cols: number; rows: number };
  /** console 需要重绘的信号 */
  consoleSeq: number;

  history: RunStatus[];

  loadDevices: () => Promise<void>;
  selectDevice: (id: string | null) => void;
  setWorkspaceDir: (dir: string | null) => Promise<void>;
  openWorkspaceFile: (name: string) => Promise<void>;
  handleRunEvent: (ev: RunEvent) => void;
  setActiveRun: (id: string | null) => void;
  setConsoleSize: (cols: number, rows: number) => void;
  loadHistory: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  devices: [],
  selectedDeviceId: null,

  workspaceDir: null,
  recentWorkspaces: loadWorkspaceHistory(),
  workspaceFiles: [],
  openFile: null,
  fileContent: "",

  runs: {},
  outputBuffers: {},
  activeRunId: null,
  consoleSize: { cols: 80, rows: 24 },
  consoleSeq: 0,

  history: [],

  loadDevices: async () => {
    const devices = await api.listDevices();
    set((s) => ({
      devices,
      selectedDeviceId:
        s.selectedDeviceId && devices.some((d) => d.id === s.selectedDeviceId)
          ? s.selectedDeviceId
          : devices[0]?.id ?? null,
    }));
  },

  selectDevice: (id) => set({ selectedDeviceId: id }),

  setWorkspaceDir: async (dir) => {
    if (!dir) {
      set({ workspaceDir: null, workspaceFiles: [], openFile: null, fileContent: "" });
      return;
    }
    const files = await api.listWorkspace(dir);
    const recentWorkspaces = rememberWorkspace(get().recentWorkspaces, dir);
    saveWorkspaceHistory(recentWorkspaces);
    set({ workspaceDir: dir, workspaceFiles: files, recentWorkspaces, openFile: null, fileContent: "" });
  },

  openWorkspaceFile: async (name) => {
    const dir = get().workspaceDir;
    if (!dir) return;
    try {
      const content = await api.readWorkspaceFile(dir, name);
      if (get().workspaceDir === dir) set({ openFile: name, fileContent: content });
    } catch (e) {
      console.error("read file failed", e);
    }
  },

  handleRunEvent: (ev) => {
    if (ev.type === "output") {
      const bytes = Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0));
      set((s) => {
        const bufs = { ...s.outputBuffers };
        bufs[ev.run_id] = appendOutput(bufs[ev.run_id], bytes);
        return { outputBuffers: bufs, consoleSeq: s.consoleSeq + 1 };
      });
    } else {
      set((s) => ({
        runs: { ...s.runs, [ev.status.run_id]: ev.status },
      }));
      const st = ev.status.state;
      if (st === "exited" || st === "failed" || st === "canceled") {
        set((s) => ({ history: [ev.status, ...s.history.filter((h) => h.run_id !== ev.status.run_id)].slice(0, 200) }));
      }
    }
  },

  setActiveRun: (id) => set((s) => ({ activeRunId: id, consoleSeq: s.consoleSeq + 1 })),
  setConsoleSize: (cols, rows) => set({ consoleSize: { cols, rows } }),

  loadHistory: async () => {
    set({ history: await api.getRunHistory() });
  },
}));
