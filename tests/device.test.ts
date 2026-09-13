import test from "node:test";
import assert from "node:assert/strict";
import { deviceLabel, emptyDevice } from "../src/components/DeviceDialog";
import { DeviceProfile } from "../src/api";

test("device label covers local shell devices and keeps other transports unchanged", () => {
  const local: DeviceProfile = {
    ...emptyDevice(),
    name: "home",
    transport: "local",
    local: { shell: "pwsh", path: null },
  };
  assert.equal(deviceLabel(local), "home (Local · pwsh)");

  const ssh: DeviceProfile = { ...emptyDevice(), name: "box", host: "10.0.0.2", username: "root" };
  assert.equal(deviceLabel(ssh), "box (root@10.0.0.2)");

  const wsl: DeviceProfile = { ...emptyDevice(), name: "wsl", transport: "wsl", wsl: { distribution: "Ubuntu-24.04", user: "" } };
  assert.equal(deviceLabel(wsl), "wsl (WSL · Ubuntu-24.04)");
});

test("new device template carries a local shell placeholder", () => {
  const device = emptyDevice();
  assert.deepEqual(device.local, { shell: "", path: null });
  assert.equal(device.transport, "ssh");
});
