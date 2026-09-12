import { readFileSync } from "node:fs";
import { releaseVersion, syncVersion, validateManifest } from "./release-helpers.mjs";

const [command, ...args] = process.argv.slice(2);
if (command === "sync") syncVersion(process.cwd(), args[0]);
else if (command === "verify") {
  const [manifest, assets, tag] = args;
  validateManifest(JSON.parse(readFileSync(manifest, "utf8")), JSON.parse(readFileSync(assets, "utf8")).assets, releaseVersion(tag));
} else throw new Error("Usage: release.mjs sync <tag> | verify <manifest> <assets> <tag>");
