// BHEL mode (KareXpert, bhel.karexpert.com): choose the patient's Yashoda bill
// PDFs (final + summary), confirm the Upload Bill screen open on the site is that
// patient, then fill it — Visit ID, Bill No, the three dates, and one Bill Details
// row per Service Type with the bill's total for it. The extension never presses
// Draft or Accept, and leaves Payment Details, documents and Diagnosis alone.
//
// Like the other bill modes, the bill is read on the server and handed back,
// and lives in this browser session (bill-session.ts) only until it is cleared.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { BhelClaim } from '../../../web/projects/shared/src/api-types';
import type { ActionResult } from '../../../web/projects/shared/src/page-contract';
import { api, messageOf } from './api';
import { bhelSession } from './bill-session';
import { BillChecks, ResultLine, useBillPdfs } from './CheckList';
import { BoltIcon, CheckIcon, ShieldIcon, StopIcon, UploadIcon } from './Icons';
import { ActiveTab, bridge } from './page-bridge';
import { BHEL_PROBES, bhelAuditLabel, buildBhelActions } from './bhel-plan';

const KIND: Record<string, string> = {
  'yashoda-final-bill': 'final bill',
  'yashoda-summary-bill': 'summary bill',
  'yashoda-pharmacy-bill': 'pharmacy bill (not needed here)',
};
/** The first rows all failing means the page is not what the profile expects — no point going on. */
const PROBE = 3;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

export function BhelView({ tab, onError }: { tab: ActiveTab; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [claim, setClaim] = useState<BhelClaim | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [results, setResults] = useState<ActionResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ended, setEnded] = useState('');
  const [showChecks, setShowChecks] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState('');
  /** How many steps this fill runs — fixed at the start, for the progress bar. */
  const [total, setTotal] = useState(0);
  const stopRequested = useRef(false);
  /** The PDFs just read — a check opens the bill at its page. */
  const pdfs = useBillPdfs();

  useEffect(() => {
    bhelSession.load().then(setClaim).catch(() => undefined);
  }, []);

  // The site does not print the IP number on this screen: the person confirms the patient, again on every page.
  const pageKey = `${tab.tabId} ${tab.url?.href ?? ''}`;
  useEffect(() => {
    setConfirmed(false);
  }, [claim, pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useMemo(() => (claim ? buildBhelActions(claim) : []), [claim]);
  const billIp = claim?.patient.ipNo ?? claim?.visitId ?? null;
  const canFill = Boolean(claim) && confirmed;

  async function read(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) {
      if (list?.length) setNote('Choose PDF files — the final bill and the summary bill.');
      return;
    }
    if (reading !== null || running) return;
    setNote('');
    setReading(0);
    const started = Date.now();
    const timer = window.setInterval(() => setReading(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const fresh = await api.readBhelBills(files);
      await bhelSession.save(fresh);
      pdfs.hold(files, fresh.documents);
      setClaim(fresh);
      setResults(null);
      setEnded('');
      setConfirmed(false);
      const unread = fresh.documents.filter((d) => d.error).map((d) => `${d.fileName}: ${d.error}`);
      const summary = fresh.documents.some((d) => d.docType === 'yashoda-summary-bill');
      setNote([
        ...unread,
        ...(summary ? [] : ['Only the final bill was read. Choose the final and the summary bill together — Bill No and the dates come from the summary bill.']),
      ].join(' '));
    } catch (err) {
      onError(messageOf(err));
    } finally {
      window.clearInterval(timer);
      setReading(null);
      if (input.current) input.current.value = '';
    }
  }

  async function clear() {
    await bhelSession.clear().catch(() => undefined);
    pdfs.release();
    setClaim(null);
    setResults(null);
    setEnded('');
    setConfirmed(false);
    setNote('The bill has been cleared from this browser.');
  }

  /**
   * Runs the steps one at a time, so each shows as it is done and Stop takes
   * effect between them. A Service Type already in the table is not added
   * again, so Fill again carries on where a fill stopped.
   */
  async function fill() {
    if (running || !claim) return;
    stopRequested.current = false;
    setTotal(actions.length);
    setRunning(true);
    setEnded('');
    const done: ActionResult[] = [];
    setResults([]);
    let why = '';
    try {
      for (let i = 0; i < actions.length; i++) {
        if (stopRequested.current) {
          why = `Stopped by you after ${done.length} of ${actions.length}. Press Fill again to carry on — Service Types already in the table are not added twice.`;
          break;
        }
        let result: ActionResult | undefined;
        try {
          [result] = await bridge.runActions(tab.tabId, [actions[i]]);
        } catch {
          result = undefined;
        }
        if (!result) {
          why = 'The page did not answer — it may have reloaded. Open the Upload Bill screen again and press Fill again; rows already entered are not added twice.';
          break;
        }
        done.push({ ...result, index: i });
        setResults([...done]);
        if (result.stopped) {
          why = 'Stopped: the page is not as expected (see the message above). Its layout has been saved for the developer.';
          break;
        }
        const rows = done.filter((r) => actions[r.index]?.type === 'addBhelRow');
        if (rows.length === PROBE && rows.every((r) => !r.ok)) {
          why = `The first ${PROBE} rows could not be added, so the rest were not tried. The reasons are saved for the developer.`;
          break;
        }
      }
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setEnded(why);
      setRunning(false);
      await recordAudit(done);
    }
  }

  /** Activity log: which steps ran and how each went, and on any failure the page's structure — never the bill's contents. */
  async function recordAudit(done: ActionResult[]) {
    if (!tab.url || !done.length) return;
    const failed = done.some((r) => !r.ok);
    const pageOutline = failed ? await bridge.describePage(tab.tabId, BHEL_PROBES).catch(() => null) : null;
    await api
      .recordFill({
        documentIds: [],
        origin: tab.url.origin,
        path: tab.url.pathname,
        formTitle: 'BHEL Upload Bill',
        detected: done.length,
        autoMatched: done.length,
        fields: done.map((r) => ({
          label: (actions[r.index] ? bhelAuditLabel(actions[r.index]) : 'Upload Bill').slice(0, 120),
          fieldKey: 'upload-bill',
          confidence: null,
          source: 'profile',
          outcome: r.ok ? 'filled' : 'failed',
          message: r.ok && !r.warn ? null : r.message.slice(0, 1500),
        })),
        pageOutline,
      })
      .catch(() => undefined);
  }

  async function copyStructure() {
    try {
      const outline = await bridge.describePage(tab.tabId, BHEL_PROBES);
      await navigator.clipboard.writeText(JSON.stringify(outline, null, 2));
      setCopied('Page structure copied. Paste it to the developer. It has the labels, buttons and lists of this page, not what is typed in the fields. '
        + 'Read it before sending: dropdowns and clickable lists are copied as the page shows them, so remove any patient names or numbers.');
    } catch (err) {
      onError(messageOf(err));
    }
  }

  const errors = claim?.checks.filter((c) => c.level === 'error') ?? [];
  const warnings = claim?.checks.filter((c) => c.level !== 'error') ?? [];
  const checksOpen = showChecks ?? errors.length > 0;
  const isReading = reading !== null;
  const failed = results?.filter((r) => !r.ok).length ?? 0;
  const toCheck = results?.filter((r) => r.ok && r.warn).length ?? 0;
  const drop = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); read(e.dataTransfer.files); },
  };

  return (
    <>
      <section className="section">
        <div className="label">Upload Bill · BHEL</div>
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => read(e.target.files)} />

        {!claim && (
          <button type="button" className={`dropzone${over ? ' over' : ''}`} disabled={isReading} onClick={() => input.current?.click()} {...drop}>
            <span className="drop-icon"><UploadIcon size={18} /></span>
            <span className="strong">{reading !== null ? `Reading the bills… ${clock(reading)}` : 'Drop the bill PDFs here'}</span>
            <span className="muted small">{isReading ? 'Scanned pages are read one by one — usually well under a minute.' : 'Final bill + summary bill, or click to choose them'}</span>
          </button>
        )}

        {claim && (
          <div className="card bill" {...drop}>
            <div className="bill-name truncate">{claim.patient.name}</div>
            <div className="chips">
              <span className="chip">IP {billIp ?? '?'}</span>
              <span className="chip">Bill {claim.billNo ?? '?'}</span>
              <span className="chip">{rupees(claim.totals.netAmount ?? claim.totals.billTotal)}</span>
            </div>
            <div className="muted small mt-sm">
              {claim.documents.filter((d) => !d.error).map((d) => `${KIND[d.docType ?? ''] ?? 'other PDF'}${d.pageCount ? ` · ${d.pageCount} p.` : ''}`).join('  +  ')}
            </div>

            <label className="remember">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>The patient open on the site is {claim.patient.name ?? 'this patient'} (IP {billIp ?? '?'}) — the site does not show the IP number, so check the name.</span>
            </label>

            <div className="row-inline wrap mt">
              <button className="btn btn-secondary btn-sm" disabled={isReading || running} onClick={() => input.current?.click()}>
                <UploadIcon size={13} /> {reading !== null ? `Reading… ${clock(reading)}` : 'Other PDFs'}
              </button>
              {(errors.length > 0 || warnings.length > 0) && (
                <button className="btn btn-secondary btn-sm" onClick={() => setShowChecks(!checksOpen)}>
                  {checksOpen ? '▾' : '▸'} Checks
                  {errors.length > 0 && <span className="tag tag-danger">{errors.length}</span>}
                  {warnings.length > 0 && <span className="tag tag-warn">{warnings.length}</span>}
                </button>
              )}
            </div>
            {checksOpen && <BillChecks checks={claim.checks} pdfs={pdfs} />}
          </div>
        )}

        {isReading && <div className="bar sweep mt"><span /></div>}
        {!claim && !isReading && <div className="safe mt"><ShieldIcon size={14} /> Read and handed back — the bill is not stored anywhere</div>}
        {note && <div className="warn-line">{note}</div>}
      </section>

      {claim && (
        <>
          <div className="steps">
            <div className={`step ${running ? 'running' : results?.length ? (failed ? 'problem' : 'done') : 'idle'}`}>
              <div className="step-head">
                <span className="step-num">{results?.length && !failed && !running ? <CheckIcon size={14} /> : 1}</span>
                <div className="step-title truncate">Patient &amp; Bill Details</div>
                {results && !running && results.length > 0 && (
                  <span className={`tag tag-${failed ? 'warn' : 'success'}`}>{failed ? `${failed} to fix` : toCheck ? `${toCheck} to check` : 'filled'}</span>
                )}
                {running && <span className="tag tag-info">{results?.length ?? 0}/{total}</span>}
              </div>

              {running && <div className="bar"><span style={{ width: `${Math.round(((results?.length ?? 0) / Math.max(1, total)) * 100)}%` }} /></div>}

              <details className="preview">
                <summary>{claim.rows.length} Service Type row(s) · {rupees(claim.totals.rows)}</summary>
                <div className="small">Visit ID {claim.visitId ?? '—'} · Bill No {claim.billNo ?? '—'}</div>
                <div className="small">Visit {claim.visitDateTime ?? '—'} · Discharge {claim.dischargeDateTime ?? '—'} · Bill {claim.billDateTime ?? '—'}</div>
                {claim.rows.map((r) => (
                  <div key={`${r.serviceType}|${r.remarks}`} className="small">
                    {r.serviceType} — {rupees(r.amount)} — {r.remarks}
                    <span className="muted"> ({r.sections.join('; ')}{r.billAmount !== r.amount ? `; bill ${rupees(r.billAmount)}` : ''})</span>
                  </div>
                ))}
              </details>
              {claim.manual.length > 0 && (
                <details className="preview" open>
                  <summary>✎ {claim.manual.length} section(s) to add yourself · {rupees(claim.totals.manual)}</summary>
                  {claim.manual.map((m) => (
                    <div key={m.section} className="small">{m.section} — {rupees(m.amount)} — {m.reason}</div>
                  ))}
                </details>
              )}
              <div className="warn-line">✎ Choose the branch and open the patient's Upload Bill screen on the site first. Service Item and Priority are left empty.</div>
              <div className="warn-line">✎ Payment Details, Document Upload and Diagnosis are yours. FillPilot never presses Draft or Accept.</div>

              {results && results.length > 0 && (
                <details className="preview results" open={failed > 0 || toCheck > 0}>
                  <summary>Result: {results.length - failed} done{toCheck ? ` (${toCheck} to check)` : ''}{failed ? `, ${failed} failed` : ''}</summary>
                  {results.map((r) => <ResultLine key={r.index} result={r} tabId={tab.tabId} />)}
                </details>
              )}
              {ended && <div className="warn-line">{ended}</div>}

              <div className="step-actions">
                <button className="btn btn-primary btn-sm" disabled={!canFill || running || isReading} onClick={fill}>
                  <BoltIcon size={13} /> {running ? 'Filling…' : results?.length ? 'Fill again' : 'Fill Upload Bill'}
                </button>
                {running && <button className="btn btn-danger btn-sm" onClick={() => { stopRequested.current = true; }}><StopIcon size={12} /> Stop</button>}
              </div>
              {!canFill && <div className="muted small mt-sm">Tick the patient check above to fill.</div>}
            </div>
          </div>

          <section className="section">
            <button className="btn btn-secondary btn-block" disabled={running || isReading} onClick={clear}>
              <CheckIcon size={14} /> Finished — clear this bill
            </button>
            <div className="muted small center-text mt-sm">Held only in this browser session. It also goes when you sign out or close the browser.</div>
          </section>
        </>
      )}

      <footer className="footer">
        <div className="safe"><ShieldIcon size={14} /> Fills the screen only — never presses Draft or Accept, uploads or deletes</div>
        <div className="row-inline wrap" style={{ justifyContent: 'center' }}>
          <button className="btn btn-text btn-sm" onClick={copyStructure}>Copy page structure</button>
        </div>
        {copied && <div className="msg msg-success">{copied}</div>}
      </footer>
    </>
  );
}
