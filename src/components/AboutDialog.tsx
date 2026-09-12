import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { productName, version as buildVersion } from "../../src-tauri/tauri.conf.json";
import appIcon from "../../src-tauri/icons/128x128.png";
import { api, errorMessage, type AppUpdateInfo } from "../api";
import { installCheckedUpdate } from "../updateFlow";
import { formatDownloadProgress, updateInstallBlocker } from "../updateStatus";
import { useAppStore } from "../store";
import { useTerminalStore, terminalActive } from "../terminalStore";

const RELEASES_URL = "https://github.com/whoarei/remote-runner/releases/latest";

type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; info: AppUpdateInfo }
  | { kind: "downloading"; info: AppUpdateInfo; downloaded: number; total: number | null }
  | { kind: "verifying" }
  | { kind: "installing" }
  | { kind: "error"; message: string };

interface UpdateSectionProps {
  autoCheckNonce: number;
}

/** 检查更新 + 升级操作区。方案 A（安装形态）应用内自动升级，方案 B（portable）回退手动下载。 */
function UpdateSection({ autoCheckNonce }: UpdateSectionProps) {
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const runBlocker = useAppStore(updateInstallBlocker);
  const terminalBusy = useTerminalStore((s) => s.tabs.some(terminalActive));
  const blocker = runBlocker || (terminalBusy ? "请先关闭活动终端，再安装更新。" : null);

  const check = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase({ kind: "checking" });
    try {
      const info = await api.checkAppUpdate();
      if (mounted.current) setPhase(info ? { kind: "available", info } : { kind: "uptodate" });
    } catch (error) {
      if (mounted.current) setPhase({ kind: "error", message: errorMessage(error) });
    } finally { busyRef.current = false; }
  }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (autoCheckNonce > 0) void check();
  }, [autoCheckNonce, check]);

  const install = useCallback(async (info: AppUpdateInfo) => {
    if (busyRef.current) return;
    const blocked = updateInstallBlocker(useAppStore.getState()) || (useTerminalStore.getState().tabs.some(terminalActive) ? "请先关闭活动终端，再安装更新。" : null);
    if (blocked) { setPhase({ kind: "error", message: blocked }); return; }
    busyRef.current = true;
    try {
      await installCheckedUpdate(info, (phase) => {
        if (!mounted.current) return;
        if (phase.kind === "checking") return;
        if (phase.kind === "downloading") setPhase({ kind: "downloading", info, downloaded: phase.downloaded, total: phase.total });
        else setPhase({ kind: phase.kind });
      });
    } catch (error) {
      if (mounted.current) setPhase({ kind: "error", message: `自动升级失败，可改用手动下载：${errorMessage(error)}` });
    } finally {
      busyRef.current = false;
    }
  }, []);

  const openDownload = useCallback(() => {
    void openUrl(RELEASES_URL).catch((error) => {
      setPhase({ kind: "error", message: `无法打开浏览器：${errorMessage(error)}` });
    });
  }, []);

  const busy = phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "verifying" || phase.kind === "installing";

  return (
    <section className="about-update" aria-label="检查更新" aria-live="polite">
      <div className="about-update-row">
        <button type="button" className="primary" disabled={busy} onClick={() => void check()}>
          {phase.kind === "checking" ? "正在检查…" : "检查更新"}
        </button>
        {phase.kind === "available" && (
          <>
            {phase.info.can_auto_install && (
              <button type="button" disabled={!!blocker} onClick={() => void install(phase.info)}>下载并安装（将重启应用）</button>
            )}
            <button type="button" onClick={openDownload}>打开下载页面</button>
          </>
        )}
        {phase.kind === "error" && (
          <button type="button" onClick={openDownload}>打开下载页面</button>
        )}
      </div>
      {phase.kind === "uptodate" && <p className="about-update-status">已是最新版本。</p>}
      {phase.kind === "available" && (
        <div className="about-update-status">
          <p>
            发现新版本 {phase.info.latest_version}（当前 {phase.info.current_version}）。
            {!phase.info.can_auto_install && "未检测到受支持的安装版，请手动下载更新。"}
          </p>
          {phase.info.can_auto_install && blocker && <p className="about-update-error">{blocker}</p>}
          {phase.info.notes && <pre className="about-update-notes">{phase.info.notes}</pre>}
        </div>
      )}
      {phase.kind === "downloading" && (
        <div className="about-update-status">
          <progress value={phase.total ? phase.downloaded : undefined} max={phase.total ?? undefined} />
          <p>{formatDownloadProgress(phase.downloaded, phase.total)}</p>
        </div>
      )}
      {phase.kind === "verifying" && <p className="about-update-status">下载完成，正在验证签名…</p>}
      {phase.kind === "installing" && <p className="about-update-status">正在启动安装程序，应用将退出并在安装后重新打开…</p>}
      {phase.kind === "error" && <p className="about-update-status about-update-error">{phase.message}</p>}
    </section>
  );
}

export function AboutDialog({ dialogRef, autoCheckNonce = 0 }: { dialogRef: RefObject<HTMLDialogElement>; autoCheckNonce?: number }) {
  const [version, setVersion] = useState(buildVersion);
  const updating = useAppStore((state) => state.updating);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    // Use installed app metadata; the build config also supports browser previews.
    void getVersion().then((value) => { if (!disposed) setVersion(value); }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  return (
    <dialog ref={dialogRef} className="about-dialog" aria-labelledby="about-title" aria-describedby="about-description"
      onCancel={(event) => { if (useAppStore.getState().updating) event.preventDefault(); }}
      onClick={(event) => {
        if (useAppStore.getState().updating) return;
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          event.currentTarget.close();
        }
      }}>
      <div className="about-heading">
        <img className="about-logo" src={appIcon} alt="" width="40" height="40" />
        <div>
          <h2 id="about-title">关于 {productName}</h2>
          <p className="about-version">版本 {version}</p>
        </div>
      </div>
      <p id="about-description">用于在嵌入式 Linux 设备和本机 WSL 中运行 Python、Shell 脚本及命令的桌面工具。</p>
      <ul className="about-transports" aria-label="支持的连接方式">
        <li>SSH</li>
        <li>串口 Shell</li>
        <li>WSL</li>
      </ul>
      <p className="about-features">工作区管理 · 交互控制台 · 运行历史</p>
      {isTauri() && <UpdateSection autoCheckNonce={autoCheckNonce} />}
      <form method="dialog" className="dialog-actions">
        <button type="submit" disabled={updating} autoFocus>关闭</button>
      </form>
    </dialog>
  );
}
