import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
}

interface ToastOptions {
  /** How long it stays up, in ms. Defaults to 3 s, or 5 s with an action. */
  duration?: number;
}

type ShowToast = (message: string, action?: ToastAction, opts?: ToastOptions) => void;

const ToastContext = createContext<ShowToast>(() => {});

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

// Open sheets, innermost last. A modal <dialog> covers everything outside it and hides it from screen readers,
// so toasts are shown inside the top one while any is open.
const layers: HTMLElement[] = [];
const layerListeners = new Set<() => void>();
const emitLayers = () => layerListeners.forEach((l) => l());
const topLayer = () => layers[layers.length - 1] ?? null;

function subscribeLayers(listener: () => void) {
  layerListeners.add(listener);
  return () => layerListeners.delete(listener);
}

/** A sheet calls this while it's open, so toasts show (and are announced) above it. Returns the undo. */
export function addToastLayer(el: HTMLElement): () => void {
  layers.push(el);
  emitLayers();
  return () => {
    const i = layers.lastIndexOf(el);
    if (i >= 0) layers.splice(i, 1);
    emitLayers();
  };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback<ShowToast>(
    (message, action, opts) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-2), { id, message, action }]);
      setTimeout(() => dismiss(id), opts?.duration ?? (action ? 5000 : 3000));
    },
    [dismiss],
  );

  const value = useMemo(() => show, [show]);
  const layer = useSyncExternalStore(subscribeLayers, topLayer, () => null);

  const region = (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {layer ? createPortal(region, layer) : region}
    </ToastContext.Provider>
  );
}
