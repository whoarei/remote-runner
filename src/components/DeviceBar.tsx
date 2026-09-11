import { useState } from "react";
import { api, DeviceProfile } from "../api";
import { useAppStore } from "../store";

const emptyDevice = (): DeviceProfile => ({
  id: "",
  name: "",
  transport: "ssh",
  serial: { port: "", baud_rate: 115200 },
  wsl: { distribution: "", user: "" },
  host: "",
  port: 22,
  username: "root",
  auth: { type: "key", key_path: null },
  workspace_root: "/tmp/devrunner/workspaces",
});

export function DeviceBar() {
  const { devices, selectedDeviceId, selectDevice, loadDevices } = useAppStore();
  const [editing, setEditing] = useState<DeviceProfile | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const [distributions, setDistributions] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);

  const refreshPorts = async () => {
    try { setPorts(await api.listSerialPorts()); }
    catch (e) { setTestResult(`串口枚举失败: ${e}`); }
  };

  const refreshDistributions = async () => {
    try { setDistributions(await api.listWslDistributions()); }
    catch (e) { setTestResult(`WSL 发行版枚举失败: ${e}`); }
  };

  const save = async (d: DeviceProfile) => {
    try {
      await api.saveDevice(d);
      await loadDevices();
      setEditing(null);
    } catch (e) { setTestResult(`保存失败: ${e}`); }
  };

  const remove = async (d: DeviceProfile) => {
    if (!confirm(`Delete device "${d.name}"?`)) return;
    await api.deleteDevice(d.id);
    await loadDevices();
    setEditing(null);
  };

  const test = async (d: DeviceProfile) => {
    setTestResult("connecting...");
    setTesting(true);
    try {
      setTestResult(await api.testDevice(d));
    } catch (e) {
      setTestResult(`FAILED: ${e}`);
    } finally { setTesting(false); }
  };

  return (
    <div className="device-bar">
      <span className="label">Device:</span>
      <select
        value={selectedDeviceId ?? ""}
        onChange={(e) => selectDevice(e.target.value || null)}
      >
        {devices.length === 0 && <option value="">（无设备，请先添加）</option>}
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.transport === "wsl" ? `WSL · ${d.wsl?.distribution}` : d.transport === "serial" ? `${d.serial?.port} · ${d.serial?.baud_rate}` : `${d.username}@${d.host}`})
          </option>
        ))}
      </select>
      <button onClick={() => { setTestResult(null); setEditing(emptyDevice()); }}>+ 添加设备</button>
      {selectedDeviceId && (
        <button
          onClick={() => {
            const d = devices.find((x) => x.id === selectedDeviceId);
            if (d) { setTestResult(null); setEditing({ ...d }); if (d.transport === "wsl") void refreshDistributions(); }
          }}
        >
          编辑
        </button>
      )}

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing.id ? "编辑设备" : "添加设备"}</h3>
            <label>
              名称
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label>
              连接方式
              <select value={editing.transport} disabled={testing} onChange={(e) => {
                const transport = e.target.value as DeviceProfile["transport"];
                setEditing({ ...editing, transport, serial: editing.serial ?? { port: "", baud_rate: 115200 }, wsl: editing.wsl ?? { distribution: "", user: "" } });
                setTestResult(null);
                if (transport === "serial") void refreshPorts();
                if (transport === "wsl") void refreshDistributions();
              }}>
                <option value="ssh">SSH</option>
                <option value="serial">串口</option>
                <option value="wsl">WSL（本机发行版）</option>
              </select>
            </label>
            {editing.transport === "wsl" ? <>
              <label>
                WSL 发行版
                <input list="wsl-distributions" value={editing.wsl?.distribution ?? ""} placeholder="例如 Ubuntu-24.04"
                  onChange={(e) => setEditing({ ...editing, wsl: { distribution: e.target.value, user: editing.wsl?.user ?? "" } })} />
                <datalist id="wsl-distributions">{distributions.map((name) => <option key={name} value={name} />)}</datalist>
                <button type="button" onClick={refreshDistributions}>刷新发行版</button>
              </label>
              <label>
                Linux 用户（留空使用发行版默认用户）
                <input value={editing.wsl?.user ?? ""} placeholder="默认用户"
                  onChange={(e) => setEditing({ ...editing, wsl: { distribution: editing.wsl?.distribution ?? "", user: e.target.value } })} />
              </label>
              <p>直接在本机 WSL 中运行，无需 SSH。发行版需有 python3，运行 Shell 脚本还需 bash；支持 PTY 交互及 pipe 输出。工作区每次复制到 WSL，单文件上限 16 MiB，总计 64 MiB。</p>
            </> : editing.transport === "serial" ? <>
              <label>
                串口
                <input list="serial-ports" value={editing.serial?.port ?? ""} placeholder="COM8 或 /dev/ttyUSB0"
                  onChange={(e) => setEditing({ ...editing, serial: { port: e.target.value, baud_rate: editing.serial?.baud_rate ?? 115200 } })} />
                <datalist id="serial-ports">{ports.map((port) => <option key={port} value={port} />)}</datalist>
                <button type="button" onClick={refreshPorts}>刷新端口</button>
              </label>
              <label>
                波特率
                <input type="number" min={1} max={4000000} list="serial-baud-rates" value={editing.serial?.baud_rate ?? 115200}
                  onChange={(e) => setEditing({ ...editing, serial: { port: editing.serial?.port ?? "", baud_rate: Number(e.target.value) } })} />
                <datalist id="serial-baud-rates">{[9600, 57600, 115200, 230400, 460800, 921600, 1500000].map((rate) => <option key={rate} value={rate} />)}</datalist>
              </label>
              <p>8N1，无流控。设备串口需已登录 Linux shell；测试连接会执行探测命令。同一串口一次只能运行一个任务。</p>
            </> : <>
            <label>
              Host
              <input
                value={editing.host}
                placeholder="172.16.0.67"
                onChange={(e) => setEditing({ ...editing, host: e.target.value })}
              />
            </label>
            <label>
              端口
              <input
                type="number"
                value={editing.port}
                onChange={(e) =>
                  setEditing({ ...editing, port: Number(e.target.value) || 22 })
                }
              />
            </label>
            <label>
              用户名
              <input
                value={editing.username}
                onChange={(e) => setEditing({ ...editing, username: e.target.value })}
              />
            </label>
            <label>
              认证方式
              <select
                value={editing.auth.type}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    auth:
                      e.target.value === "password"
                        ? { type: "password", password: "" }
                        : { type: "key", key_path: null },
                  })
                }
              >
                <option value="key">SSH 密钥 / agent</option>
                <option value="password">密码</option>
              </select>
            </label>
            {editing.auth.type === "password" && (
              <label>
                密码
                <input
                  type="password"
                  value={editing.auth.password}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      auth: { type: "password", password: e.target.value },
                    })
                  }
                />
              </label>
            )}
            {editing.auth.type === "key" && (
              <label>
                私钥路径（留空 = agent / 默认密钥）
                <input
                  value={editing.auth.key_path ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      auth: {
                        type: "key",
                        key_path: e.target.value || null,
                      },
                    })
                  }
                />
              </label>
            )}
            </>}
            <label>
              {editing.transport === "wsl" ? "WSL 工作区根目录" : "远程工作区根目录"}
              <input
                value={editing.workspace_root}
                onChange={(e) =>
                  setEditing({ ...editing, workspace_root: e.target.value })
                }
              />
            </label>
            <div className="modal-actions">
              <button disabled={testing} onClick={() => test(editing)}>测试连接</button>
              {editing.id && (
                <button className="danger" onClick={() => remove(editing)}>
                  删除
                </button>
              )}
              <button
                className="primary"
                disabled={testing || !editing.name || (editing.transport === "wsl" ? !editing.wsl?.distribution.trim() : editing.transport === "serial" ? !editing.serial?.port || !editing.serial?.baud_rate : !editing.host)}
                onClick={() => save(editing)}
              >
                保存
              </button>
            </div>
            {testResult && <pre className="test-result">{testResult}</pre>}
          </div>
        </div>
      )}
    </div>
  );
}
