import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { Stars } from '../components/Stars';
import { ThumbSmall } from '../components/Thumb';
import { db } from '../lib/db';
import { dayLabel, monthLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { TYPE_INFO, type Item } from '../lib/types';

export function JournalScreen() {
  const done = useLiveQuery(() => db.items.where('status').equals('done').toArray(), []);

  const { groups, stats, taste } = useMemo(() => {
    const list = [...(done ?? [])].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
    const groups: { label: string; items: Item[] }[] = [];
    for (const item of list) {
      const label = monthLabel(item.doneAt ?? item.updatedAt);
      const g = groups[groups.length - 1];
      if (g?.label === label) g.items.push(item);
      else groups.push({ label, items: [item] });
    }
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const rated = list.filter((i) => i.rating);
    const stats = {
      total: list.length,
      month: list.filter((i) => (i.doneAt ?? 0) >= monthStart.getTime()).length,
      avg: rated.length ? rated.reduce((s, i) => s + i.rating!, 0) / rated.length : 0,
    };
    // "Your taste": tags that show up most on things you loved.
    const counts = new Map<string, number>();
    for (const i of rated) if (i.rating! >= 4) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const taste = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { groups, stats, taste };
  }, [done]);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Journal</h1>
      </header>

      {done?.length === 0 ? (
        <div className="empty">
          <div className="emoji">📔</div>
          <h2>Your journal starts here</h2>
          <p>When you cook the recipe, visit the place or watch the video, mark it done. Add a rating and a few words and it lands here.</p>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <b>{stats.total}</b>
              <span>things done</span>
            </div>
            <div className="stat">
              <b>{stats.month}</b>
              <span>this month</span>
            </div>
            <div className="stat">
              <b>{stats.avg ? stats.avg.toFixed(1) : '–'}</b>
              <span>avg rating</span>
            </div>
          </div>

          {taste.length > 0 && (
            <>
              <h2 className="section-title">What you love</h2>
              <div className="chips wrap">
                {taste.map(([t, n]) => (
                  <span key={t} className="chip tag">
                    #{t} <span className="count">{n}</span>
                  </span>
                ))}
              </div>
            </>
          )}

          {groups.map((g) => (
            <section key={g.label}>
              <h2 className="section-title">{g.label}</h2>
              <div className="timeline">
                {g.items.map((item) => (
                  <button key={item.id} className="entry" onClick={() => navigate(`/item/${item.id}`)}>
                    <ThumbSmall item={item} />
                    <div className="grow">
                      <div className="verb">
                        {TYPE_INFO[item.type].emoji} {TYPE_INFO[item.type].done} · {dayLabel(item.doneAt ?? item.updatedAt)}
                      </div>
                      <div className="t">{item.title}</div>
                      {item.rating ? <Stars value={item.rating} /> : null}
                      {item.review && <p className="r">{item.review}</p>}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
