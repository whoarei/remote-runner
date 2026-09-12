import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { errorMessage } from "../api";
import { isAutostartEnabled, setAutostartEnabled } from "../autostart";
import { requestQuit } from "../appLifecycle";
import { dirtyTab } from "../editorDocument";
import { loadLanguagePreference, setLanguage, type LanguagePreference } from "../i18n/language";
import { useAppStore } from "../store";
import { emptyDevice, deviceLabel } from "./DeviceDialog";
import { openWorkspace } from "../workspacePicker";

interface MenuEntry {
  type?: "item" | "checkbox" | "separator";
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: MenuEntry[];
}

interface TopMenu {
  label: string;
  entries: MenuEntry[];
}

function MenuItem({ entry, close }: { entry: MenuEntry; close: () => void }) {
  const [subOpen, setSubOpen] = useState(false);

  if (entry.type === "separator") return <div className="menu-separator" role="separator" />;

  if (entry.children) {
    return (
      <div
        className="menu-submenu"
        onMouseEnter={() => setSubOpen(true)}
        onMouseLeave={() => setSubOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={subOpen}
          className="menu-item"
          disabled={entry.disabled}
        >
          <span className="menu-check" />
          <span className="menu-label">{entry.label}</span>
          <span className="menu-arrow" aria-hidden="true">▸</span>
        </button>
        {subOpen && (
          <div className="menu-dropdown menu-subdropdown" role="menu">
            {entry.children.map((child, index) => <MenuItem key={index} entry={child} close={close} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      role={entry.type === "checkbox" ? "menuitemcheckbox" : "menuitem"}
      aria-checked={entry.type === "checkbox" ? entry.checked : undefined}
      className="menu-item"
      disabled={entry.disabled}
      onClick={() => {
        close();
        entry.onSelect?.();
      }}
    >
      <span className="menu-check" aria-hidden="true">{entry.checked ? "✓" : ""}</span>
      <span className="menu-label">{entry.label}</span>
    </button>
  );
}

export function MenuBar({ onAbout, onCheckUpdate }: { onAbout: () => void; onCheckUpdate: () => void }) {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  // 本地持有偏好状态：切到「跟随系统」且解析结果不变时 changeLanguage 不触发重渲染
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() => loadLanguagePreference());
  const chooseLanguage = (preference: LanguagePreference) => {
    setLanguagePreference(preference);
    setLanguage(preference);
  };
  const barRef = useRef<HTMLDivElement>(null);
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const resetLayout = useAppStore((state) => state.resetLayout);
  const recentWorkspaces = useAppStore((state) => state.recentWorkspaces);
  const devices = useAppStore((state) => state.devices);
  const dirty = useAppStore((state) => {
    const tab = state.openTabs.find((t) => t.name === state.activeFile);
    return tab ? dirtyTab(tab) : false;
  });
  const openFile = useAppStore((state) => state.activeFile);
  const fileBusy = useAppStore((state) => state.loading || state.saving || state.starting || state.guarding);
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    void isAutostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  const toggleAutostart = () => {
    const next = !autostart;
    setAutostart(next);
    setAutostartEnabled(next).catch((error) => {
      setAutostart(!next);
      useAppStore.setState({ editorError: t("menu.autostartFailed", { message: errorMessage(error) }) });
    });
  };

  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const menus: TopMenu[] = [
    {
      label: t("menu.file"),
      entries: [
        { label: t("menu.openWorkspace"), onSelect: () => void openWorkspace() },
        {
          label: t("menu.recentWorkspaces"),
          disabled: recentWorkspaces.length === 0,
          children: recentWorkspaces.length > 0
            ? recentWorkspaces.map((dir) => ({ label: dir, onSelect: () => void openWorkspace(dir) }))
            : [{ label: t("menu.noRecent"), disabled: true }],
        },
        { type: "separator" },
        { label: t("menu.addDevice"), onSelect: () => useAppStore.getState().openDeviceDialog(emptyDevice()) },
        {
          label: t("menu.editDevice"),
          disabled: devices.length === 0,
          children: devices.length > 0
            ? devices.map((device) => ({
                label: deviceLabel(device),
                onSelect: () => useAppStore.getState().openDeviceDialog({ ...device }),
              }))
            : [{ label: t("menu.noDevices"), disabled: true }],
        },
        { type: "separator" },
        { label: t("menu.saveFile"), disabled: !dirty, onSelect: () => void useAppStore.getState().saveFile() },
        { label: t("menu.closeFile"), disabled: !openFile || fileBusy, onSelect: () => void useAppStore.getState().closeFile() },
        { type: "separator" },
        { type: "checkbox", label: t("menu.autostart"), disabled: !isTauri(), checked: autostart, onSelect: toggleAutostart },
        { type: "separator" },
        {
          label: t("menu.quit"),
          disabled: !isTauri(),
          onSelect: () => void requestQuit(),
        },
      ],
    },
    {
      label: t("menu.view"),
      entries: [
        { type: "checkbox", label: t("menu.sidebar"), checked: layout.sidebarVisible, onSelect: () => setLayout({ sidebarVisible: !layout.sidebarVisible }) },
        { type: "checkbox", label: t("menu.workspacePanel"), checked: layout.workspaceVisible, onSelect: () => setLayout({ workspaceVisible: !layout.workspaceVisible, sidebarVisible: true }) },
        { type: "checkbox", label: t("menu.historyPanel"), checked: layout.historyVisible, onSelect: () => setLayout({ historyVisible: !layout.historyVisible, sidebarVisible: true }) },
        { type: "checkbox", label: t("menu.consolePanel"), checked: layout.consoleVisible, onSelect: () => setLayout({ consoleVisible: !layout.consoleVisible }) },
        { type: "separator" },
        {
          label: t("menu.sidebarPosition"),
          children: [
            { type: "checkbox", label: t("menu.left"), checked: layout.sidebarPosition === "left", onSelect: () => setLayout({ sidebarPosition: "left" }) },
            { type: "checkbox", label: t("menu.right"), checked: layout.sidebarPosition === "right", onSelect: () => setLayout({ sidebarPosition: "right" }) },
          ],
        },
        { type: "separator" },
        {
          label: t("menu.language"),
          children: [
            { type: "checkbox", label: t("menu.followSystem"), checked: languagePreference === "system", onSelect: () => chooseLanguage("system") },
            { type: "checkbox", label: "中文", checked: languagePreference === "zh", onSelect: () => chooseLanguage("zh") },
            { type: "checkbox", label: "English", checked: languagePreference === "en", onSelect: () => chooseLanguage("en") },
          ],
        },
        { type: "separator" },
        { label: t("menu.resetLayout"), onSelect: () => resetLayout() },
      ],
    },
    {
      label: t("menu.help"),
      entries: [
        { label: t("menu.checkUpdate"), disabled: !isTauri(), onSelect: onCheckUpdate },
        { label: t("menu.about"), onSelect: onAbout },
      ],
    },
  ];

  return (
    <div className="menubar" role="menubar" aria-label={t("menu.ariaLabel")} ref={barRef}>
      {menus.map((menu, index) => (
        <div className="menubar-entry" key={menu.label}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenu === index}
            className={`menubar-title${openMenu === index ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === index ? null : index)}
            onMouseEnter={() => { if (openMenu !== null) setOpenMenu(index); }}
          >
            {menu.label}
          </button>
          {openMenu === index && (
            <div className="menu-dropdown" role="menu">
              {menu.entries.map((entry, entryIndex) => (
                <MenuItem key={entryIndex} entry={entry} close={() => setOpenMenu(null)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
