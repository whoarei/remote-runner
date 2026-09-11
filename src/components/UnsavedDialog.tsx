import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { ChangeChoice } from "../editorDocument";

export function UnsavedDialog() {
  const prompt = useAppStore((s) => s.changePrompt);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (prompt) dialog.current?.showModal();
    else dialog.current?.close();
  }, [prompt]);
  const choose = (choice: ChangeChoice) => prompt?.resolve(choice);
  return <dialog className="unsaved-dialog" ref={dialog} aria-labelledby="unsaved-title"
    onCancel={(event) => { event.preventDefault(); choose("cancel"); }}>
    <h3 id="unsaved-title">保存未保存的修改？</h3>
    <p>{prompt?.name} 有未保存的修改。</p>
    <div className="dialog-actions">
      <button onClick={() => choose("cancel")} autoFocus>取消</button>
      <button onClick={() => choose("discard")}>放弃修改并继续</button>
      <button className="primary" onClick={() => choose("save")}>保存并继续</button>
    </div>
  </dialog>;
}
