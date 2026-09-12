import test from "node:test";
import assert from "node:assert/strict";
import { appendOutput, MAX_OUTPUT_BYTES } from "../src/outputBuffer";
import { useAppStore } from "../src/store";
import { api } from "../src/api";
import { loadWorkspaceHistory } from "../src/workspaceHistory";
import { dirtyDocument, inferLanguage } from "../src/editorDocument";

test("output buffers stay bounded and retain an absolute replay position", () => {
  const first = appendOutput(undefined, new Uint8Array(MAX_OUTPUT_BYTES));
  const second = appendOutput(first, new Uint8Array([65]));
  assert.equal(first.chunks.length, 1);
  assert.equal(first.bytes, MAX_OUTPUT_BYTES);
  assert.equal(second.start, 1);
  assert.equal(second.bytes, 1);
  const third = appendOutput(second, new Uint8Array([66]));
  assert.equal(third.start + third.chunks.length, 3);
  assert.deepEqual(third.chunks.map((chunk) => [...chunk]), [[65], [66]]);
});

test("run output stays isolated and does not mutate previous store snapshots", () => {
  const handle = useAppStore.getState().handleRunEvent;
  handle({ type: "output", run_id: "a", stream: "stdout", data: btoa("A") });
  const previous = useAppStore.getState().outputBuffers;
  handle({ type: "output", run_id: "b", stream: "stderr", data: btoa("B") });
  handle({ type: "output", run_id: "a", stream: "stdout", data: btoa("C") });
  const current = useAppStore.getState().outputBuffers;
  assert.equal(previous.a.chunks.length, 1);
  assert.deepEqual(current.a.chunks.map((chunk) => [...chunk]), [[65], [67]]);
  assert.deepEqual(current.b.chunks.map((chunk) => [...chunk]), [[66]]);
});

test("terminal events update history synchronously and without duplicates", () => {
  const status = { run_id: "finished", device_name: "device", label: "test", state: "exited", exit_code: 0, error: null, started_at: "now", ended_at: "now" };
  useAppStore.getState().handleRunEvent({ type: "status", status });
  useAppStore.getState().handleRunEvent({ type: "status", status });
  assert.equal(useAppStore.getState().history.filter((h) => h.run_id === status.run_id).length, 1);
  assert.equal(useAppStore.getState().runs.finished.exit_code, 0);
});

test("recent workspaces persist successful opens, reorder repeats, and survive failed opens", async (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalState = useAppStore.getState();
  let stored: string | null = null;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    useAppStore.setState(originalState, true);
  });
  t.mock.method(api, "listWorkspaceDir", async (dir: string) => {
    if (dir === "/missing") throw new Error("Directory no longer exists");
    return [{ name: "main.py", is_dir: false }];
  });
  useAppStore.setState({ recentWorkspaces: [] });
  const { setWorkspaceDir } = useAppStore.getState();
  for (let i = 0; i < 12; i++) await setWorkspaceDir(`/workspace/${i}`);
  await setWorkspaceDir("/workspace/5");
  const recent = useAppStore.getState().recentWorkspaces;
  assert.equal(recent.length, 10);
  assert.equal(recent[0], "/workspace/5");
  assert.equal(new Set(recent).size, 10);
  assert.ok(!recent.includes("/workspace/0"));
  assert.deepEqual(loadWorkspaceHistory(), recent);

  useAppStore.setState({ openFile: "main.py", fileContent: "print('hello')", savedContent: "print('hello')" });
  const beforeFailure = useAppStore.getState();
  await assert.rejects(setWorkspaceDir("/missing"), /Directory no longer exists/);
  assert.equal(useAppStore.getState().fileContent, beforeFailure.fileContent);
  assert.equal(useAppStore.getState().workspaceDir, beforeFailure.workspaceDir);
  assert.deepEqual(loadWorkspaceHistory(), recent);

  stored = "invalid JSON";
  assert.deepEqual(loadWorkspaceHistory(), []);
  stored = JSON.stringify([null, 7, "", "  ", "/valid", "/valid"]);
  assert.deepEqual(loadWorkspaceHistory(), ["/valid"]);

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => { throw new Error("Storage unavailable"); },
  });
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(loadWorkspaceHistory(), []);
  await setWorkspaceDir("/still-works");
  assert.equal(useAppStore.getState().workspaceDir, "/still-works");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const diskDocument = (content: string) => ({ content, revision: `revision-${content}`, eol: "lf" as const, bom: false });
const editorState = () => ({ workspaceDir: "/work", openFile: "main.py", fileContent: "original", savedContent: "original",
  revision: "v1", loading: false, saving: false, starting: false, guarding: false, changePrompt: null,
  editorError: null, conflict: false, runs: {}, documentGeneration: 1 });

test("latest file selection wins including stale failures and cross-workspace reads", async (t) => {
  t.mock.method(console, "warn", () => {});
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState(editorState());
  const a = deferred<ReturnType<typeof diskDocument>>();
  const b = deferred<ReturnType<typeof diskDocument>>();
  t.mock.method(api, "readWorkspaceFile", (_dir: string, name: string) => name === "a.py" ? a.promise : b.promise);
  const first = useAppStore.getState().openWorkspaceFile("a.py");
  await Promise.resolve();
  const second = useAppStore.getState().openWorkspaceFile("b.sh");
  b.resolve(diskDocument("B"));
  await second;
  a.reject(new Error("stale failure"));
  await first;
  assert.equal(useAppStore.getState().openFile, "b.sh");
  assert.equal(useAppStore.getState().language, "shell");
  assert.equal(useAppStore.getState().editorError, null);
  const late = deferred<ReturnType<typeof diskDocument>>();
  t.mock.method(api, "readWorkspaceFile", () => late.promise);
  t.mock.method(api, "listWorkspaceDir", async () => []);
  const oldRead = useAppStore.getState().openWorkspaceFile("c.py");
  await Promise.resolve();
  await useAppStore.getState().setWorkspaceDir("/new");
  late.resolve(diskDocument("old workspace"));
  await oldRead;
  assert.equal(useAppStore.getState().workspaceDir, "/new");
  assert.equal(useAppStore.getState().openFile, null);
});

test("save preserves newer edits, serializes writes, and undo to baseline clears dirty", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState(editorState());
  const pending = deferred<{ revision: string }>();
  let calls = 0;
  t.mock.method(api, "writeWorkspaceFile", (request) => {
    calls++;
    assert.equal(request.content, "saved snapshot");
    assert.equal(request.expectedRevision, "v1");
    return pending.promise;
  });
  const state = useAppStore.getState();
  state.editContent("saved snapshot");
  const save = state.saveFile();
  assert.equal(await state.saveFile(), false);
  state.editContent("new typing");
  pending.resolve({ revision: "v2" });
  assert.equal(await save, true);
  assert.equal(calls, 1);
  assert.equal(useAppStore.getState().savedContent, "saved snapshot");
  assert.equal(useAppStore.getState().fileContent, "new typing");
  assert.equal(dirtyDocument(useAppStore.getState()), true);
  state.editContent("saved snapshot");
  assert.equal(dirtyDocument(useAppStore.getState()), false);
});

test("switch guard handles cancel, discard with failed read, and save failure without losing buffer", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ ...editorState(), fileContent: "my edits" });
  t.mock.method(api, "readWorkspaceFile", async () => { throw new Error("missing file"); });
  t.mock.method(api, "writeWorkspaceFile", async () => { throw { code: "conflict", message: "external change" }; });
  const state = useAppStore.getState();
  for (const choice of ["cancel", "discard", "save"] as const) {
    const switching = state.openWorkspaceFile("other.py");
    assert.ok(useAppStore.getState().changePrompt);
    state.editContent("ignored while confirming");
    useAppStore.getState().changePrompt!.resolve(choice);
    await switching;
    assert.equal(useAppStore.getState().openFile, "main.py");
    assert.equal(useAppStore.getState().fileContent, "my edits");
    assert.equal(useAppStore.getState().guarding, false);
  }
  assert.equal(useAppStore.getState().conflict, true);
  t.mock.method(api, "readWorkspaceFile", async () => diskDocument("external"));
  const reload = state.reloadFile();
  useAppStore.getState().changePrompt!.resolve("discard");
  await reload;
  assert.equal(useAppStore.getState().fileContent, "external");
  assert.equal(useAppStore.getState().conflict, false);
});

test("save-and-continue writes before switching and the close guard supports all choices", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ ...editorState(), fileContent: "edits" });
  const order: string[] = [];
  t.mock.method(api, "writeWorkspaceFile", async () => { order.push("save"); return { revision: "v2" }; });
  t.mock.method(api, "readWorkspaceFile", async () => { order.push("read"); return diskDocument("new"); });
  const switching = useAppStore.getState().openWorkspaceFile("new.py");
  useAppStore.getState().changePrompt!.resolve("save");
  await switching;
  assert.deepEqual(order, ["save", "read"]);
  for (const choice of ["cancel", "discard", "save"] as const) {
    useAppStore.getState().editContent(`edit ${choice}`);
    const allowed = useAppStore.getState().confirmUnsaved();
    useAppStore.getState().changePrompt!.resolve(choice);
    assert.equal(await allowed, choice !== "cancel");
  }
});

test("both run modes save non-entry edits first; failed saves never launch and startup locks editing", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  const order: string[] = [];
  t.mock.method(api, "writeWorkspaceFile", async () => { order.push("save"); return { revision: "v2" }; });
  t.mock.method(api, "runScript", async () => { order.push("run"); return "run-1"; });
  t.mock.method(api, "getRunStatus", async () => null);
  for (const kind of ["python", "command"] as const) {
    useAppStore.setState({ ...editorState(), openFile: "helper.py", fileContent: "edited helper" });
    const request = { device_id: "device", workspace_dir: "/work", kind, entry: "main.py", command: "python3 main.py" };
    const starting = useAppStore.getState().startRun(request);
    useAppStore.getState().editContent("ignored during launch");
    assert.equal(useAppStore.getState().fileContent, "edited helper");
    await starting;
    assert.equal(useAppStore.getState().runs["run-1"].state, "preparing");
    useAppStore.getState().editContent("next run");
    assert.equal(await useAppStore.getState().saveFile(), false);
  }
  assert.deepEqual(order, ["save", "run", "save", "run"]);
  useAppStore.setState({ ...editorState(), fileContent: "edits" });
  t.mock.method(api, "writeWorkspaceFile", async () => { throw new Error("disk full"); });
  await assert.rejects(useAppStore.getState().startRun({ device_id: "device", workspace_dir: "/work", kind: "python", entry: "main.py" }), /disk full/);
  assert.equal(order.length, 4);
  assert.equal(useAppStore.getState().starting, false);
  assert.equal(useAppStore.getState().fileContent, "edits");
});

test("editor language detection does not change execution inference", () => {
  assert.equal(inferLanguage("HELLO.PY"), "python");
  assert.equal(inferLanguage("run.BASH"), "shell");
  assert.equal(inferLanguage("config.txt"), "text");
});

test("clearHistory empties history and drops finished runs and their buffers", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(api, "clearRunHistory", async () => {});
  const finished = { run_id: "done-clear", device_name: "device", label: "test", state: "exited", exit_code: 0, error: null, started_at: "now", ended_at: "now" };
  useAppStore.setState({ activeRunId: null });
  useAppStore.getState().handleRunEvent({ type: "status", status: finished });
  useAppStore.getState().handleRunEvent({ type: "output", run_id: "done-clear", stream: "stdout", data: btoa("x") });
  assert.equal(useAppStore.getState().history.some((h) => h.run_id === "done-clear"), true);

  await useAppStore.getState().clearHistory();
  const state = useAppStore.getState();
  assert.equal(state.history.length, 0);
  assert.equal(state.runs["done-clear"], undefined);
  assert.equal(state.outputBuffers["done-clear"], undefined);
});
