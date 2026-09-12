import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "./api";
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
      title: "选择脚本工作区目录",
      defaultPath: workspaceDir ?? recentWorkspaces[0],
    });
    if (typeof dir === "string") await setWorkspaceDir(dir);
  } catch (error) {
    useAppStore.setState({ editorError: `无法打开工作区：${errorMessage(error)}` });
  }
}
