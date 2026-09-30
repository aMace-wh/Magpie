import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  onSave: (value: string) => void;
  className?: string;
  placeholder?: string;
  label: string;
  /** Enter inserts a newline instead of committing. */
  multiline?: boolean;
}

/** An auto-growing textarea that saves on blur, and follows outside changes while not being edited. */
export function EditableText({ value, onSave, className, placeholder, label, multiline }: Props) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft]);

  return (
    <textarea
      ref={ref}
      className={className}
      aria-label={label}
      rows={1}
      value={draft}
      placeholder={placeholder}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setDraft(multiline ? e.target.value : e.target.value.replace(/\n/g, ' '))}
      onKeyDown={(e) => {
        if (!multiline && e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        editing.current = false;
        if (draft !== value) onSave(draft);
      }}
    />
  );
}
