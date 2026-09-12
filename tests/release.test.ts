import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseVersion, syncVersion, validateManifest } from "../scripts/release-helpers.mjs";

test("release tags reject unstable, malformed and unsafe values", () => {
  assert.equal(releaseVersion("v0.10.2"), "0.10.2");
  for (const tag of ["v01.2.3", "v1.2.3-rc.1", "v1.2.3+build", "v1.2.3junk", "v1.2.3\n", "v65536.0.0", "v1.2.3'; whoami"]) assert.throws(() => releaseVersion(tag));
});

test("version synchronization changes app metadata and both lockfiles only", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-release-"));
  try {
    mkdirSync(join(root, "src-tauri"));
    for (const file of ["package.json", "src-tauri/tauri.conf.json"]) writeFileSync(join(root, file), '{"version":"0.2.0"}');
    writeFileSync(join(root, "package-lock.json"), '{"version":"0.2.0","packages":{"":{"version":"0.2.0"},"node_modules/example":{"version":"1.0.0"}}}');
    writeFileSync(join(root, "src-tauri/Cargo.toml"), '[dependencies]\nfoo = { version = "2" }\n[package]\nname = "remote-runner"\nversion = "0.2.0"\n');
    writeFileSync(join(root, "src-tauri/Cargo.lock"), '[[package]]\nname = "example"\nversion = "9.0.0"\n\n[[package]]\nname = "remote-runner"\nversion = "0.2.0"\n');
    syncVersion(root, "v0.10.2");
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "0.10.2");
    assert.equal(lock.packages[""].version, "0.10.2");
    assert.equal(lock.packages["node_modules/example"].version, "1.0.0");
    assert.match(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"), /foo = \{ version = "2" \}/);
    assert.match(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"), /name = "example"\nversion = "9.0.0"/);
    assert.match(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"), /name = "remote-runner"\nversion = "0.10.2"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release manifest requires the signed installer and portable assets", () => {
  const name = "Remote.Runner_0.3.0_x64-setup.exe";
  const platform = { url: `https://github.com/whoarei/remote-runner/releases/download/v0.3.0/${name}`, signature: "signature" };
  const manifest = { version: "0.3.0", platforms: { "windows-x86_64": platform } };
  const assets = [name, `${name}.sig`, "Remote.Runner_0.3.0_x64-portable.exe"].map((name) => ({ name, size: 42 }));
  validateManifest(manifest, assets, "0.3.0");
  assert.throws(() => validateManifest(manifest, assets.slice(0, 1), "0.3.0"));
  assert.throws(() => validateManifest(manifest, assets, "0.4.0"));
  assert.throws(() => validateManifest({ ...manifest, platforms: {} }, assets, "0.3.0"));
  for (const url of [platform.url.replace("github.com", "evil.example"), platform.url.replace("-setup.exe", "-setup.nsis.zip")]) {
    assert.throws(() => validateManifest({ ...manifest, platforms: { "windows-x86_64": { ...platform, url } } }, assets, "0.3.0"));
  }
});
