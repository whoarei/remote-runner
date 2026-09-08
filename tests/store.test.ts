import test from "node:test";
import assert from "node:assert/strict";
import { appendOutput, MAX_OUTPUT_BYTES } from "../src/outputBuffer";
import { useAppStore } from "../src/store";

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
