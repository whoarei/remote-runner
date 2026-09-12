import test from "node:test";
import assert from "node:assert/strict";
import { RunStatus } from "../src/api";
import { buildRecordJson, canExportOutput, defaultExportName } from "../src/historyExport";

const status = (overrides: Partial<RunStatus> = {}): RunStatus => ({
  run_id: "run-1",
  device_name: "device",
  label: "main.py",
  state: "exited",
  exit_code: 0,
  error: null,
  started_at: "2026-09-12T08:30:05+08:00",
  ended_at: "2026-09-12T08:31:00+08:00",
  ...overrides,
});

test("defaultExportName 清洗非法文件名字符并附本地时间戳", () => {
  const name = defaultExportName(status({ label: 'a<b>:"/\\|?* 脚本' }), "json");
  assert.match(name, /^a_b_{8} 脚本-\d{8}-\d{6}\.json$/);
  // 空标签与坏时间有兜底
  assert.equal(defaultExportName(status({ label: "  ", started_at: "bad" }), "log"), "run-unknown-time.log");
});

test("canExportOutput 仅对已持久化输出的记录可用", () => {
  assert.equal(canExportOutput(status()), false);
  assert.equal(canExportOutput(status({ output_bytes: 0 })), false);
  assert.equal(canExportOutput(status({ output_bytes: 128 })), true);
});

test("buildRecordJson 输出完整元数据且可被解析", () => {
  const record = status({ output_bytes: 10, output_truncated: true });
  const parsed = JSON.parse(buildRecordJson(record)) as RunStatus;
  assert.deepEqual(parsed, record);
});
