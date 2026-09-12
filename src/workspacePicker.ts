import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "./api";
import i18n from "./i18n";
import { useAppStore } from "./store";

/**
 * 选择并打开工作区目录。传入 recentDir 时直接打开该目录，
 * 否则弹出目录选择对话框。错误写入 editorError。
 */
export async function openWorkspace(recentDir?: string): Promise<void> {
  try {
    const { workspaceDir, recentWorkspaces, setWorkspaceDir } = useAppStore.getState();
    const dir = recentDir ?? await open({
      directory: true,
      title: i18n.t("workspace.pickDirTitle"),
      defaultPath: workspaceDir ?? recentWorkspaces[0],
    });
    if (typeof dir === "string") await setWorkspaceDir(dir);
  } catch (error) {
    useAppStore.setState({ editorError: i18n.t("workspace.openFailed", { message: errorMessage(error) }) });
  }
}
