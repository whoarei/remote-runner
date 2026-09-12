import { useEffect, useRef } from "react";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** 危险操作（如删除）使用红色按钮 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 通用确认对话框：由调用方持有请求状态，取消 / Esc / 关闭按钮走同一回调。 */
export function ConfirmDialog({ request }: { request: ConfirmRequest | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request) {
      // showModal throws when already open, and re-renders reuse the same element.
      if (!element.open) element.showModal();
      cancel.current?.focus();
    } else if (element.open) {
      element.close();
    }
  }, [request]);
  const close = () => request?.onCancel();
  return (
    <dialog
      className="confirm-dialog"
      ref={dialog}
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h3 id="confirm-title">{request?.title}</h3>
      <p>{request?.message}</p>
      <div className="dialog-actions">
        <button ref={cancel} onClick={close}>取消</button>
        <button className={request?.danger ? "danger" : "primary"} onClick={() => request?.onConfirm()}>
          {request?.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
