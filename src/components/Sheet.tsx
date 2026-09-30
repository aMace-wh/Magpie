import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { addToastLayer } from './Toast';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Bottom sheet on phones, centred dialog on larger screens. Built on <dialog> for focus + Esc handling. */
export function Sheet({ open, title, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // React's autoFocus runs before the dialog is open (so focus would land on Close): focus the intended field now.
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => (open && ref.current ? addToastLayer(ref.current) : undefined), [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Clicking the backdrop (the dialog element itself) closes it.
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="sheet-head">
            <h2>{title}</h2>
            <button className="icon-btn ghost" onClick={onClose} aria-label="Close">
              <X size={20} />
            </button>
          </div>
          <div className="sheet-body">{children}</div>
          {footer && <div className="sheet-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
