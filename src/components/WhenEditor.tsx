import { Check, Clock, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { When } from '../lib/types';
import {
  addDaysIso,
  formatWhen,
  nextWeekRange,
  normalizeWhen,
  toLocalIso,
  weekendRange,
  whenFromFields,
  whenToFields,
  type WhenFields,
} from '../lib/when';
import { Sheet } from './Sheet';
import './When.css';

interface Props {
  open: boolean;
  value?: When;
  /** A date found in the post (e.g. from extractWhen), offered with a "Use it" button. */
  suggestion?: When;
  /** Called with the new period, or undefined when the date is removed. The sheet then calls onClose. */
  onSave: (when: When | undefined) => void;
  onClose: () => void;
}

const sameSpan = (a: When | undefined, b: When | undefined) => !!a && !!b && a.start === b.start && (a.end ?? '') === (b.end ?? '');
const sameFields = (a: WhenFields, b: WhenFields) =>
  a.startDate === b.startDate && a.endDate === b.endDate && a.timed === b.timed && a.startTime === b.startTime && a.endTime === b.endTime;

/** Sheet for setting, changing or clearing when an event or activity happens. */
export function WhenEditor({ open, value, suggestion, onSave, onClose }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<WhenFields>(() => whenToFields(value));

  useEffect(() => {
    // Start from the saved value each time the sheet opens (or if the saved value itself changes).
    if (open) setDraft(whenToFields(value));
  }, [open, value?.start, value?.end]);

  const current = normalizeWhen(value);
  const suggested = normalizeWhen(suggestion);
  const built = whenFromFields(draft);
  // Untouched: save the value exactly as it was.
  const pristine = !!current && sameFields(draft, whenToFields(current));
  const now = new Date();
  const today = toLocalIso(now);
  const set = (patch: Partial<WhenFields>) => setDraft((d) => ({ ...d, ...patch }));

  const quickPicks: { label: string; when: When }[] = [
    { label: 'Today', when: { start: today } },
    { label: 'Tomorrow', when: { start: addDaysIso(today, 1) } },
    { label: 'This weekend', when: weekendRange(now) },
    { label: 'Next week', when: nextWeekRange(now) },
  ];

  const save = () => {
    if (pristine) {
      onSave(current);
      onClose();
      return;
    }
    if (!built.when) return;
    // Keep the phrase it was read from only while the dates still match it.
    const source = sameSpan(built.when, current) ? current?.source : sameSpan(built.when, suggested) ? suggested?.source : undefined;
    onSave(normalizeWhen({ ...built.when, source }));
    onClose();
  };

  const remove = () => {
    onSave(undefined);
    onClose();
  };

  const showSuggestion = !!suggested && !sameSpan(suggested, current);
  const usingSuggestion = showSuggestion && sameSpan(suggested, built.when);
  const showError = !!built.error && draft.startDate !== '';

  return (
    <Sheet
      open={open}
      title={current ? 'Change the date' : 'When is it?'}
      onClose={onClose}
      footer={
        <>
          <button className="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!pristine && !built.when} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="when-editor">
        {showSuggestion && suggested && (
          <div className="when-suggest">
            <Sparkles size={18} aria-hidden />
            <div className="grow">
              <div className="when-suggest-k">Found in the post</div>
              <div className="when-suggest-v">{formatWhen(suggested, now)}</div>
              {suggested.source && <div className="when-suggest-src">“{suggested.source}”</div>}
            </div>
            <button type="button" className="btn small primary" disabled={usingSuggestion} onClick={() => setDraft(whenToFields(suggested))}>
              {usingSuggestion ? (
                <>
                  <Check size={14} strokeWidth={3} /> Using it
                </>
              ) : (
                'Use it'
              )}
            </button>
          </div>
        )}

        <div className="chips wrap when-quick" role="group" aria-label="Quick picks">
          {quickPicks.map((q) => (
            <button
              key={q.label}
              type="button"
              className="chip"
              aria-pressed={draft.startDate === q.when.start && draft.endDate === (q.when.end ?? '')}
              onClick={() => set({ startDate: q.when.start, endDate: q.when.end ?? '' })}
            >
              {q.label}
            </button>
          ))}
        </div>

        <div className="when-fields">
          <div className="when-field">
            <label className="label" htmlFor={`${id}-sd`}>
              Starts
            </label>
            <input
              id={`${id}-sd`}
              className="input"
              type="date"
              value={draft.startDate}
              onChange={(e) => {
                const startDate = e.target.value;
                // Moving the start past the end drags the end along.
                set(draft.endDate && startDate && draft.endDate < startDate ? { startDate, endDate: '' } : { startDate });
              }}
            />
          </div>
          <div className="when-field">
            <div className="when-label-row">
              <label className="label" htmlFor={`${id}-ed`}>
                Ends <span className="when-optional">· optional</span>
              </label>
              {draft.endDate && (
                <button type="button" className="when-clear" aria-label="Clear end date" onClick={() => set({ endDate: '' })}>
                  Clear
                </button>
              )}
            </div>
            <input
              id={`${id}-ed`}
              className="input"
              type="date"
              min={draft.startDate || undefined}
              value={draft.endDate}
              onChange={(e) => set({ endDate: e.target.value })}
            />
          </div>
        </div>

        <div className="when-toggle">
          <Clock size={18} aria-hidden />
          <span className="grow" id={`${id}-tl`}>
            Add time
          </span>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={draft.timed}
            aria-labelledby={`${id}-tl`}
            onClick={() => set({ timed: !draft.timed })}
          />
        </div>

        {draft.timed && (
          <div className="when-fields">
            <div className="when-field">
              <label className="label" htmlFor={`${id}-st`}>
                Start time
              </label>
              <input
                id={`${id}-st`}
                className="input"
                type="time"
                value={draft.startTime}
                onChange={(e) => set({ startTime: e.target.value.slice(0, 5) })}
              />
            </div>
            <div className="when-field">
              <div className="when-label-row">
                <label className="label" htmlFor={`${id}-et`}>
                  End time <span className="when-optional">· optional</span>
                </label>
                {draft.endTime && (
                  <button type="button" className="when-clear" aria-label="Clear end time" onClick={() => set({ endTime: '' })}>
                    Clear
                  </button>
                )}
              </div>
              <input
                id={`${id}-et`}
                className="input"
                type="time"
                value={draft.endTime}
                onChange={(e) => set({ endTime: e.target.value.slice(0, 5) })}
              />
            </div>
          </div>
        )}

        <p className={`hint when-status${showError ? ' error' : ''}`} aria-live="polite">
          {showError
            ? built.error
            : built.when
              ? `Shows as ${formatWhen(built.when, now)}`
              : 'Pick a day, or a start and end for things that run a while.'}
        </p>

        {current && (
          <button type="button" className="btn small danger when-remove" onClick={remove}>
            <Trash2 size={16} /> Remove date
          </button>
        )}
      </div>
    </Sheet>
  );
}
