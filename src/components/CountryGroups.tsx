import { ChevronDown } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { groupByCountry, groupSummary, OTHER_CITY, placeLabel, type CountryGroup } from '../lib/location';
import { navigate } from '../lib/router';
import { TYPE_INFO, type Item } from '../lib/types';
import { ThumbSmall } from './Thumb';
import './CountryGroups.css';

interface Props {
  items: Item[];
  emptyText?: string;
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The "where" line of a row: the venue name (when it isn't the title), plus what's known of the place outside a country group. */
function whereText(item: Item, known: boolean): string {
  const place = item.place;
  if (!place) return '';
  const parts: string[] = [];
  const venue = place.name?.trim();
  if (venue && !sameText(venue, item.title)) parts.push(venue);
  if (!known) parts.push(placeLabel(place));
  return parts.filter(Boolean).join(' · ');
}

function Row({ item, known }: { item: Item; known: boolean }) {
  const info = TYPE_INFO[item.type] ?? TYPE_INFO.link;
  const done = item.status === 'done';
  const where = whereText(item, known);
  return (
    <li>
      <button type="button" className="list-row" onClick={() => navigate(`/item/${encodeURIComponent(item.id)}`)}>
        <ThumbSmall item={item} />
        <div className="grow">
          <div className="t">{item.title || 'Untitled'}</div>
          <div className="cg-sub">
            <span className={done ? 'pill done' : 'pill'}>{done ? info.done : info.todo}</span>
            {where && <span className="cg-where">{where}</span>}
          </div>
        </div>
      </button>
    </li>
  );
}

function Group({ group, open, onToggle, id }: { group: CountryGroup; open: boolean; onToggle: () => void; id: string }) {
  const known = !!group.code;
  // City sub-headers only when they tell you something.
  const showCities = group.cities.length > 1 || (group.cities.length === 1 && group.cities[0].name !== OTHER_CITY);
  const count = group.items.length;
  return (
    <section className="cg-group" aria-labelledby={`${id}-head`}>
      <h3 className="cg-heading">
        <button
          type="button"
          className="cg-head"
          id={`${id}-head`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={onToggle}
        >
          <span className="cg-flag" aria-hidden="true">
            {group.flag}
          </span>
          <span className="cg-title">
            <span className="cg-name">{group.name}</span>
            <span className="cg-counts">{groupSummary(group.items)}</span>
          </span>
          <span className="cg-total">
            <span aria-hidden="true">{count}</span>
            <span className="sr-only">
              , {count} {count === 1 ? 'save' : 'saves'}
            </span>
          </span>
          <ChevronDown size={18} className="cg-chevron" aria-hidden="true" />
        </button>
      </h3>
      <div className="cg-body" id={`${id}-body`} hidden={!open}>
        {open &&
          (showCities ? (
            group.cities.map((city, i) => (
              <div key={`${i}:${city.name}`}>
                <h4 className="cg-city">
                  <span className="cg-city-name">{city.name}</span>
                  <span className="cg-city-count">{city.items.length}</span>
                </h4>
                <ul className="list cg-list">
                  {city.items.map((item) => (
                    <Row key={item.id} item={item} known={known} />
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <ul className="list cg-list">
              {group.items.map((item) => (
                <Row key={item.id} item={item} known={known} />
              ))}
            </ul>
          ))}
      </div>
    </section>
  );
}

/** Saves with a location, grouped by country and city. Countries start expanded when there are only a few. */
export function CountryGroups({ items, emptyText }: Props) {
  const groups = useMemo(() => groupByCountry(items), [items]);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const baseId = useId();

  if (!groups.length) {
    return (
      <div className="empty cg-empty">
        <div className="emoji" aria-hidden="true">
          🗺️
        </div>
        <p>{emptyText ?? 'Nothing with a location yet. Add one to any save and it shows up here, sorted by country.'}</p>
      </div>
    );
  }

  const expandByDefault = groups.length <= 3;
  return (
    <div className="cg">
      {groups.map((g) => {
        const key = g.code ?? 'elsewhere';
        const open = toggled[key] ?? expandByDefault;
        return (
          <Group
            key={key}
            group={g}
            open={open}
            id={`${baseId}-${key}`}
            onToggle={() => setToggled((t) => ({ ...t, [key]: !open }))}
          />
        );
      })}
    </div>
  );
}
