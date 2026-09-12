import { create } from "zustand";
import { api, errorMessage, type TerminalStatus } from "./api";

export interface TerminalTab {
  id: string;
  deviceId: string;
  deviceName: string;
  status?: TerminalStatus;
  busy: boolean;
  error?: string;
}

export const terminalActive = (tab: TerminalTab) => tab.busy || !!tab.status &&
  ["connecting", "connected", "closing"].includes(tab.status.state);

const pending = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  void work.finally(() => pending.delete(work)).catch(() => {});
  return work;
}

interface TerminalStore {
  tabs: TerminalTab[];
  activeTab: string;
  shuttingDown: boolean;
  select: (id: string) => void;
  open: (deviceId: string, deviceName: string) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  closeAll: () => Promise<void>;
  update: (id: string, sessionId: string, status: TerminalStatus) => void;
  report: (id: string, sessionId: string, error: unknown) => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => {
  const patch = (id: string, value: Partial<TerminalTab>) => set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, ...value } : tab) }));
  return {
    tabs: [], activeTab: "run", shuttingDown: false,
    select: (id) => { if (id === "run" || get().tabs.some((t) => t.id === id)) set({ activeTab: id }); },
    open: (deviceId, deviceName) => {
      if (get().shuttingDown) return Promise.reject(new Error("正在关闭终端"));
      if (get().tabs.length >= 8) return Promise.reject(new Error("最多打开 8 个终端，请先关闭一个标签"));
      const id = crypto.randomUUID();
      set((s) => ({ tabs: [...s.tabs, { id, deviceId, deviceName, busy: true }], activeTab: id }));
      return track((async () => {
        try { patch(id, { status: await api.openTerminal(deviceId), busy: false }); }
        catch (error) { patch(id, { busy: false, error: errorMessage(error) }); }
      })());
    },
    reconnect: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.busy || get().shuttingDown || terminalActive(tab)) return Promise.resolve();
      patch(id, { busy: true, error: undefined });
      return track((async () => {
        try {
          if (tab.status) await api.closeTerminal(tab.status.session_id);
          patch(id, { status: undefined });
          patch(id, { status: await api.openTerminal(tab.deviceId), busy: false });
        } catch (error) { patch(id, { busy: false, error: errorMessage(error) }); }
      })());
    },
    close: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.busy) return Promise.resolve();
      patch(id, { busy: true, error: undefined });
      return track((async () => {
        try {
          if (tab.status) await api.closeTerminal(tab.status.session_id);
          set((s) => ({ tabs: s.tabs.filter((t) => t.id !== id), activeTab: s.activeTab === id ? "run" : s.activeTab }));
        } catch (error) { patch(id, { busy: false, error: errorMessage(error) }); }
      })());
    },
    closeAll: async () => {
      set({ shuttingDown: true });
      try {
        await Promise.allSettled([...pending]);
        await api.closeAllTerminals();
        set({ tabs: [], activeTab: "run" });
      } finally { set({ shuttingDown: false }); }
    },
    update: (id, sessionId, status) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab?.status?.session_id === sessionId) patch(id, { status });
    },
    report: (id, sessionId, error) => {
      if (get().tabs.find((t) => t.id === id)?.status?.session_id === sessionId) patch(id, { error: errorMessage(error) });
    },
  };
});
