import { useEffect, useState } from 'react';
import { markDone } from '../lib/db';
import { TYPE_INFO, type Item } from '../lib/types';
import { Sheet } from './Sheet';
import { StarInput } from './Stars';
import { useToast } from './Toast';

/** "Did the thing" — marks an item done and optionally captures a rating + journal entry. */
export function ReviewSheet({ item, open, onClose }: { item: Item; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState('');
  const info = TYPE_INFO[item.type];

  useEffect(() => {
    if (open) {
      setRating(item.rating ?? 0);
      setReview(item.review ?? '');
    }
  }, [open, item.rating, item.review]);

  const save = async () => {
    const wasDone = item.status === 'done';
    await markDone(item.id, rating || undefined, review);
    onClose();
    toast(wasDone ? 'Journal entry updated' : `${info.done}! Added to your journal ✨`);
  };

  return (
    <Sheet
      open={open}
      title={item.status === 'done' ? 'Edit journal entry' : info.doneAction}
      onClose={onClose}
      footer={
        <button className="btn done" onClick={save}>
          {item.status === 'done' ? 'Save' : `${info.done} ✓`}
        </button>
      }
    >
      <p style={{ margin: '0 0 12px', fontWeight: 650 }}>{item.title}</p>
      <span className="label">How was it?</span>
      <StarInput value={rating} onChange={setRating} />
      <label className="label" htmlFor="review">
        Journal
      </label>
      <textarea
        id="review"
        className="textarea"
        rows={4}
        value={review}
        placeholder="What did you think? Anything to remember next time?"
        onChange={(e) => setReview(e.target.value)}
      />
      <p className="hint">Both optional — you can always add them later.</p>
    </Sheet>
  );
}
