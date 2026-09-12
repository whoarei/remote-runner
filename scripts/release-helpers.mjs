import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One stable channel; reject prereleases, build metadata, leading zeros and shell text.
export function releaseVersion(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error("发布标签必须为稳定版本 vX.Y.Z");
  const version = tag.slice(1);
  if (version.split(".").some((part) => Number(part) > 65535)) throw new Error("Windows 版本字段必须不大于 65535");
  return version;
}

export function syncVersion(root, tag) {
  const version = releaseVersion(tag);
  const jsonFiles = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"];
  const changes = jsonFiles.map((file) => {
    const json = JSON.parse(readFileSync(join(root, file), "utf8"));
    json.version = version;
    if (file === "package-lock.json") json.packages[""].version = version;
    return [file, `${JSON.stringify(json, null, 2)}\n`];
  });
  for (const [file, pattern] of [
    ["src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("\r?\n)/],
    ["src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "remote-runner"\r?\nversion = ")[^"]+("\r?\n)/],
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    if (!pattern.test(source)) throw new Error(`找不到应用版本：${file}`);
    changes.push([file, source.replace(pattern, (_, before, after) => `${before}${version}${after}`)]);
  }
  for (const [file, contents] of changes) writeFileSync(join(root, file), contents);
  return version;
}

export function validateManifest(manifest, assets, version) {
  if (manifest.version !== version) throw new Error("更新清单版本与标签不一致");
  const platform = manifest.platforms?.["windows-x86_64"] ?? manifest.platforms?.["windows-x86_64-nsis"];
  if (!platform?.signature?.trim()) throw new Error("更新清单缺少签名");
  const url = new URL(platform.url);
  const prefix = `/whoarei/remote-runner/releases/download/v${version}/`;
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) throw new Error("更新清单地址无效");
  const name = decodeURIComponent(url.pathname.slice(prefix.length));
  if (name.includes("/") || !name.endsWith("-setup.exe")) throw new Error("更新清单必须指向 NSIS exe");
  for (const asset of [name, `${name}.sig`, `Remote.Runner_${version}_x64-portable.exe`]) {
    if (!assets.some((entry) => entry.name === asset && entry.size > 0)) throw new Error(`Release 缺少产物：${asset}`);
  }
}
