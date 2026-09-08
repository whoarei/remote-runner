import { create } from "zustand";
import { api, DeviceProfile, RunEvent, RunStatus, WorkspaceEntry } from "./api";

interface AppState {
  devices: DeviceProfile[];
  selectedDeviceId: string | null;

  workspaceDir: string | null;
  workspaceFiles: WorkspaceEntry[];
  openFile: string | null;
  fileContent: string;

  runs: Record<string, RunStatus>;
  /** 每个 run 的输出缓冲（base64 拼接前的原始字节已转成 string 存储代价大，直接存字节数组） */
  outputBuffers: Record<string, Uint8Array[]>;
  activeRunId: string | null;
  /** console 需要重绘的信号 */
  consoleSeq: number;

  history: RunStatus[];

  loadDevices: () => Promise<void>;
  selectDevice: (id: string | null) => void;
  setWorkspaceDir: (dir: string | null) => Promise<void>;
  openWorkspaceFile: (name: string) => Promise<void>;
  handleRunEvent: (ev: RunEvent) => void;
  setActiveRun: (id: string | null) => void;
  loadHistory: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  devices: [],
  selectedDeviceId: null,

  workspaceDir: null,
  workspaceFiles: [],
  openFile: null,
  fileContent: "",

  runs: {},
  outputBuffers: {},
  activeRunId: null,
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
    set({ workspaceDir: dir, workspaceFiles: files, openFile: null, fileContent: "" });
  },

  openWorkspaceFile: async (name) => {
    const dir = get().workspaceDir;
    if (!dir) return;
    try {
      const content = await api.readWorkspaceFile(dir, name);
      set({ openFile: name, fileContent: content });
    } catch (e) {
      console.error("read file failed", e);
    }
  },

  handleRunEvent: (ev) => {
    if (ev.type === "output") {
      const bytes = Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0));
      set((s) => {
        const bufs = { ...s.outputBuffers };
        (bufs[ev.run_id] = bufs[ev.run_id] ?? []).push(bytes);
        return { outputBuffers: bufs, consoleSeq: s.consoleSeq + 1 };
      });
    } else {
      set((s) => ({
        runs: { ...s.runs, [ev.status.run_id]: ev.status },
      }));
      const st = ev.status.state;
      if (st === "exited" || st === "failed" || st === "canceled") {
        void get().loadHistory();
      }
    }
  },

  setActiveRun: (id) => set((s) => ({ activeRunId: id, consoleSeq: s.consoleSeq + 1 })),

  loadHistory: async () => {
    set({ history: await api.getRunHistory() });
  },
}));
