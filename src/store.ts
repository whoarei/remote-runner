import { create } from "zustand";
import { api, DeviceProfile, RunEvent, RunStatus, WorkspaceEntry, RunRequest, errorMessage } from "./api";
import { ChangeChoice, dirtyDocument, EditorLanguage, inferLanguage, uploadBusy } from "./editorDocument";
import { appendOutput, OutputBuffer } from "./outputBuffer";
import { loadWorkspaceHistory, rememberWorkspace, saveWorkspaceHistory } from "./workspaceHistory";
import { DEFAULT_LAYOUT, LayoutState, loadLayout, normalizeLayout, saveLayout } from "./layoutState";

interface AppState {
  devices: DeviceProfile[];
  selectedDeviceId: string | null;

  workspaceDir: string | null;
  recentWorkspaces: string[];
  workspaceFiles: WorkspaceEntry[];
  openFile: string | null;
  fileContent: string;
  savedContent: string;
  revision: string | null;
  eol: "lf" | "crlf";
  bom: boolean;
  language: EditorLanguage;
  documentGeneration: number;
  loading: boolean;
  saving: boolean;
  starting: boolean;
  guarding: boolean;
  editorError: string | null;
  conflict: boolean;
  changePrompt: { name: string; resolve: (choice: ChangeChoice) => void } | null;

  runs: Record<string, RunStatus>;
  /** 每个 run 的输出缓冲（base64 拼接前的原始字节已转成 string 存储代价大，直接存字节数组） */
  outputBuffers: Record<string, OutputBuffer>;
  activeRunId: string | null;
  consoleSize: { cols: number; rows: number };
  /** console 需要重绘的信号 */
  consoleSeq: number;

  history: RunStatus[];

  layout: LayoutState;
  setLayout: (patch: Partial<LayoutState>) => void;
  resetLayout: () => void;

  loadDevices: () => Promise<void>;
  selectDevice: (id: string | null) => void;
  setWorkspaceDir: (dir: string | null) => Promise<void>;
  openWorkspaceFile: (name: string) => Promise<void>;
  editContent: (content: string) => void;
  setLanguage: (language: EditorLanguage) => void;
  saveFile: () => Promise<boolean>;
  confirmUnsaved: () => Promise<boolean>;
  reloadFile: () => Promise<void>;
  startRun: (request: RunRequest) => Promise<string>;
  handleRunEvent: (ev: RunEvent) => void;
  setActiveRun: (id: string | null) => void;
  setConsoleSize: (cols: number, rows: number) => void;
  loadHistory: () => Promise<void>;
}

let loadSequence = 0;
export const useAppStore = create<AppState>((set, get) => ({
  devices: [],
  selectedDeviceId: null,

  workspaceDir: null,
  recentWorkspaces: loadWorkspaceHistory(),
  workspaceFiles: [],
  openFile: null,
  fileContent: "",
  savedContent: "",
  revision: null,
  eol: "lf",
  bom: false,
  language: "text",
  documentGeneration: 0,
  loading: false,
  saving: false,
  starting: false,
  guarding: false,
  editorError: null,
  conflict: false,
  changePrompt: null,

  runs: {},
  outputBuffers: {},
  activeRunId: null,
  consoleSize: { cols: 80, rows: 24 },
  consoleSeq: 0,

  history: [],

  layout: loadLayout(),

  setLayout: (patch) => {
    const layout = normalizeLayout({ ...get().layout, ...patch });
    saveLayout(layout);
    set({ layout });
  },

  resetLayout: () => {
    const layout = { ...DEFAULT_LAYOUT };
    saveLayout(layout);
    set({ layout });
  },

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
    if (get().saving || get().starting || get().guarding) return;
    const sequence = ++loadSequence;
    if (!await get().confirmUnsaved() || sequence !== loadSequence) return;
    set({ loading: true, editorError: null });
    try {
      const files = dir ? await api.listWorkspace(dir) : [];
      if (sequence !== loadSequence) return;
      const recentWorkspaces = dir ? rememberWorkspace(get().recentWorkspaces, dir) : get().recentWorkspaces;
      if (dir) saveWorkspaceHistory(recentWorkspaces);
      set((s) => ({ workspaceDir: dir, workspaceFiles: files, recentWorkspaces,
        openFile: null, fileContent: "", savedContent: "", revision: null,
        conflict: false, documentGeneration: s.documentGeneration + 1 }));
    } catch (error) {
      if (sequence === loadSequence) set({ editorError: errorMessage(error) });
      throw error;
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  },

  openWorkspaceFile: async (name) => {
    const dir = get().workspaceDir;
    if (!dir || get().saving || get().starting || get().guarding) return;
    if (name === get().openFile && !get().loading) return;
    const sequence = ++loadSequence;
    if (!await get().confirmUnsaved() || sequence !== loadSequence) return;
    set({ loading: true, editorError: null });
    try {
      const doc = await api.readWorkspaceFile(dir, name);
      if (sequence === loadSequence && get().workspaceDir === dir) {
        set((s) => ({ openFile: name, fileContent: doc.content, savedContent: doc.content,
          revision: doc.revision, eol: doc.eol, bom: doc.bom, language: inferLanguage(name),
          conflict: false, documentGeneration: s.documentGeneration + 1 }));
      }
    } catch (e) {
      if (sequence === loadSequence) set({ editorError: errorMessage(e) });
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  },

  editContent: (content) => {
    if (!get().loading && !get().starting && !get().guarding) set({ fileContent: content });
  },
  setLanguage: (language) => set({ language }),

  saveFile: async () => {
    const state = get();
    if (state.saving || state.loading) return false;
    if (!dirtyDocument(state)) return true;
    if (!state.workspaceDir || !state.openFile || !state.revision) return false;
    if (uploadBusy(state)) {
      set({ editorError: "任务正在准备、同步或停止，请稍后保存" });
      return false;
    }
    set({ saving: true, editorError: null });
    try {
      const saved = await api.writeWorkspaceFile({ dir: state.workspaceDir, name: state.openFile,
        content: state.fileContent, expectedRevision: state.revision, eol: state.eol, bom: state.bom });
      if (get().documentGeneration !== state.documentGeneration) return false;
      set({ savedContent: state.fileContent, revision: saved.revision, conflict: false });
      return true;
    } catch (error) {
      set({ editorError: errorMessage(error), conflict: typeof error === "object" && error !== null && "code" in error && error.code === "conflict" });
      return false;
    } finally {
      set({ saving: false });
    }
  },

  confirmUnsaved: async () => {
    if (get().saving || get().starting || get().guarding) return false;
    if (!dirtyDocument(get())) return true;
    // Freeze input while the choice is pending, so the approved content is stable.
    set({ guarding: true });
    try {
      const choice = await new Promise<ChangeChoice>((resolve) => set({ changePrompt: { name: get().openFile!, resolve } }));
      set({ changePrompt: null });
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      return await get().saveFile() && !dirtyDocument(get());
    } finally {
      set({ guarding: false, changePrompt: null });
    }
  },

  reloadFile: async () => {
    const state = get();
    if (!state.openFile || !state.workspaceDir || state.loading || state.saving || state.starting || state.guarding) return;
    // Reuse the same save/discard/cancel choice, preserving the buffer on read failure.
    if (!await get().confirmUnsaved()) return;
    const sequence = ++loadSequence;
    set({ loading: true, editorError: null });
    try {
      const doc = await api.readWorkspaceFile(state.workspaceDir, state.openFile);
      if (sequence === loadSequence) set((s) => ({ fileContent: doc.content, savedContent: doc.content,
        revision: doc.revision, eol: doc.eol, bom: doc.bom, conflict: false,
        documentGeneration: s.documentGeneration + 1 }));
    } catch (error) {
      if (sequence === loadSequence) set({ editorError: errorMessage(error) });
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  },

  startRun: async (request) => {
    const state = get();
    if (state.loading || state.saving || state.starting || state.guarding) throw new Error("请等待当前文件操作完成");
    if ((request.workspace_dir ?? null) !== state.workspaceDir) throw new Error("工作区已改变，请重新运行");
    if (!request.device_id || (request.kind === "command" ? !request.command?.trim() : !request.entry)) throw new Error("请选择设备并填写入口或命令");
    set({ starting: true });
    try {
      if (!await get().saveFile() || dirtyDocument(get())) throw new Error(get().editorError ?? "保存未完成，未启动任务");
      const runId = await api.runScript({ ...request, ...get().consoleSize });
      // Events may arrive before invoke returns. Fetch status only when missing;
      // use preparing as a fallback so no save slips through before the first event.
      if (!get().runs[runId]) {
        const status = await api.getRunStatus(runId).catch(() => null);
        if (!get().runs[runId]) set((s) => ({ runs: { ...s.runs, [runId]: status ?? {
          run_id: runId, device_name: "", label: request.entry ?? request.command ?? "",
          state: "preparing", exit_code: null, error: null, started_at: "", ended_at: null,
        } } }));
      }
      get().setActiveRun(runId);
      return runId;
    } finally { set({ starting: false }); }
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
