import { useRef, type ReactNode } from 'react';
import { setPendingImport } from '../lib/pendingImport';
import { navigate } from '../lib/router';

interface Props {
  className?: string;
  /** Accessible name, for an icon-only button. */
  label?: string;
  children: ReactNode;
}

/** A button that picks a Magpie share file a friend sent (".magpie.json" / ".txt") and opens its preview. */
export function OpenShareFile({ className, label, children }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} aria-label={label} title={label} onClick={() => input.current?.click()}>
        {children}
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,.magpie,.txt,application/json,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setPendingImport(f);
          navigate('/import-file');
        }}
      />
    </>
  );
}
