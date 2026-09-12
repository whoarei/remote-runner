import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorMessage } from "./api";
import { useAppStore } from "./store";
import { useTerminalStore } from "./terminalStore";

let quitting = false;

/**
 * 真正的退出路径（托盘「退出」/ 菜单「文件 → 退出」）：先把窗口带回前台，
 * 再走与窗口关闭一致的守卫——未保存确认、关闭全部终端，最后销毁窗口。
 * 窗口 X / 标题栏关闭不走这里，它们只隐藏到托盘（见 App.tsx）。
 */
export async function requestQuit(): Promise<void> {
  if (quitting) return;
  const appWindow = getCurrentWindow();
  try {
    await appWindow.show();
    await appWindow.unminimize();
    await appWindow.setFocus();
  } catch { /* 窗口操作失败不阻止退出守卫 */ }
  const state = useAppStore.getState();
  if (state.loading || state.saving || state.starting || state.guarding || state.updating) return;
  quitting = true;
  try {
    if (await state.confirmAllUnsaved()) {
      await useTerminalStore.getState().closeAll();
      await appWindow.destroy();
    }
  } catch (error) {
    useAppStore.setState({ editorError: errorMessage(error) });
  } finally {
    quitting = false;
  }
}
