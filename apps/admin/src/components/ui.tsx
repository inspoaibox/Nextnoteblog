import { useEffect, useState, type ReactNode } from 'react';

/* ---------- 轻提示 ---------- */

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};
export const toast = (text: string, kind: Toast['kind'] = 'ok') => pushToast({ text, kind });

/* ---------- 确认对话框（Promise 形式） ---------- */

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}
let openConfirm: (o: ConfirmOptions) => Promise<boolean> = async () => false;
export const confirmDialog = (o: ConfirmOptions) => openConfirm(o);

export function UiHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { ...t, id }]);
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.kind === 'error' ? 5000 : 2500);
    };
    openConfirm = (o) => new Promise<boolean>((resolve) => setDialog({ ...o, resolve }));
  }, []);

  const close = (value: boolean) => {
    dialog?.resolve(value);
    setDialog(null);
  };

  return (
    <>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      {dialog && (
        <Modal title={dialog.title} onClose={() => close(false)}>
          {dialog.body && <div className="modal-body">{dialog.body}</div>}
          <div className="modal-actions">
            <button className="btn" onClick={() => close(false)}>
              {dialog.cancelText ?? '取消'}
            </button>
            <button className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`} autoFocus onClick={() => close(true)}>
              {dialog.confirmText ?? '确定'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        上一页
      </button>
      <span>
        {page} / {pages}
      </span>
      <button className="btn" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        下一页
      </button>
    </div>
  );
}

export function StatusBadge({ status, pending }: { status: string; pending?: boolean }) {
  const label: Record<string, string> = { draft: '草稿', scheduled: '定时发布', published: '已发布', unpublished: '已下线', archived: '已归档' };
  return (
    <>
      <span className={`badge badge-${status}`}>{label[status] ?? status}</span>
      {pending && <span className="badge badge-pending">有未发布修改</span>}
    </>
  );
}
