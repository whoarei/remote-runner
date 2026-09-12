import { create } from "zustand";
import { api, DeviceProfile, RunEvent, RunStatus, RunRequest, WorkspaceEntryKind, errorMessage, AppUpdateInfo } from "./api";
import { ChangeChoice, dirtyDocument, EditorLanguage, inferLanguage, uploadBusy } from "./editorDocument";
import { appendOutput, MAX_TOTAL_OUTPUT_BYTES, OutputBuffer, trimOutput } from "./outputBuffer";
import { DEFAULT_RUN_DRAFT, isActiveRun, newestStatus, RunDraft } from "./runState";
import { loadWorkspaceHistory, rememberWorkspace, saveWorkspaceHistory } from "./workspaceHistory";
import { DEFAULT_LAYOUT, LayoutState, loadLayout, normalizeLayout, saveLayout } from "./layoutState";
import { collectScripts, dropSubtree, isWithin, joinPath, nameOf, parentOf, rekeySubtree, rootTree, withNode, WORKSPACE_ROOT, WorkspacePath, WorkspaceTree } from "./workspaceTree";

interface AppState {
  updating: boolean;
  /** 启动时静默检查发现的可用更新（驱动标题栏「更新」按钮） */
  availableUpdate: AppUpdateInfo | null;
  devices: DeviceProfile[];
  selectedDeviceId: string | null;
  /** 正在添加 / 编辑的设备（驱动设备对话框）；null 表示对话框关闭 */
  editingDevice: DeviceProfile | null;

  workspaceDir: string | null;
  recentWorkspaces: string[];
  /** 目录树缓存：键为相对目录路径，"" 为工作区根 */
  workspaceTree: WorkspaceTree;
  workspaceError: string | null;
  workspaceMutating: boolean;
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
  runDraft: RunDraft;
  setRunDraft: (patch: Partial<RunDraft>) => void;

  layout: LayoutState;
  setLayout: (patch: Partial<LayoutState>) => void;
  resetLayout: () => void;

  loadDevices: () => Promise<void>;
  selectDevice: (id: string | null) => void;
  /** 打开设备对话框：传入空模板表示添加新设备，传入已有设备表示编辑 */
  openDeviceDialog: (device: DeviceProfile) => void;
  closeDeviceDialog: () => void;
  setWorkspaceDir: (dir: string | null) => Promise<void>;
  loadWorkspaceDir: (dir: WorkspacePath) => Promise<void>;
  toggleWorkspaceDir: (dir: WorkspacePath) => Promise<void>;
  createWorkspaceEntry: (dir: WorkspacePath, name: string, kind: WorkspaceEntryKind) => Promise<boolean>;
  renameWorkspaceEntry: (path: WorkspacePath, newName: string) => Promise<boolean>;
  deleteWorkspaceEntry: (path: WorkspacePath) => Promise<boolean>;
  dismissWorkspaceError: () => void;
  openWorkspaceFile: (name: string) => Promise<void>;
  editContent: (content: string) => void;
  setLanguage: (language: EditorLanguage) => void;
  saveFile: () => Promise<boolean>;
  confirmUnsaved: () => Promise<boolean>;
  reloadFile: () => Promise<void>;
  startRun: (request: RunRequest) => Promise<string>;
  handleRunEvent: (ev: RunEvent) => void;
  handleRunEvents: (events: RunEvent[]) => void;
  loadRuns: () => Promise<void>;
  setActiveRun: (id: string | null) => void;
  setConsoleSize: (cols: number, rows: number) => void;
  loadHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
}

let loadSequence = 0;
/** 工作区被替换后作废仍在进行的目录加载与变更响应 */
let workspaceSequence = 0;

/** 工作区变更（新建 / 重命名 / 删除）的前置检查，返回可见提示或 null */
function workspaceChangeBlocker(
  state: Pick<AppState, "workspaceDir" | "workspaceMutating" | "saving" | "starting" | "guarding" | "runs">,
): string | null {
  if (!state.workspaceDir) return "请先选择工作区";
  if (state.workspaceMutating || state.saving || state.starting || state.guarding) return "请等待当前操作完成";
  if (uploadBusy(state)) return "任务正在准备、同步或停止，请稍后修改工作区";
  return null;
}

/** Retain live runs and the selected history entry; bound output across all runs. */
function pruneRuns(state: Pick<AppState, "runs" | "history" | "outputBuffers" | "activeRunId">, pending: string[] = []) {
  const keep = new Set(state.history.map((h) => h.run_id));
  pending.slice(-32).forEach((id) => keep.add(id));
  Object.values(state.runs).filter(isActiveRun).forEach((r) => keep.add(r.run_id));
  if (state.activeRunId) keep.add(state.activeRunId);
  const entries = Object.entries(state.runs).filter(([id]) => keep.has(id));
  const runs = entries.length === Object.keys(state.runs).length ? state.runs : Object.fromEntries(entries);
  const outputBuffers = Object.fromEntries(Object.entries(state.outputBuffers).filter(([id]) => keep.has(id)));
  let excess = Object.values(outputBuffers).reduce((sum, b) => sum + b.bytes, 0) - MAX_TOTAL_OUTPUT_BYTES;
  // Old completed runs are trimmed first, then live runs, with the selected run last.
  const ids = Object.keys(outputBuffers).sort((a, b) =>
    Number(a === state.activeRunId) - Number(b === state.activeRunId) ||
    Number(!!runs[a] && isActiveRun(runs[a])) - Number(!!runs[b] && isActiveRun(runs[b])));
  for (const id of ids) {
    if (excess <= 0) break;
    const old = outputBuffers[id];
    outputBuffers[id] = trimOutput(old, Math.max(0, old.bytes - excess));
    excess -= old.bytes - outputBuffers[id].bytes;
  }
  return { runs, outputBuffers };
}

export const useAppStore = create<AppState>((set, get) => ({
  updating: false,
  availableUpdate: null,
  devices: [],
  selectedDeviceId: null,
  editingDevice: null,

  workspaceDir: null,
  recentWorkspaces: loadWorkspaceHistory(),
  workspaceTree: {},
  workspaceError: null,
  workspaceMutating: false,
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
  runDraft: { ...DEFAULT_RUN_DRAFT },
  setRunDraft: (patch) => set((s) => ({ runDraft: { ...s.runDraft, ...patch } })),

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

  openDeviceDialog: (device) => set({ editingDevice: device }),
  closeDeviceDialog: () => set({ editingDevice: null }),

  setWorkspaceDir: async (dir) => {
    if (get().saving || get().starting || get().guarding) return;
    const sequence = ++loadSequence;
    ++workspaceSequence;
    // This selection owns loading cleanup as soon as it invalidates the old read.
    set({ loading: false });
    if (!await get().confirmUnsaved() || sequence !== loadSequence) return;
    set({ loading: true, editorError: null, workspaceError: null });
    try {
      const workspaceTree = dir ? rootTree(await api.listWorkspaceDir(dir, WORKSPACE_ROOT)) : {};
      if (sequence !== loadSequence) return;
      const recentWorkspaces = dir ? rememberWorkspace(get().recentWorkspaces, dir) : get().recentWorkspaces;
      if (dir) saveWorkspaceHistory(recentWorkspaces);
      set((s) => ({ workspaceDir: dir, workspaceTree, recentWorkspaces,
        openFile: null, fileContent: "", savedContent: "", revision: null,
        conflict: false, documentGeneration: s.documentGeneration + 1,
        runDraft: { ...s.runDraft, entry: "" } }));
    } catch (error) {
      if (sequence === loadSequence) set({ editorError: errorMessage(error) });
      throw error;
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  },

  loadWorkspaceDir: async (dir) => {
    const root = get().workspaceDir;
    if (!root) return;
    const sequence = workspaceSequence;
    try {
      const entries = await api.listWorkspaceDir(root, dir);
      if (sequence !== workspaceSequence || get().workspaceDir !== root) return;
      set((s) => ({ workspaceTree: withNode(s.workspaceTree, dir, (node) =>
        ({ entries, expanded: node?.expanded ?? false, loaded: true })) }));
    } catch (error) {
      if (sequence === workspaceSequence && get().workspaceDir === root) set({ workspaceError: errorMessage(error) });
    }
  },

  toggleWorkspaceDir: async (dir) => {
    const node = get().workspaceTree[dir];
    // 从未展开过的目录还没有缓存节点，首次展开时建立并按需加载
    const expanded = !node?.expanded;
    set((s) => ({ workspaceTree: withNode(s.workspaceTree, dir, (current) =>
      ({ entries: current?.entries ?? [], expanded, loaded: current?.loaded ?? false })) }));
    if (expanded && !node?.loaded) await get().loadWorkspaceDir(dir);
  },

  createWorkspaceEntry: async (dir, name, kind) => {
    const state = get();
    const blocked = workspaceChangeBlocker(state);
    if (blocked) { set({ workspaceError: blocked }); return false; }
    const root = state.workspaceDir!;
    const sequence = workspaceSequence;
    set({ workspaceMutating: true, workspaceError: null });
    try {
      await api.createWorkspaceEntry(root, joinPath(dir, name), kind);
      if (sequence !== workspaceSequence) return false;
      // 展开父目录，让新条目立刻可见
      set((s) => ({ workspaceTree: withNode(s.workspaceTree, dir, (node) =>
        ({ entries: node?.entries ?? [], expanded: true, loaded: node?.loaded ?? false })) }));
      await get().loadWorkspaceDir(dir);
      return true;
    } catch (error) {
      if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      return false;
    } finally {
      set({ workspaceMutating: false });
    }
  },

  renameWorkspaceEntry: async (path, newName) => {
    const state = get();
    const blocked = workspaceChangeBlocker(state);
    if (blocked) { set({ workspaceError: blocked }); return false; }
    const root = state.workspaceDir!;
    const dir = parentOf(path);
    const target = joinPath(dir, newName);
    if (target === path) return true;
    const sequence = workspaceSequence;
    set({ workspaceMutating: true, workspaceError: null });
    try {
      await api.renameWorkspaceEntry(root, path, target);
      if (sequence !== workspaceSequence) return false;
      // 同一个条目换了路径：缓存子树改键，打开的文档与入口草稿跟随移动
      set((s) => {
        const moved = (value: string | null) =>
          value && isWithin(value, path) ? target + value.slice(path.length) : value;
        const openFile = moved(s.openFile);
        return { workspaceTree: rekeySubtree(s.workspaceTree, path, target), openFile,
          language: openFile && openFile !== s.openFile ? inferLanguage(nameOf(openFile)) : s.language,
          runDraft: { ...s.runDraft, entry: moved(s.runDraft.entry) ?? "" } };
      });
      await get().loadWorkspaceDir(dir);
      return true;
    } catch (error) {
      if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      return false;
    } finally {
      set({ workspaceMutating: false });
    }
  },

  deleteWorkspaceEntry: async (path) => {
    const state = get();
    const blocked = workspaceChangeBlocker(state);
    if (blocked) { set({ workspaceError: blocked }); return false; }
    const root = state.workspaceDir!;
    const dir = parentOf(path);
    // 删除会连带丢掉未保存修改，先复用既有的保存 / 放弃 / 取消确认
    if (state.openFile && isWithin(state.openFile, path) && !await get().confirmUnsaved()) return false;
    const sequence = workspaceSequence;
    set({ workspaceMutating: true, workspaceError: null });
    try {
      await api.deleteWorkspaceEntry(root, path);
      if (sequence !== workspaceSequence) return false;
      set((s) => {
        const closed = !!s.openFile && isWithin(s.openFile, path);
        // 入口草稿无论是否打开都要跟随删除，否则下拉框会指向已删除的文件
        const entry = s.runDraft.entry && isWithin(s.runDraft.entry, path) ? "" : s.runDraft.entry;
        const runDraft = entry === s.runDraft.entry ? s.runDraft : { ...s.runDraft, entry };
        return { workspaceTree: dropSubtree(s.workspaceTree, path), runDraft,
          ...(closed ? { openFile: null, fileContent: "", savedContent: "", revision: null,
            conflict: false, documentGeneration: s.documentGeneration + 1 } : {}) };
      });
      await get().loadWorkspaceDir(dir);
      return true;
    } catch (error) {
      if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      return false;
    } finally {
      set({ workspaceMutating: false });
    }
  },

  dismissWorkspaceError: () => set({ workspaceError: null }),

  openWorkspaceFile: async (name) => {
    const dir = get().workspaceDir;
    if (!dir || get().saving || get().starting || get().guarding) return;
    if (name === get().openFile && !get().loading) return;
    const sequence = ++loadSequence;
    set({ loading: false });
    if (!await get().confirmUnsaved() || sequence !== loadSequence) return;
    set({ loading: true, editorError: null });
    try {
      const doc = await api.readWorkspaceFile(dir, name);
      if (sequence === loadSequence && get().workspaceDir === dir) {
        set((s) => ({ openFile: name, fileContent: doc.content, savedContent: doc.content,
          revision: doc.revision, eol: doc.eol, bom: doc.bom, language: inferLanguage(name),
          conflict: false, documentGeneration: s.documentGeneration + 1 }));
        // 打开文件意味着要看内容，折叠中的编辑区自动展开
        if (get().layout.editorCollapsed) get().setLayout({ editorCollapsed: false });
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
    if (state.updating) throw new Error("正在升级，请等待应用重新启动");
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

  handleRunEvent: (ev) => get().handleRunEvents([ev]),

  handleRunEvents: (events) => {
    if (!events.length) return;
    set((s) => {
      let runs = s.runs;
      let history = s.history;
      let outputBuffers = { ...s.outputBuffers };
      for (const ev of events) {
        if (ev.type === "output") {
          const bytes = Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0));
          outputBuffers[ev.run_id] = appendOutput(outputBuffers[ev.run_id], bytes);
        } else if (ev.type === "resync") {
          runs = Object.fromEntries(ev.statuses.map((r) => [r.run_id, r]));
          history = ev.statuses.filter((r) => !isActiveRun(r)).slice(0, 200);
          // Do not concatenate bytes across a missing interval (including UTF-8/ANSI).
          for (const id of new Set([...Object.keys(outputBuffers), ...Object.keys(runs)])) {
            const buffer = outputBuffers[id] ?? { chunks: [], bytes: 0, start: 0 };
            outputBuffers[id] = { chunks: [], bytes: 0, start: buffer.start + buffer.chunks.length, gaps: (buffer.gaps ?? 0) + 1 };
          }
        } else {
          const status = newestStatus(runs[ev.status.run_id], ev.status);
          runs = { ...runs, [status.run_id]: status };
          if (!isActiveRun(status)) history = [status, ...history.filter((h) => h.run_id !== status.run_id)].slice(0, 200);
        }
      }
      // Output can precede its first status in tests or after a late attachment.
      // Keep those buffers until reconciliation, but still enforce the total budget.
      const pending = Object.keys(outputBuffers).filter((id) => !runs[id]);
      const retained = pruneRuns({ runs, history, outputBuffers, activeRunId: s.activeRunId }, pending);
      return { ...retained, history, consoleSeq: s.consoleSeq + 1 };
    });
  },

  setActiveRun: (id) => set((s) => ({ activeRunId: id, ...pruneRuns({ ...s, activeRunId: id }), consoleSeq: s.consoleSeq + 1 })),
  setConsoleSize: (cols, rows) => set({ consoleSize: { cols, rows } }),

  loadHistory: async () => {
    await get().loadRuns();
  },
  clearHistory: async () => {
    await api.clearRunHistory();
    set((s) => {
      const history: RunStatus[] = [];
      // 保留运行中的任务与当前选中回看的输出缓冲，其余随历史一起清理
      return { ...pruneRuns({ ...s, history }), history, consoleSeq: s.consoleSeq + 1 };
    });
  },
  loadRuns: async () => {
    const before = get().runs;
    const [live, saved] = await Promise.all([api.listRunningRuns(), api.getRunHistory()]);
    set((s) => {
      const runs = { ...Object.fromEntries([...saved, ...live].map((r) => [r.run_id, r])) };
      // Preserve events delivered while this snapshot was being fetched.
      for (const [id, run] of Object.entries(s.runs)) if (run !== before[id]) runs[id] = newestStatus(runs[id], run);
      const history = Object.values(runs).filter((r) => !isActiveRun(r)).sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? "")).slice(0, 200);
      const activeRunId = s.activeRunId ?? live.find(isActiveRun)?.run_id ?? null;
      return { ...pruneRuns({ ...s, runs, history, activeRunId }), history, activeRunId };
    });
  },
}));
