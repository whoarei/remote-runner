import assert from "node:assert/strict";
import test from "node:test";
import { checkForAvailableUpdate, directUpdateAction, formatBytes, formatDownloadProgress, installWithProgress, updateButtonLabel, updateInstallBlocker } from "../src/updateStatus";
import type { AppUpdateInfo } from "../src/api";

test("installation protects unsaved files and all active run phases", () => {
  const state = { openTabs: [{ fileContent: "saved", savedContent: "saved" }], loading: false, saving: false, starting: false, guarding: false, workspaceMutating: false, runs: {} };
  assert.equal(updateInstallBlocker(state), null);
  assert.match(updateInstallBlocker({ ...state, openTabs: [{ fileContent: "edited", savedContent: "saved" }] })!, /保存/);
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

const sampleUpdate: AppUpdateInfo = {
  current_version: "0.3.1",
  latest_version: "0.3.2",
  notes: null,
  published_at: null,
  download_url: "https://github.com/whoarei/remote-runner/releases/latest",
  can_auto_install: true,
};

test("startup check surfaces only an available update", async () => {
  const seen: AppUpdateInfo[] = [];
  await checkForAvailableUpdate(async () => sampleUpdate, (info) => seen.push(info));
  assert.deepEqual(seen, [sampleUpdate]);
  await checkForAvailableUpdate(async () => null, (info) => seen.push(info));
  assert.deepEqual(seen, [sampleUpdate]);
});

test("startup check swallows failures silently", async () => {
  await checkForAvailableUpdate(async () => { throw new Error("offline"); }, () => assert.fail("must not notify on failure"));
});

test("one-click update blocks with reason, falls back to download page, or installs", () => {
  assert.deepEqual(directUpdateAction(sampleUpdate, "请先保存编辑器中的修改，再安装更新。"),
    { kind: "blocked", reason: "请先保存编辑器中的修改，再安装更新。" });
  assert.deepEqual(directUpdateAction({ ...sampleUpdate, can_auto_install: false }, null),
    { kind: "manual", url: sampleUpdate.download_url });
  assert.deepEqual(directUpdateAction(sampleUpdate, null), { kind: "install" });
  // A blocker wins over the portable fallback so the reason is always explained.
  assert.deepEqual(directUpdateAction({ ...sampleUpdate, can_auto_install: false }, "忙"),
    { kind: "blocked", reason: "忙" });
});

test("updateButtonLabel renders each phase compactly", () => {
  assert.equal(updateButtonLabel(null), "更新");
  assert.equal(updateButtonLabel({ kind: "checking" }), "正在检查…");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 512, total: 1024 }), "下载中 50%");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 2048, total: 1024 }), "下载中 100%");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 1024, total: null }), "下载中 1.0 KB");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 1024, total: 0 }), "下载中 1.0 KB");
  assert.equal(updateButtonLabel({ kind: "verifying" }), "验证签名…");
  assert.equal(updateButtonLabel({ kind: "installing" }), "正在安装…");
});
