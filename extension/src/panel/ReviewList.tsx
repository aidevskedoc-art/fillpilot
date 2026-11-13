// The review list: one card for each thing the person must enter (red) or check
// (amber) — on the site or on the bill — with what to do in one sentence, and buttons to see it
// on the site, on the bill, or — for "enter" — a popup with what to type.
// Ticked cards fold to one line; the ready bar counts what is left.

import { useEffect, useRef, useState } from 'react';
import type { BillPdfs } from './CheckList';
import { CheckIcon } from './Icons';
import { bridge } from './page-bridge';
import type { ReviewItem } from './tgnpdcl-review';

const KIND = { enter: 'Enter yourself', check: 'Check' } as const;

function ReviewCard({ item, done, onToggle, onOpen, tabId, pdfs }: {
  item: ReviewItem; done: boolean; onToggle: () => void; onOpen: () => void; tabId: number; pdfs: BillPdfs;
}) {
  const [note, setNote] = useState('');
  const show = async () => {
    if (!item.spot) return;
    const found = await bridge.show(tabId, item.spot).catch(() => false);
    setNote(found ? '' : 'Not on the page now — open the tab it is on, then click "Show on site" again.');
  };
  const openBill = () => {
    if (item.at) setNote(pdfs.open(item.at) ? '' : 'The bill PDF is no longer open in this panel — choose the PDFs again to open it from here.');
  };
  return (
    <div className={`review ${item.level}${done ? ' done' : ''}`}>
      <div className="review-head">
        <span className="review-kind">{done ? 'Done' : KIND[item.level]}</span>
        <div className="review-title">{item.title}</div>
        <button
          type="button" className="review-tick" aria-pressed={done} onClick={onToggle}
          title={done ? 'Mark as not done' : 'Mark as done'} aria-label={done ? `Mark "${item.title}" as not done` : `Mark "${item.title}" as done`}
        >
          <CheckIcon size={12} />
        </button>
      </div>
      {!done && (
        <>
          {item.facts && <div className="review-facts">{item.facts}</div>}
          <div className="review-todo">{item.todo}</div>
          <div className="review-actions">
            {item.spot && <button type="button" className="btn btn-secondary btn-xs" onClick={show}>Show on site</button>}
            {(item.how?.length || item.why.length > 0) && (
              <button type="button" className="btn btn-secondary btn-xs" onClick={onOpen}>{item.how?.length ? 'What to enter' : 'Details'}</button>
            )}
            {item.at && <button type="button" className="btn btn-secondary btn-xs" onClick={openBill}>Bill page {item.at.page} ↗</button>}
          </div>
          {note && <div className="small muted mt-sm">{note}</div>}
        </>
      )}
    </div>
  );
}

/** The popup: the item as the bill has it, what to type on the site (each value copied with one click), and why. */
function ReviewPopup({ item, done, onToggle, onClose, tabId, pdfs }: {
  item: ReviewItem; done: boolean; onToggle: () => void; onClose: () => void; tabId: number; pdfs: BillPdfs;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState('');
  const [note, setNote] = useState('');
  // Focus goes to the popup once, when it opens.
  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied('');
    }
  };
  const show = async () => {
    if (!item.spot) return;
    const found = await bridge.show(tabId, item.spot).catch(() => false);
    setNote(found ? '' : 'Not on the page now — open the tab it is on first.');
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal review-modal ${item.level}`} role="dialog" aria-modal="true" aria-labelledby="review-modal-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="review-kind">{KIND[item.level]}</span>
          <div id="review-modal-title" className="modal-title">{item.title}</div>
          <button ref={close} type="button" className="btn btn-text btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {item.facts && <div className="review-facts">{item.facts}</div>}

        <div className="modal-section">
          <div className="modal-label">What to do</div>
          <div className="small">{item.todo}</div>
        </div>

        {item.how && item.how.length > 0 && (
          <div className="modal-section">
            <div className="modal-label">Enter on the site</div>
            {item.how.map((h) => (
              <div key={h.label} className="how-line">
                <span className="muted">{h.label}</span>
                <span className="how-value">{h.value}</span>
                <button type="button" className="btn btn-text btn-xs" onClick={() => copy(h.label, h.value)}>{copied === h.label ? 'Copied' : 'Copy'}</button>
              </div>
            ))}
          </div>
        )}

        {item.why.length > 0 && (
          <div className="modal-section">
            <div className="modal-label">Why</div>
            {item.why.map((w) => <div key={w} className="small muted">{w}</div>)}
          </div>
        )}

        <div className="review-actions mt">
          {item.spot && <button type="button" className="btn btn-secondary btn-xs" onClick={show}>Show on site</button>}
          {item.at && (
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => setNote(item.at && pdfs.open(item.at) ? '' : 'The bill PDF is no longer open in this panel.')}>
              Bill page {item.at.page} ↗
            </button>
          )}
          <button type="button" className="btn btn-primary btn-xs" onClick={() => { onToggle(); onClose(); }}>
            <CheckIcon size={12} /> {done ? 'Mark as not done' : 'Done'}
          </button>
        </div>
        {note && <div className="small muted mt-sm">{note}</div>}
      </div>
    </div>
  );
}

/** One tab's list. Nothing at all when the tab leaves nothing to do. */
export function ReviewList({ items, done, onToggle, tabId, pdfs }: {
  items: ReviewItem[]; done: Set<string>; onToggle: (key: string) => void; tabId: number; pdfs: BillPdfs;
}) {
  const [open, setOpen] = useState<ReviewItem | null>(null);
  if (!items.length) return null;
  const left = items.filter((i) => !done.has(i.key));
  return (
    <div className="review-list">
      <div className="review-legend">
        To review: {left.length ? `${left.length} left` : 'all done'} · <span className="bad">red</span> = enter it yourself · <span className="warn-text">amber</span> = check it against the bill
      </div>
      {items.map((item) => (
        <ReviewCard
          key={item.key} item={item} done={done.has(item.key)} onToggle={() => onToggle(item.key)} onOpen={() => setOpen(item)} tabId={tabId} pdfs={pdfs}
        />
      ))}
      {open && <ReviewPopup item={open} done={done.has(open.key)} onToggle={() => onToggle(open.key)} onClose={() => setOpen(null)} tabId={tabId} pdfs={pdfs} />}
    </div>
  );
}

/** Under the tabs: how much is left, and when every tab is filled and every card ticked, that the bill is ready. */
export function ReadyBar({ items, done, filled, total }: { items: ReviewItem[]; done: Set<string>; filled: number; total: number }) {
  const left = items.filter((i) => !done.has(i.key));
  const enter = left.filter((i) => i.level === 'enter').length;
  const check = left.length - enter;
  const allFilled = filled >= total;
  if (allFilled && !left.length) {
    return <div className="ready clear"><CheckIcon size={14} /> All tabs filled and reviewed — check the totals, then Save on the site yourself.</div>;
  }
  const parts = [
    ...(enter ? [`${enter} to enter yourself`] : []),
    ...(check ? [`${check} to check`] : []),
    ...(!allFilled ? [`${total - filled} tab(s) not filled yet`] : []),
  ];
  return <div className={`ready ${left.length ? 'todo' : 'idle'}`}>{parts.join(' · ')}</div>;
}
