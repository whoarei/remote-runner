/** 一键更新编排（Tauri 耦合）：标题栏「更新」按钮与关于对话框共用的安装流程。 */
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type AppUpdateInfo } from "./api";
import { useAppStore } from "./store";
import { useTerminalStore, terminalActive } from "./terminalStore";
import {
  directUpdateAction,
  installWithProgress,
  updateInstallBlocker,
  type UpdateButtonPhase,
  type UpdateProgress,
} from "./updateStatus";

/** 安装已固定（checked）的更新。成功时 Windows 进程退出，返回即视为异常。 */
export async function installCheckedUpdate(
  info: AppUpdateInfo,
  onPhase: (phase: UpdateButtonPhase) => void,
): Promise<void> {
  useAppStore.setState({ updating: true });
  onPhase({ kind: "downloading", downloaded: 0, total: null });
  try {
    await installWithProgress(info.latest_version,
      () => listen<UpdateProgress>("app-update://progress", ({ payload }) => {
        if (payload.phase === "verifying" || payload.phase === "installing") onPhase({ kind: payload.phase });
        else onPhase({ kind: "downloading", downloaded: payload.downloaded, total: payload.total });
      }), api.installAppUpdate);
    // On Windows a successful install command exits the process. Returning is unexpected.
    throw new Error("安装程序未接管应用，请重试或手动下载更新");
  } finally {
    useAppStore.setState({ updating: false });
  }
}

function installBlocker(): string | null {
  return updateInstallBlocker(useAppStore.getState())
    || (useTerminalStore.getState().tabs.some(terminalActive) ? "请先关闭活动终端，再安装更新。" : null);
}

let oneClickRunning = false;

/** 标题栏「更新」按钮：受阻提示原因，便携版打开下载页，否则重新固定后直接安装。 */
export async function startOneClickUpdate(
  info: AppUpdateInfo,
  onPhase: (phase: UpdateButtonPhase | null) => void,
): Promise<void> {
  if (oneClickRunning) return;
  const action = directUpdateAction(info, installBlocker());
  if (action.kind === "blocked") {
    useAppStore.setState({ editorError: action.reason });
    return;
  }
  if (action.kind === "manual") {
    try { await openUrl(action.url); }
    catch (error) { useAppStore.setState({ editorError: `无法打开浏览器：${errorMessage(error)}` }); }
    return;
  }
  oneClickRunning = true;
  onPhase({ kind: "checking" });
  try {
    // Re-pin the exact metadata so install never depends on a stale startup check.
    const fresh = await api.checkAppUpdate();
    if (!fresh) {
      useAppStore.setState({ availableUpdate: null, editorError: "已是最新版本。" });
      return;
    }
    useAppStore.setState({ availableUpdate: fresh });
    await installCheckedUpdate(fresh, onPhase);
  } catch (error) {
    useAppStore.setState({ editorError: `自动升级失败，可在「帮助 → 检查更新…」中手动下载：${errorMessage(error)}` });
  } finally {
    oneClickRunning = false;
    onPhase(null);
  }
}
