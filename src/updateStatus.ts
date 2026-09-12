/** 升级流程的纯展示辅助（无 Tauri 依赖，便于单元测试）。 */
import { dirtyDocument } from "./editorDocument";

export interface UpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  downloaded: number;
  total: number | null;
}

export function updateInstallBlocker(state: {
  openFile: string | null; fileContent: string; savedContent: string;
  loading: boolean; saving: boolean; starting: boolean; guarding: boolean; workspaceMutating: boolean;
  runs: Record<string, { state: string }>;
}): string | null {
  if (state.loading || state.saving || state.starting || state.guarding || state.workspaceMutating) return "请等待当前文件或任务操作完成。";
  if (dirtyDocument(state)) return "请先保存编辑器中的修改，再安装更新。";
  if (Object.values(state.runs).some((run) => ["preparing", "syncing", "running", "stopping"].includes(run.state))) return "请先停止或等待所有运行任务结束，再安装更新。";
  return null;
}

/** Subscribe before invoke; clean up on success and every failure, including listener setup. */
export async function installWithProgress(
  version: string,
  subscribe: () => Promise<() => void>,
  install: (version: string) => Promise<void>,
): Promise<void> {
  const unlisten = await subscribe();
  try { await install(version); }
  finally { unlisten(); }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** 下载进度文案；total 未知时只显示已下载体积。 */
export function formatDownloadProgress(downloaded: number, total: number | null): string {
  if (total === null || total <= 0) return `已下载 ${formatBytes(downloaded)}`;
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return `已下载 ${formatBytes(downloaded)} / ${formatBytes(total)}（${percent}%）`;
}
