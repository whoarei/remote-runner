import { save } from "@tauri-apps/plugin-dialog";
import { api, RunStatus } from "./api";

function timestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown-time";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 默认导出文件名：清洗 Windows 非法字符，附启动时间戳 */
export function defaultExportName(status: RunStatus, ext: string): string {
  const label = status.label.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "run";
  return `${label}-${timestamp(status.started_at)}.${ext}`;
}

/** 输出日志可导出：已持久化的输出字节数大于 0（旧会话条目为 0） */
export function canExportOutput(status: RunStatus): boolean {
  return (status.output_bytes ?? 0) > 0;
}

export function buildRecordJson(status: RunStatus): string {
  return JSON.stringify(status, null, 2) + "\n";
}

/** 导出元数据 JSON；用户取消保存对话框时静默结束 */
export async function exportRecord(status: RunStatus): Promise<void> {
  const path = await save({
    defaultPath: defaultExportName(status, "json"),
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;
  await api.exportRunRecord(path, buildRecordJson(status));
}

/** 导出输出日志；返回截断提示（无截断或用户取消时为 null） */
export async function exportOutput(status: RunStatus): Promise<string | null> {
  const path = await save({
    defaultPath: defaultExportName(status, "log"),
    filters: [{ name: "Log", extensions: ["log", "txt"] }],
  });
  if (!path) return null;
  await api.exportRunOutput(status.run_id, path);
  return status.output_truncated ? "输出超过 2 MiB，导出的日志仅为开头部分" : null;
}
