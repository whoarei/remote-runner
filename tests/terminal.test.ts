import test from "node:test";
import assert from "node:assert/strict";
import { api, type TerminalStatus } from "../src/api";
import { useTerminalStore, terminalActive } from "../src/terminalStore";
import { terminalInput, readTerminal } from "../src/terminalIO";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";

// 文案断言基于中文字典，固定测试语言避免随运行环境漂移
test.before(async () => { await i18n.changeLanguage("zh"); });

const status = (id: string, state: TerminalStatus["state"] = "connected"): TerminalStatus =>
  ({ session_id: id, device_name: id, state, exit_code: null, error: null });
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
function reset(t: test.TestContext) {
  const before = useTerminalStore.getState();
  useTerminalStore.setState({ tabs: [], activeTab: "run", shuttingDown: false });
  t.after(() => useTerminalStore.setState(before));
  return useTerminalStore.getState();
}

test("terminals are independent from runs and do not save or upload the workspace", async (t) => {
  const s = reset(t);
  const runState = useAppStore.getState();
  t.mock.method(api, "openTerminal", async (id) => status(id));
  const save = t.mock.method(api, "writeWorkspaceFile", async () => { throw new Error("must not save"); });
  const run = t.mock.method(api, "runScript", async () => { throw new Error("must not run"); });
  await Promise.all([s.open("a", "Ubuntu"), s.open("b", "Board")]);
  const [a, b] = useTerminalStore.getState().tabs;
  s.select(a.id);
  assert.equal(useTerminalStore.getState().activeTab, a.id);
  assert.equal(b.status?.session_id, "b");
  assert.equal(save.mock.callCount(), 0);
  assert.equal(run.mock.callCount(), 0);
  assert.equal(useAppStore.getState(), runState);
  s.update(a.id, "b", status("b", "failed"));
  assert.equal(useTerminalStore.getState().tabs[0].status?.state, "connected");
});

test("reconnect retires the old session before opening another; stale events cannot change it", async (t) => {
  const s = reset(t);
  const calls: string[] = [];
  t.mock.method(api, "openTerminal", async () => { calls.push("open"); return status(`s${calls.length}`, "exited"); });
  t.mock.method(api, "closeTerminal", async (id) => { calls.push(`close:${id}`); });
  await s.open("a", "A");
  const tab = useTerminalStore.getState().tabs[0];
  await s.reconnect(tab.id);
  assert.deepEqual(calls, ["open", "close:s1", "open"]);
  s.update(tab.id, "s1", status("s1", "failed"));
  assert.equal(useTerminalStore.getState().tabs[0].status?.session_id, "s3");
  await s.close(tab.id);
  assert.equal(useTerminalStore.getState().activeTab, "run");
  assert.equal(useTerminalStore.getState().tabs.length, 0);
});

test("failed close preserves the tab; simultaneous opens reserve the session limit", async (t) => {
  const s = reset(t);
  t.mock.method(api, "openTerminal", async (id) => status(id));
  t.mock.method(api, "closeTerminal", async () => { throw new Error("cleanup pending"); });
  await Promise.all(Array.from({ length: 8 }, (_, i) => s.open(String(i), "A")));
  await assert.rejects(s.open("9", "B"), /8/);
  const tab = useTerminalStore.getState().tabs[0];
  await s.close(tab.id);
  assert.equal(useTerminalStore.getState().tabs.length, 8);
  assert.match(useTerminalStore.getState().tabs[0].error!, /cleanup pending/);
  assert.equal(terminalActive(useTerminalStore.getState().tabs[0]), true);
});

test("application shutdown waits for in-flight opens and refuses additional terminals", async (t) => {
  const s = reset(t);
  let resolve!: (value: TerminalStatus) => void;
  t.mock.method(api, "openTerminal", () => new Promise<TerminalStatus>((r) => { resolve = r; }));
  const close = t.mock.method(api, "closeAllTerminals", async () => {});
  const opening = s.open("a", "A");
  const closing = s.closeAll();
  await assert.rejects(s.open("b", "B"), /关闭/);
  assert.equal(close.mock.callCount(), 0);
  resolve(status("a"));
  await Promise.all([opening, closing]);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(useTerminalStore.getState().tabs.length, 0);
});

test("input keeps Ctrl+C as data, serializes Unicode paste and rejects excessive pending input", async () => {
  const sent: string[] = [];
  const errors: unknown[] = [];
  let finish!: () => void;
  const input = terminalInput(async (chunk) => { sent.push(chunk); if (sent.length === 1) await new Promise<void>((r) => { finish = r; }); }, (e) => errors.push(e));
  const text = "a".repeat(4095) + "😀" + "中".repeat(5000);
  input.send(text);
  input.send("\x03");
  assert.equal(sent.length, 1);
  input.send("z".repeat(65536));
  assert.equal(errors.length, 1);
  finish();
  await delay();
  assert.equal(sent.join(""), text + "\x03");
  for (const chunk of sent) {
    assert.ok(new TextEncoder().encode(chunk).length <= 16384);
    assert.equal(chunk.includes("\ufffd"), false);
    assert.equal(Buffer.from(chunk).toString(), chunk);
  }
  input.dispose(); input.send("must not send");
  assert.equal(sent.join(""), text + "\x03");
});

test("terminal polling waits for parsing and drains final output without replay/reset", async () => {
  let reads = 0;
  let finish!: () => void;
  const writes: number[][] = [];
  const states: string[] = [];
  const errors: unknown[] = [];
  const stop = readTerminal(async () => ({ status: status("a", "exited"), data: ++reads <= 2 ? Buffer.from([255, 0, 27, 13, 10]).toString("base64") : "" }),
    async (bytes) => { writes.push([...bytes]); if (writes.length === 1) await new Promise<void>((r) => { finish = r; }); },
    (read) => states.push(read.status.state), (e) => errors.push(e));
  await delay(20);
  assert.equal(reads, 1);
  finish();
  await delay(40);
  stop();
  assert.equal(reads, 3);
  assert.deepEqual(writes, [[255, 0, 27, 13, 10], [255, 0, 27, 13, 10]]);
  assert.deepEqual(states, ["exited", "exited", "exited"]);
  assert.deepEqual(errors, []);
});

test("StrictMode setup/cleanup does not consume native terminal output", async () => {
  let calls = 0;
  const stop = readTerminal(async () => { calls++; return { status: status("a"), data: "" }; }, async () => {}, () => {}, () => {});
  stop(); await delay(); assert.equal(calls, 0);
});
