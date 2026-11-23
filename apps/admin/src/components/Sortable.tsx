import { useRef, useState, type DragEvent } from 'react';

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * 拖拽排序：把返回的属性展开到每一行上。
 * 同时应提供“上移 / 下移”按钮，保证键盘和触屏也能调整顺序。
 */
export function useDragSort(onMove: (from: number, to: number) => void) {
  const from = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  return (index: number) => ({
    draggable: true,
    'data-over': over === index && from.current !== index ? true : undefined,
    onDragStart: (e: DragEvent) => {
      from.current = index;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    },
    onDragOver: (e: DragEvent) => {
      if (from.current == null) return;
      e.preventDefault();
      setOver(index);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (from.current != null && from.current !== index) onMove(from.current, index);
      from.current = null;
      setOver(null);
    },
    onDragEnd: () => {
      from.current = null;
      setOver(null);
    },
  });
}

export function MoveButtons({ index, count, onMove }: { index: number; count: number; onMove: (from: number, to: number) => void }) {
  return (
    <span className="move-btns">
      <button type="button" className="icon-btn" disabled={index === 0} onClick={() => onMove(index, index - 1)} aria-label="上移" title="上移">
        ↑
      </button>
      <button type="button" className="icon-btn" disabled={index === count - 1} onClick={() => onMove(index, index + 1)} aria-label="下移" title="下移">
        ↓
      </button>
    </span>
  );
}
