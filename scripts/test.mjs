import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "remote-runner-tests-"));
try {
  await build({
    entryPoints: ["tests/store.test.ts", "tests/layout.test.ts"],
    outdir: directory,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const result = spawnSync(process.execPath, ["--test", join(directory, "store.test.cjs"), join(directory, "layout.test.cjs")], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
