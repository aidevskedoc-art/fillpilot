// Checks and step results that show where they are when clicked: a check from
// reading the bill opens that PDF at its page; a step's result scrolls the site
// to the row or field it filled and outlines it there.

import { useEffect, useRef, useState } from 'react';
import type { BillPlace, ClaimCheck } from '../../../web/projects/shared/src/api-types';
import type { ActionResult } from '../../../web/projects/shared/src/page-contract';
import { bridge } from './page-bridge';

const DOC_TYPE: Record<BillPlace['doc'], string> = { final: 'yashoda-final-bill', summary: 'yashoda-summary-bill', pharmacy: 'yashoda-pharmacy-bill' };

export interface BillPdfs {
  /** Keeps the files that were read as the final and the summary bill (the ones before are let go). */
  hold(files: File[], documents: { fileName: string; docType: string | null }[]): void;
  /** Opens the bill in a new tab at the page. → false when the panel no longer has it. */
  open(at: BillPlace): boolean;
  release(): void;
}

/**
 * The bill PDFs chosen in this panel, kept in its memory only, so a check can
 * open them — never written anywhere. They go when the panel closes, the bill
 * is cleared or other PDFs are chosen; a bill restored from the browser
 * session has none until its PDFs are chosen again.
 */
export function useBillPdfs(): BillPdfs {
  const held = useRef(new Map<string, File>());
  const urls = useRef(new Map<File, string>());
  const release = () => {
    for (const url of urls.current.values()) URL.revokeObjectURL(url);
    urls.current.clear();
    held.current.clear();
  };
  useEffect(() => release, []); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    hold(files, documents) {
      release();
      for (const d of documents) {
        const file = files.find((f) => f.name === d.fileName);
        if (file && d.docType) held.current.set(d.docType, file);
      }
    },
    open(at) {
      const file = held.current.get(DOC_TYPE[at.doc]);
      if (!file) return false;
      let url = urls.current.get(file);
      if (!url) {
        // Typed as a PDF, so Chrome shows it rather than downloading it (a chosen file can come without a type).
        url = URL.createObjectURL(new Blob([file], { type: 'application/pdf' }));
        urls.current.set(file, url);
      }
      // Chrome's PDF viewer opens at #page=N.
      const target = at.page ? `${url}#page=${at.page}` : url;
      if (!window.open(target, '_blank')) void chrome.tabs.create({ url: target });
      return true;
    },
    release,
  };
}

const ICON = { error: '✗', warning: '⚠', info: 'ℹ' } as const;
const TONE = { error: ' bad', warning: '', info: ' muted' } as const;

/**
 * The checks from reading the bills: errors, then warnings; lines that are only
 * information are folded away (the client, 2026-11-13: too many coloured lines
 * confused the staff). Those with a place on the bill open it there.
 * elsewhere: how many more are said under the tab they are about (TGNPDCL's review lists).
 */
export function BillChecks({ checks, pdfs, elsewhere = 0 }: { checks: ClaimCheck[]; pdfs: BillPdfs; elsewhere?: number }) {
  /** The check whose PDF the panel no longer has — it says so under that line. */
  const [notHeld, setNotHeld] = useState<string | null>(null);
  const main = [...checks.filter((c) => c.level === 'error'), ...checks.filter((c) => c.level === 'warning')];
  const info = checks.filter((c) => c.level === 'info');
  const line = (c: ClaimCheck) => {
    const text = `${ICON[c.level]} ${c.message}`;
    const className = `warn-line${TONE[c.level]}`;
    const at = c.at;
    if (!at) return <div key={c.message} className={className}>{text}</div>;
    const where = `the ${at.doc} bill${at.page ? ` at page ${at.page}` : ''}`;
    return (
      <div key={c.message}>
        <button type="button" className={`${className} goto`} title={`Open ${where}`} onClick={() => setNotHeld(pdfs.open(at) ? null : c.message)}>
          {text}<span className="goto-tag">{at.page ? `p. ${at.page}` : `${at.doc} bill`} ↗</span>
        </button>
        {notHeld === c.message && (
          <div className="warn-line muted">The PDF is no longer open in this panel — choose the bill PDFs again with "Other PDFs" to open it from here.</div>
        )}
      </div>
    );
  };
  return (
    <div className="mt-sm">
      <div className="review-legend">
        From reading the bills · <span className="bad">✗ red</span> = check the bill before filling · <span className="warn-text">⚠ amber</span> = worth a look · a line with ↗ opens the bill at that page
      </div>
      {main.map(line)}
      {elsewhere > 0 && (
        <div className="warn-line muted">
          {elsewhere} more {elsewhere === 1 ? 'is' : 'are'} about one item or tab — {elsewhere === 1 ? 'it is' : 'they are'} on that tab's "To review" list below, on the item's card.
        </div>
      )}
      {info.length > 0 && (
        <details className="preview mt-sm">
          <summary>{info.length} note(s) for information</summary>
          {info.map(line)}
        </details>
      )}
    </div>
  );
}

/** One step's result. One with a place on the page scrolls the site there and outlines it. */
export function ResultLine({ result: r, tabId }: { result: ActionResult; tabId: number }) {
  const [gone, setGone] = useState(false);
  const className = `small ${r.ok ? (r.warn ? 'warn-text' : '') : 'bad'}`;
  const text = `${r.ok ? (r.warn ? '⚠' : '✓') : '✗'} ${r.label}${r.ok && !r.warn ? '' : ` — ${r.message}`}`;
  const spot = r.spot;
  if (!spot) return <div className={className}>{text}</div>;
  const show = async () => setGone(!(await bridge.show(tabId, spot).catch(() => false)));
  return (
    <>
      <button type="button" className={`${className} goto`} title="Show it on the page" onClick={show}>{text}</button>
      {gone && <div className="small muted">Not on the page now — open the tab or section it was filled on, then click it again.</div>}
    </>
  );
}
