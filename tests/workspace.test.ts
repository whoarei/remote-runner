import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, RunStatus } from "../src/api";
import { useAppStore } from "../src/store";
import { DEFAULT_RUN_DRAFT } from "../src/runState";
import { WorkspacePanel } from "../src/components/WorkspacePanel";
import {
  collectScripts, dropSubtree, isWithin, joinPath, nameOf, parentOf, rekeySubtree, WORKSPACE_ROOT,
} from "../src/workspaceTree";

const runStatus = (state: string): RunStatus => ({
  run_id: "run-1", device_name: "device", label: "task", state,
  exit_code: null, error: null, started_at: "", ended_at: null,
});

const treeState = () => ({
  workspaceDir: "/work",
  workspaceTree: {
    [WORKSPACE_ROOT]: { entries: [{ name: "sub", is_dir: true }, { name: "main.py", is_dir: false }], expanded: true, loaded: true },
    sub: { entries: [{ name: "inner.py", is_dir: false }], expanded: true, loaded: true },
  },
  workspaceError: null,
  workspaceMutating: false,
  openFile: null,
  fileContent: "",
  savedContent: "",
  revision: null,
  language: "text" as const,
  conflict: false,
  editorError: null,
  changePrompt: null,
  documentGeneration: 1,
  loading: false,
  saving: false,
  starting: false,
  guarding: false,
  runs: {},
  runDraft: { ...DEFAULT_RUN_DRAFT },
});

test("workspace path helpers keep relative paths and subtree relations", () => {
  assert.equal(joinPath(WORKSPACE_ROOT, "main.py"), "main.py");
  assert.equal(joinPath("sub", "inner.py"), "sub/inner.py");
  assert.equal(parentOf("sub/inner.py"), "sub");
  assert.equal(parentOf("main.py"), WORKSPACE_ROOT);
  assert.equal(nameOf("sub/inner.py"), "inner.py");
  assert.ok(isWithin("sub", "sub"));
  assert.ok(isWithin("sub/inner.py", "sub"));
  assert.ok(isWithin("main.py", WORKSPACE_ROOT));
  assert.ok(!isWithin("subway/x.py", "sub"));
  assert.ok(isWithin(WORKSPACE_ROOT, WORKSPACE_ROOT));

  const tree = {
    [WORKSPACE_ROOT]: { entries: [], expanded: true, loaded: true },
    sub: { entries: [], expanded: true, loaded: true },
    other: { entries: [], expanded: false, loaded: true },
  };
  const rekeyed = rekeySubtree(tree, "sub", "renamed");
  assert.deepEqual(Object.keys(rekeyed).sort(), ["", "other", "renamed"]);
  assert.equal(rekeyed.renamed.expanded, true);
  assert.deepEqual(Object.keys(dropSubtree(tree, "sub")).sort(), ["", "other"]);

  assert.deepEqual(collectScripts({
    [WORKSPACE_ROOT]: {
      entries: [{ name: "b.sh", is_dir: false }, { name: "a.py", is_dir: false },
        { name: "notes.txt", is_dir: false }, { name: "sub", is_dir: true }],
      expanded: true, loaded: true,
    },
    sub: { entries: [{ name: "deep.py", is_dir: false }], expanded: true, loaded: true },
  }), ["a.py", "b.sh", "sub/deep.py"]);
});

test("workspace panel renders the tree with expansion state and an empty hint", (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  useAppStore.setState({ ...treeState(), openFile: "sub/inner.py" });
  const html = renderToStaticMarkup(createElement(WorkspacePanel, { collapsed: false, onToggleCollapse: () => {} }));
  assert.match(html, />sub</);
  assert.match(html, /inner\.py/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /class="active"/);
  // 折叠时只渲染标题，未打开工作区时显示提示而不是空白
  const collapsed = renderToStaticMarkup(createElement(WorkspacePanel, { collapsed: true, onToggleCollapse: () => {} }));
  assert.doesNotMatch(collapsed, /inner\.py/);
  useAppStore.setState({ workspaceDir: null, workspaceTree: {} });
  assert.match(renderToStaticMarkup(createElement(WorkspacePanel, { collapsed: false, onToggleCollapse: () => {} })),
    /尚未选择工作区目录/);
});

test("opening a workspace loads the root and expanding a directory loads it once", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(console, "warn", () => {});
  const listed: string[] = [];
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) => {
    listed.push(subdir);
    return subdir === WORKSPACE_ROOT
      ? [{ name: "sub", is_dir: true }, { name: "main.py", is_dir: false }]
      : [{ name: "deep.py", is_dir: false }];
  });
  await useAppStore.getState().setWorkspaceDir("/work");
  assert.deepEqual(listed, [""]);
  assert.deepEqual(useAppStore.getState().workspaceTree[""].entries.map((e) => e.name), ["sub", "main.py"]);

  await useAppStore.getState().toggleWorkspaceDir("sub");
  assert.deepEqual(listed, ["", "sub"]);
  assert.equal(useAppStore.getState().workspaceTree.sub.expanded, true);
  assert.deepEqual(useAppStore.getState().workspaceTree.sub.entries.map((e) => e.name), ["deep.py"]);

  // 折叠再展开复用已加载内容，不重复读取
  await useAppStore.getState().toggleWorkspaceDir("sub");
  assert.equal(useAppStore.getState().workspaceTree.sub.expanded, false);
  await useAppStore.getState().toggleWorkspaceDir("sub");
  assert.deepEqual(listed, ["", "sub"]);
  assert.equal(useAppStore.getState().workspaceTree.sub.expanded, true);
});

test("create refreshes the parent directory and surfaces backend errors", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState(treeState());
  const created: string[][] = [];
  t.mock.method(api, "createWorkspaceEntry", async (_dir: string, name: string, kind: string) => {
    created.push([_dir, name, kind]);
  });
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) =>
    subdir === "sub" ? [{ name: "new.py", is_dir: false }] : []);

  assert.equal(await useAppStore.getState().createWorkspaceEntry("sub", "new.py", "file"), true);
  assert.deepEqual(created, [["/work", "sub/new.py", "file"]]);
  const node = useAppStore.getState().workspaceTree.sub;
  assert.equal(node.expanded, true);
  assert.deepEqual(node.entries.map((e) => e.name), ["new.py"]);
  assert.equal(useAppStore.getState().workspaceMutating, false);

  t.mock.method(api, "createWorkspaceEntry", async () => { throw { code: "exists", message: "同名文件或目录已存在" }; });
  assert.equal(await useAppStore.getState().createWorkspaceEntry("sub", "new.py", "file"), false);
  assert.equal(useAppStore.getState().workspaceError, "同名文件或目录已存在");
  assert.equal(useAppStore.getState().workspaceMutating, false);
  assert.equal(created.length, 1);

  useAppStore.getState().dismissWorkspaceError();
  assert.equal(useAppStore.getState().workspaceError, null);
});

test("workspace changes are refused while a run is preparing, syncing, or stopping", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ ...treeState(), runs: { "run-1": runStatus("syncing") } });
  let calls = 0;
  t.mock.method(api, "createWorkspaceEntry", async () => { calls++; });
  t.mock.method(api, "renameWorkspaceEntry", async () => { calls++; });
  t.mock.method(api, "deleteWorkspaceEntry", async () => { calls++; });
  const state = useAppStore.getState();
  assert.equal(await state.createWorkspaceEntry(WORKSPACE_ROOT, "new.py", "file"), false);
  assert.equal(await state.renameWorkspaceEntry("main.py", "other.py"), false);
  assert.equal(await state.deleteWorkspaceEntry("main.py"), false);
  assert.equal(calls, 0);
  assert.equal(useAppStore.getState().workspaceError, "任务正在准备、同步或停止，请稍后修改工作区");
  assert.equal(useAppStore.getState().workspaceMutating, false);
});

test("rename moves the open document, entry draft, and cached subtree", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({
    ...treeState(), openFile: "sub/inner.py", fileContent: "print(1)", savedContent: "print(1)",
    revision: "v1", language: "python", runDraft: { ...DEFAULT_RUN_DRAFT, entry: "sub/inner.py" },
  });
  const renamed: string[][] = [];
  t.mock.method(api, "renameWorkspaceEntry", async (_dir: string, oldName: string, newName: string) => {
    renamed.push([oldName, newName]);
  });
  t.mock.method(api, "listWorkspaceDir", async () => []);

  assert.equal(await useAppStore.getState().renameWorkspaceEntry("sub", "scripts"), true);
  assert.deepEqual(renamed, [["sub", "scripts"]]);
  const state = useAppStore.getState();
  assert.equal(state.openFile, "scripts/inner.py");
  assert.equal(state.runDraft.entry, "scripts/inner.py");
  assert.equal(state.workspaceTree.scripts.expanded, true);
  assert.equal(state.workspaceTree.sub, undefined);
  // 内容未变：不重挂载编辑器，也不清空缓冲区
  assert.equal(state.documentGeneration, 1);
  assert.equal(state.fileContent, "print(1)");

  await useAppStore.getState().renameWorkspaceEntry("scripts/inner.py", "inner.sh");
  assert.equal(useAppStore.getState().openFile, "scripts/inner.sh");
  assert.equal(useAppStore.getState().language, "shell");
  // 同名重命名是空操作，不访问后端
  assert.equal(await useAppStore.getState().renameWorkspaceEntry("main.py", "main.py"), true);
  assert.equal(renamed.length, 2);
});

test("delete confirms unsaved changes, then closes the editor and drops cached subtree", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({
    ...treeState(), openFile: "sub/inner.py", fileContent: "edits", savedContent: "saved",
    revision: "v1", documentGeneration: 3, runDraft: { ...DEFAULT_RUN_DRAFT, entry: "sub/inner.py" },
  });
  const deleted: string[] = [];
  t.mock.method(api, "deleteWorkspaceEntry", async (_dir: string, name: string) => { deleted.push(name); });
  t.mock.method(api, "listWorkspaceDir", async () => []);

  const canceled = useAppStore.getState().deleteWorkspaceEntry("sub");
  assert.ok(useAppStore.getState().changePrompt, "包含未保存修改时必须先确认");
  useAppStore.getState().changePrompt!.resolve("cancel");
  await canceled;
  assert.deepEqual(deleted, []);
  assert.equal(useAppStore.getState().openFile, "sub/inner.py");
  assert.equal(useAppStore.getState().fileContent, "edits");
  assert.equal(useAppStore.getState().guarding, false);

  const confirmed = useAppStore.getState().deleteWorkspaceEntry("sub");
  useAppStore.getState().changePrompt!.resolve("discard");
  assert.equal(await confirmed, true);
  assert.deepEqual(deleted, ["sub"]);
  const state = useAppStore.getState();
  assert.equal(state.openFile, null);
  assert.equal(state.fileContent, "");
  assert.equal(state.revision, null);
  assert.equal(state.documentGeneration, 4);
  assert.equal(state.runDraft.entry, "");
  assert.equal(state.workspaceTree.sub, undefined);
  assert.equal(state.workspaceMutating, false);

  // 与打开文件无关的删除不需要确认，但会清掉指向被删文件的入口草稿
  useAppStore.setState({ runDraft: { ...DEFAULT_RUN_DRAFT, entry: "main.py" } });
  assert.equal(await useAppStore.getState().deleteWorkspaceEntry("main.py"), true);
  assert.deepEqual(deleted, ["sub", "main.py"]);
  assert.equal(useAppStore.getState().changePrompt, null);
  assert.equal(useAppStore.getState().runDraft.entry, "");
});

test("a workspace switch discards in-flight directory loads and mutations", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(console, "warn", () => {});
  useAppStore.setState(treeState());
  let finishCreate!: () => void;
  t.mock.method(api, "createWorkspaceEntry", () => new Promise<void>((resolve) => { finishCreate = resolve; }));
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) =>
    subdir === WORKSPACE_ROOT ? [{ name: "other.py", is_dir: false }] : []);

  const creating = useAppStore.getState().createWorkspaceEntry("sub", "late.py", "file");
  assert.equal(useAppStore.getState().workspaceMutating, true);
  const switching = useAppStore.getState().setWorkspaceDir("/elsewhere");
  finishCreate();
  await creating;
  await switching;
  const state = useAppStore.getState();
  assert.equal(state.workspaceDir, "/elsewhere");
  assert.deepEqual(state.workspaceTree[""].entries.map((e) => e.name), ["other.py"]);
  assert.equal(state.workspaceTree.sub, undefined);
  assert.equal(state.workspaceMutating, false);
});
