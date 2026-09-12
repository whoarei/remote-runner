import { emit } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

/** 与 Rust 侧 tray.rs 的监听保持一致，用于同步托盘勾选态 */
export const AUTOSTART_CHANGED_EVENT = "autostart-changed";

export async function isAutostartEnabled(): Promise<boolean> {
  return isTauri() ? isEnabled() : false;
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (enabled) await enable();
  else await disable();
  await emit(AUTOSTART_CHANGED_EVENT, enabled);
}
