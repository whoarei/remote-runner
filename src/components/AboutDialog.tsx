import { useEffect, useState, type RefObject } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { productName, version as buildVersion } from "../../src-tauri/tauri.conf.json";
import appIcon from "../../src-tauri/icons/128x128.png";

export function AboutDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement> }) {
  const [version, setVersion] = useState(buildVersion);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    // Use installed app metadata; the build config also supports browser previews.
    void getVersion().then((value) => { if (!disposed) setVersion(value); }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  return (
    <dialog ref={dialogRef} className="about-dialog" aria-labelledby="about-title" aria-describedby="about-description"
      onClick={(event) => {
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
      <form method="dialog" className="dialog-actions">
        <button type="submit" className="primary" autoFocus>关闭</button>
      </form>
    </dialog>
  );
}
