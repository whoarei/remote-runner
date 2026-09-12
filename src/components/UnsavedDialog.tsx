import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store";
import { ChangeChoice } from "../editorDocument";

export function UnsavedDialog() {
  const { t } = useTranslation();
  const prompt = useAppStore((s) => s.changePrompt);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (prompt) dialog.current?.showModal();
    else dialog.current?.close();
  }, [prompt]);
  const choose = (choice: ChangeChoice) => prompt?.resolve(choice);
  return <dialog className="unsaved-dialog" ref={dialog} aria-labelledby="unsaved-title"
    onCancel={(event) => { event.preventDefault(); choose("cancel"); }}>
    <h3 id="unsaved-title">{t("unsaved.title")}</h3>
    <p>{prompt ? t("unsaved.message", { name: prompt.name }) : null}</p>
    <div className="dialog-actions">
      <button onClick={() => choose("cancel")} autoFocus>{t("dialog.cancel")}</button>
      <button onClick={() => choose("discard")}>{t("unsaved.discard")}</button>
      <button className="primary" onClick={() => choose("save")}>{t("unsaved.save")}</button>
    </div>
  </dialog>;
}
