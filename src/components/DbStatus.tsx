import { Clock, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { dbHealth, recoverDb } from '../lib/db';
import type { DbHealth } from '../lib/dbHealth';

export function useDbHealth(): DbHealth {
  return useSyncExternalStore(dbHealth.subscribe, dbHealth.getSnapshot, dbHealth.getSnapshot);
}

const reload = () => location.reload();

/** How long a screen waits before showing its loading state, when storage is working. */
const LOADING_DELAY_MS = 300;

interface Props {
  /** Shown in the save sheet: the copy is about saving. */
  inSheet?: boolean;
  /** What Reload does (the save sheet keeps its draft). */
  onReload?: () => void;
}

/**
 * Explains a database that is slow to open, stuck, blocked or lost, with a way out. Renders nothing while it
 * works, so it can sit at the top of any screen (and in the save sheet, which covers the screen's banner).
 */
export function DbStatus({ inSheet = false, onReload = reload }: Props) {
  const { status, lastError, recovering } = useDbHealth();
  // The problem Try again was tapped on: its banner and buttons stay up while the retry runs.
  const [retrying, setRetrying] = useState<'lost' | 'stuck' | null>(null);
  const busy = retrying !== null || recovering;

  const retry = async () => {
    setRetrying(status === 'lost' ? 'lost' : 'stuck');
    try {
      await recoverDb('Try again tapped');
    } catch {
      // The status says what happened.
    } finally {
      setRetrying(null);
    }
  };

  const reloadBtn = (
    <button type="button" className="btn small outline" onClick={onReload}>
      <RefreshCw size={14} aria-hidden /> Reload
    </button>
  );

  if (status === 'blocked' || status === 'outdated') {
    return (
      <aside className="db-status problem" role="alert">
        <Clock size={20} aria-hidden className="db-status-icon" />
        <div className="db-status-text">
          {status === 'blocked' ? (
            <>
              <strong>Magpie is open in another tab or window</strong>
              <span>{inSheet ? 'Close it, then tap Save.' : 'Close it to continue — your saves will appear here.'}</span>
            </>
          ) : (
            <>
              <strong>Magpie was updated in another tab</strong>
              <span>{inSheet ? 'Reload to keep going — your draft stays.' : 'Reload to keep going.'}</span>
            </>
          )}
          <div className="db-status-actions">{reloadBtn}</div>
        </div>
      </aside>
    );
  }

  if (retrying || status === 'stuck' || status === 'error' || (status === 'lost' && !recovering)) {
    const lost = retrying ? retrying === 'lost' : status === 'lost';
    return (
      <aside className="db-status problem" role="alert">
        <TriangleAlert size={20} aria-hidden className="db-status-icon" />
        <div className="db-status-text">
          <strong>{lost ? 'Magpie lost touch with your saves' : "Magpie's storage isn't responding"}</strong>
          <span>
            {inSheet
              ? 'Saving may not work until it’s back. Try again, or reload — your draft stays.'
              : 'Your saves are still on this device. Try again, or reload Magpie.'}
          </span>
          {status === 'error' && lastError && <span className="db-status-detail">{lastError}</span>}
          <div className="db-status-actions">
            <button type="button" className="btn small primary" onClick={retry} disabled={busy} aria-busy={busy}>
              {busy ? <span className="spinner" aria-hidden /> : null} Try again
            </button>
            {reloadBtn}
          </div>
        </div>
      </aside>
    );
  }

  if (status === 'slow' || recovering) {
    return (
      <aside className="db-status" role="status">
        <span className="spinner db-status-icon" aria-hidden />
        <div className="db-status-text">
          <strong>Still opening your saves…</strong>
          <span>This can take a moment after Magpie has been in the background.</span>
        </div>
      </aside>
    );
  }

  return null;
}

/**
 * Whether a screen still waiting for its saves should say so. Loading normally takes a blink (on every screen
 * switch), so it waits a moment first, except while storage is still opening or having trouble.
 */
export function useShowLoading(): boolean {
  const { status } = useDbHealth();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return late || status !== 'ready';
}

/** Placeholder while a screen's saves load, so "still loading" never looks like "empty". */
export function Loading({ label = 'Loading your saves…', cards = 0 }: { label?: string; cards?: number }) {
  if (!useShowLoading()) return null;
  return (
    <div className="loading" role="status">
      <p className="loading-label">
        <span className="spinner" aria-hidden /> {label}
      </p>
      {cards > 0 && (
        <div className="grid loading-grid" aria-hidden="true">
          {Array.from({ length: cards }, (_, i) => (
            <div key={i} className="loading-card">
              <div className="loading-thumb" />
              <div className="loading-line" />
              <div className="loading-line short" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
