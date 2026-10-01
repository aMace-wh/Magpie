import { useClock } from '../lib/clock';
import { timeAgo } from '../lib/format';

/** "2 minutes ago", kept current by the shared clock without redrawing what's around it. */
export function Ago({ at }: { at: number }) {
  return <>{useClock((now) => timeAgo(at, now))}</>;
}
