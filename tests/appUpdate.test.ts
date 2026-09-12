import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, formatDownloadProgress, installWithProgress, updateInstallBlocker } from "../src/updateStatus";

test("installation protects unsaved files and all active run phases", () => {
  const state = { openFile: "main.py", fileContent: "saved", savedContent: "saved", loading: false, saving: false, starting: false, guarding: false, workspaceMutating: false, runs: {} };
  assert.equal(updateInstallBlocker(state), null);
  assert.match(updateInstallBlocker({ ...state, fileContent: "edited" })!, /保存/);
  for (const flag of ["loading", "saving", "starting", "guarding", "workspaceMutating"]) assert.ok(updateInstallBlocker({ ...state, [flag]: true }));
  for (const phase of ["preparing", "syncing", "running", "stopping"]) assert.ok(updateInstallBlocker({ ...state, runs: { run: { state: phase } } }));
  assert.equal(updateInstallBlocker({ ...state, runs: { run: { state: "exited" } } }), null);
});

test("progress listener is ready before installing the reviewed version and always cleaned up", async () => {
  for (const fail of [false, true]) {
    const calls: string[] = [];
    const result = installWithProgress("0.3.0", async () => { calls.push("listen"); return () => { calls.push("unlisten"); }; }, async (version) => {
      calls.push(version); if (fail) throw new Error("invalid signature");
    });
    if (fail) await assert.rejects(result, /signature/); else await result;
    assert.deepEqual(calls, ["listen", "0.3.0", "unlisten"]);
  }
  await assert.rejects(installWithProgress("0.3.0", async () => { throw new Error("listener failed"); }, async () => { assert.fail("must not install"); }), /listener failed/);
});

test("formatBytes renders human readable sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(-1), "0 B");
});

test("formatDownloadProgress with known total shows percent", () => {
  assert.equal(formatDownloadProgress(512, 1024), "已下载 512 B / 1.0 KB（50%）");
});

test("formatDownloadProgress clamps percent at 100", () => {
  assert.match(formatDownloadProgress(2048, 1024), /（100%）$/);
});

test("formatDownloadProgress without total shows downloaded only", () => {
  assert.equal(formatDownloadProgress(1024, null), "已下载 1.0 KB");
  assert.equal(formatDownloadProgress(1024, 0), "已下载 1.0 KB");
});
