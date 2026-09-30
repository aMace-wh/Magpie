import { MapPin, Sparkles } from 'lucide-react';
import { hostOf, sourceLabel, type Classification } from '../lib/classify';
import { ITEM_TYPES, TYPE_INFO, type ItemType } from '../lib/types';
import './DetectedInfo.css';

interface Props {
  guess: Classification;
  /** The type that will be saved (the guess, or what the user picked). */
  type: ItemType;
  onTypeChange: (t: ItemType) => void;
}

function article(t: ItemType): string {
  if (t === 'music') return '';
  return /^[aeiou]/i.test(TYPE_INFO[t].label) ? 'an' : 'a';
}

/** What Magpie thinks a save is, why it thinks so, and one-tap fixes when it guessed wrong. */
export function DetectedInfo({ guess, type, onTypeChange }: Props) {
  const isGuess = type === guess.type;
  const web = guess.url && /^https?:/i.test(guess.url) ? hostOf(guess.url) : '';
  const platform = sourceLabel(guess.source) ?? (web || undefined);
  const reasons = isGuess ? guess.reasons.slice(0, 3) : [];
  // After picking something else, the original guess becomes the first suggestion.
  const others = (isGuess ? guess.alternatives : [guess.type, ...guess.alternatives]).filter((t) => t !== type).slice(0, 3);
  const unsure = isGuess && guess.confidence === 'low';
  const a = article(type);

  return (
    <div className="detected detected-info" data-confidence={guess.confidence}>
      <div className="detected-head">
        <Sparkles size={18} color="var(--accent)" aria-hidden="true" className="detected-icon" />
        <span>Looks like{a && ` ${a}`}</span>
        <select className="select" aria-label="Type" value={type} onChange={(e) => onTypeChange(e.target.value as ItemType)}>
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_INFO[t].emoji} {TYPE_INFO[t].label}
            </option>
          ))}
        </select>
        {platform && (
          <span className="detected-from">
            from {platform}
            {guess.author && <span className="detected-author"> · {guess.author}</span>}
          </span>
        )}
        {unsure && (
          <span className="detected-unsure" title="Magpie isn't sure about this one — pick the right type">
            not sure
          </span>
        )}
        {guess.place && (
          <span className="pill" title="Location found in the link">
            <MapPin size={12} aria-hidden="true" /> located
          </span>
        )}
      </div>

      {reasons.length > 0 && (
        <ul className="detected-reasons" aria-label="Why Magpie thinks so">
          {reasons.map((r, i) => (
            <li key={`${i}-${r}`}>{r}</li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <div className="detected-alts" role="group" aria-label="Other types it could be">
          <span className="detected-or" aria-hidden="true">
            Or:
          </span>
          {others.map((t) => (
            <button
              key={t}
              type="button"
              className="chip tag"
              aria-label={`Save as ${article(t) ? `${article(t)} ` : ''}${TYPE_INFO[t].label.toLowerCase()} instead`}
              onClick={() => onTypeChange(t)}
            >
              <span aria-hidden="true">{TYPE_INFO[t].emoji}</span> {TYPE_INFO[t].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
