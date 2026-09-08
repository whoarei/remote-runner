import { useAppStore } from "../store";

/**
 * 脚本编辑器（V1 用等宽 textarea 实现，Monaco 接入见实施文档 TODO）
 * 注意：当前为只读预览；保存写回本地文件属于后续工作项。
 */
export function Editor() {
  const { openFile, fileContent } = useAppStore();

  if (!openFile) {
    return (
      <div className="editor empty">
        在左侧 Workspace 中选择脚本文件，或直接用下方命令模式运行。
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor-title">{openFile}</div>
      <textarea
        className="editor-textarea"
        value={fileContent}
        readOnly
        spellCheck={false}
      />
    </div>
  );
}
