// Manual browser fixture: all file/device APIs below are in-memory mocks.
// npm run dev -> /tests/editor-browser.html. Not included in production builds.
import React from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "../src/components/Editor";
import { WorkspacePanel } from "../src/components/WorkspacePanel";
import { RunToolbar } from "../src/components/RunToolbar";
import { RunConsole } from "../src/components/RunConsole";
import { UnsavedDialog } from "../src/components/UnsavedDialog";
import { api } from "../src/api";
import { useAppStore } from "../src/store";
import "../src/styles.css";

const files: Record<string, { content: string; revision: string }> = {
  "main.py": { content: '# 温度采集示例\nimport time\n\ndef read_temperature():\n    value = 23.5\n    print(f"温度: {value} °C")\n    return value\n\nif __name__ == "__main__":\n    read_temperature()\n', revision: "1" },
  "run.sh": { content: '#!/bin/sh\n# 测试 Shell 高亮\nNAME="runner"\nfor i in 1 2 3; do\n  echo "$NAME: $i"\ndone\ncat <<EOF\nhello\nEOF\n', revision: "1" },
  "large.py": { content: '# Long line\ntext = "' + "a".repeat(900_000) + '"\nprint(text)\n', revision: "1" },
  "notes.txt": { content: "普通 UTF-8 文本。\n", revision: "1" },
};
api.readWorkspaceFile = async (_dir, name) => ({ ...files[name], eol: "lf", bom: false });
api.listWorkspace = async () => Object.keys(files).map((name) => ({ name, is_dir: false }));
api.writeWorkspaceFile = async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (files[request.name].revision !== request.expectedRevision) throw { code: "conflict", message: "文件已被其他程序修改" };
  const revision = String(Number(request.expectedRevision) + 1);
  files[request.name] = { content: request.content, revision };
  return { revision };
};
api.runScript = async () => "fixture-run";
api.getRunStatus = async () => ({ run_id: "fixture-run", device_name: "模拟设备", label: "界面测试", state: "exited", exit_code: 0, error: null, started_at: "", ended_at: "" });
api.resizeRunConsole = async () => {};
useAppStore.setState({ workspaceDir: "/mock-workspace", recentWorkspaces: ["/mock-workspace"],
  workspaceFiles: await api.listWorkspace("/mock-workspace"), selectedDeviceId: "mock", openFile: "main.py",
  fileContent: files["main.py"].content, savedContent: files["main.py"].content, revision: "1", language: "python" });

function Fixture() {
  return <div className="app">
    <UnsavedDialog />
    <header className="app-header">编辑器交互验收（模拟文件接口，不连接设备）
      <button onClick={() => { const name = useAppStore.getState().openFile!; files[name] = { content: "# 外部修改\n", revision: String(Number(files[name].revision) + 1) }; }}>模拟外部修改</button>
      <button onClick={() => { for (let i = 0; i < 200; i++) useAppStore.getState().handleRunEvent({ type: "output", run_id: "fixture-run", stream: "stdout", data: btoa("output line\r\n".repeat(50)) }); }}>模拟大量终端输出</button>
    </header>
    <main className="app-main"><aside className="side"><WorkspacePanel /></aside><section className="center"><Editor /></section></main>
    <footer className="app-footer"><RunToolbar /><RunConsole /></footer>
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
