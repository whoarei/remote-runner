import test from "node:test";
import assert from "node:assert/strict";
import { appendOutput, MAX_OUTPUT_BYTES } from "../src/outputBuffer";
import { useAppStore } from "../src/store";
import { api } from "../src/api";
import { loadWorkspaceHistory } from "../src/workspaceHistory";

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
  t.mock.method(api, "listWorkspace", async (dir: string) => {
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

  useAppStore.setState({ openFile: "main.py", fileContent: "print('hello')" });
  const beforeFailure = useAppStore.getState();
  await assert.rejects(setWorkspaceDir("/missing"), /Directory no longer exists/);
  assert.equal(useAppStore.getState(), beforeFailure);
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
