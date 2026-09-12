import { useCallback, useRef } from "react";

interface SplitHandleProps {
  /** vertical：竖直分隔条，拖拽调整宽度（x 轴）；horizontal：水平分隔条，调整高度（y 轴） */
  direction: "vertical" | "horizontal";
  /** 相对上一次事件的像素增量，符号语义由父级解释 */
  onDelta: (delta: number) => void;
  /** 双击恢复默认尺寸 */
  onReset?: () => void;
  label: string;
}

export function SplitHandle({ direction, onDelta, onReset, label }: SplitHandleProps) {
  const lastPosition = useRef(0);
  const dragging = useRef(false);

  const release = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove(`split-dragging-${direction}`);
  }, [direction]);

  return (
    <div
      className={`split-handle split-handle-${direction}`}
      role="separator"
      aria-label={label}
      aria-orientation={direction === "vertical" ? "vertical" : "horizontal"}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragging.current = true;
        lastPosition.current = direction === "vertical" ? event.clientX : event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add(`split-dragging-${direction}`);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const position = direction === "vertical" ? event.clientX : event.clientY;
        const delta = position - lastPosition.current;
        if (delta !== 0) {
          lastPosition.current = position;
          onDelta(delta);
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={() => onReset?.()}
    />
  );
}
