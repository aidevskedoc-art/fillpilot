// PM-JAY Treatment Plan mode (provider.nha.gov.in): choose the patient's
// Yashoda bill PDFs (final + summary), confirm the case open on the portal is
// that patient, then add one Treatment Plan row per package code. The site
// prices each row itself; the extension never saves or submits.
//
// Like TGNPDCL mode, the bill is read on the server and handed back, and lives
// in this browser session (bill-session.ts) only until it is cleared.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { PmjayClaim } from '../../../web/projects/shared/src/api-types';
import type { ActionResult, PageAction } from '../../../web/projects/shared/src/page-contract';
import { api, messageOf } from './api';
import { pmjayAdded, pmjaySession } from './bill-session';
import { BoltIcon, CheckIcon, ShieldIcon, StopIcon, UploadIcon } from './Icons';
import { ActiveTab, bridge } from './page-bridge';
import { PMJAY_PROBES, buildPmjayActions, pmjayAuditLabel } from './pmjay-plan';

const KIND: Record<string, string> = {
  'yashoda-final-bill': 'final bill',
  'yashoda-summary-bill': 'summary bill',
};
/** The first codes all failing means the page is not what the profile expects — no point going on. */
const PROBE = 3;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
/** Which bill a list of added codes belongs to. */
const billKey = (c: PmjayClaim) => `${c.patient.ipNo ?? ''}|${c.hospitalBillNumber ?? ''}|${c.totals.billTotal}`;

export function PmjayView({ tab, onError }: { tab: ActiveTab; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [claim, setClaim] = useState<PmjayClaim | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [results, setResults] = useState<ActionResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ended, setEnded] = useState('');
  const [showChecks, setShowChecks] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState('');
  /** Codes added for this bill in this browser session — "Fill again" goes on with the rest. */
  const [added, setAdded] = useState<string[]>([]);
  /** How many this fill is adding — fixed at the start, for the progress bar. */
  const [total, setTotal] = useState(0);
  const stopRequested = useRef(false);

  useEffect(() => {
    (async () => {
      const stored = await pmjaySession.load();
      setClaim(stored);
      const done = await pmjayAdded.load();
      if (stored && done?.bill === billKey(stored)) setAdded(done.codes);
    })().catch(() => undefined);
  }, []);

  // Another page may be another patient's case: the person confirms again.
  useEffect(() => setConfirmed(false), [tab.tabId, tab.url?.href]);

  const actions = useMemo(() => (claim ? buildPmjayActions(claim) : []), [claim]);
  const pending = useMemo(() => actions.filter((a) => !(a.type === 'addProcedure' && added.includes(a.code))), [actions, added]);

  async function forgetAdded() {
    setAdded([]);
    await pmjayAdded.clear().catch(() => undefined);
  }

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
      const fresh = await api.readPmjayBills(files);
      await pmjaySession.save(fresh);
      await forgetAdded();
      setClaim(fresh);
      setResults(null);
      setEnded('');
      setConfirmed(false);
      setNote(fresh.documents.filter((d) => d.error).map((d) => `${d.fileName}: ${d.error}`).join(' '));
    } catch (err) {
      onError(messageOf(err));
    } finally {
      window.clearInterval(timer);
      setReading(null);
      if (input.current) input.current.value = '';
    }
  }

  async function clear() {
    await pmjaySession.clear().catch(() => undefined);
    await forgetAdded();
    setClaim(null);
    setResults(null);
    setEnded('');
    setConfirmed(false);
    setNote('The bill has been cleared from this browser.');
  }

  /**
   * Adds the procedures not added yet, one at a time, so each shows as it is
   * done and Stop takes effect between them. What was added is remembered for
   * this bill, so Fill again carries on with the rest.
   */
  async function fill() {
    if (running || !claim) return;
    const list = pending;
    const bill = billKey(claim);
    const nowAdded = [...added];
    stopRequested.current = false;
    setTotal(list.length);
    setRunning(true);
    setEnded('');
    const done: ActionResult[] = [];
    setResults([]);
    let why = '';
    try {
      for (let i = 0; i < list.length; i++) {
        if (stopRequested.current) {
          why = `Stopped by you after ${done.length} of ${list.length}. Press Fill to carry on with the rest.`;
          break;
        }
        const action = list[i];
        const [result] = await bridge.runActions(tab.tabId, [action]);
        if (!result) {
          why = 'The page did not answer — is the PM-JAY tab still open?';
          break;
        }
        done.push({ ...result, index: i });
        setResults([...done]);
        if (result.ok && !result.skipped && action.type === 'addProcedure') {
          nowAdded.push(action.code);
          setAdded([...nowAdded]);
          await pmjayAdded.save({ bill, codes: nowAdded }).catch(() => undefined);
        }
        // The page is not as the profile expects (Procedure box or "+" missing): every other code would fail the same way.
        if (!result.ok && /was not found/.test(result.message)) {
          why = 'Stopped: the page is not as expected (see the message above). Its layout has been saved for the developer.';
          break;
        }
        if (done.length === PROBE && done.every((r) => !r.ok)) {
          why = `The first ${PROBE} procedures could not be added, so the other ${list.length - PROBE} were not tried. The reasons are saved for the developer.`;
          break;
        }
      }
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setEnded(why);
      setRunning(false);
      await recordAudit(list, done);
    }
  }

  /** Activity log: which codes were tried and how each went, and on any failure the page's structure — never the bill's contents. */
  async function recordAudit(list: PageAction[], done: ActionResult[]) {
    if (!tab.url || !done.length) return;
    const failed = done.some((r) => !r.ok);
    const pageOutline = failed ? await bridge.describePage(tab.tabId, PMJAY_PROBES).catch(() => null) : null;
    await api
      .recordFill({
        documentIds: [],
        origin: tab.url.origin,
        path: tab.url.pathname,
        formTitle: 'PM-JAY Treatment Plan',
        detected: done.length,
        autoMatched: done.length,
        fields: done.map((r) => ({
          label: (list[r.index] ? pmjayAuditLabel(list[r.index]) : 'Treatment Plan').slice(0, 120),
          fieldKey: 'treatment',
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
      const outline = await bridge.describePage(tab.tabId, PMJAY_PROBES);
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
        <div className="label">Treatment Plan · PM-JAY</div>
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
              <span className="chip">IP {claim.patient.ipNo ?? '?'}</span>
              <span className="chip">Bill {claim.hospitalBillNumber ?? '?'}</span>
              <span className="chip">{rupees(claim.totals.billTotal)}</span>
            </div>
            <div className="muted small mt-sm">
              {claim.documents.filter((d) => !d.error).map((d) => `${KIND[d.docType ?? ''] ?? 'other PDF'}${d.pageCount ? ` · ${d.pageCount} p.` : ''}`).join('  +  ')}
            </div>

            <label className="remember">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>The case open on PM-JAY is this patient ({claim.patient.name ?? 'name not read'}, IP {claim.patient.ipNo ?? '?'}).</span>
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
            {checksOpen && (
              <div className="mt-sm">
                {errors.map((c) => <div key={c.message} className="warn-line bad">✗ {c.message}</div>)}
                {warnings.map((c) => <div key={c.message} className={`warn-line${c.level === 'info' ? ' muted' : ''}`}>{c.level === 'info' ? 'ℹ' : '⚠'} {c.message}</div>)}
              </div>
            )}
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
                <div className="step-title truncate">Treatment Plan</div>
                {results && !running && results.length > 0 && (
                  <span className={`tag tag-${failed ? 'warn' : 'success'}`}>{failed ? `${failed} to fix` : toCheck ? `${toCheck} to check` : 'added'}</span>
                )}
                {running && <span className="tag tag-info">{results?.length ?? 0}/{total}</span>}
              </div>

              {running && <div className="bar"><span style={{ width: `${Math.round(((results?.length ?? 0) / Math.max(1, total)) * 100)}%` }} /></div>}

              <details className="preview">
                <summary>{claim.procedures.length} procedure(s) to add · bill {rupees(claim.totals.coded)}</summary>
                {claim.procedures.map((p) => (
                  <div key={p.code} className="small">
                    {p.code} — {p.units} unit(s) — {p.description}{p.notes.length ? `  ⚠ ${p.notes.join('; ')}` : ''}
                  </div>
                ))}
              </details>
              {claim.manual.length > 0 && (
                <details className="preview">
                  <summary>✎ {claim.manual.length} bill line(s) to enter yourself · {rupees(claim.totals.notCoded)}</summary>
                  {claim.manual.map((m) => (
                    <div key={`${m.section}|${m.description}`} className="small">
                      {m.description}{m.count > 1 ? ` ×${m.count}` : ''} — {rupees(m.amount)} — {m.reason} ({m.section})
                    </div>
                  ))}
                </details>
              )}
              <div className="warn-line">✎ Amounts are the site's own package rates. Check the table against the bill, then fill the Resubmission Reason and save yourself.</div>

              {results && results.length > 0 && (
                <details className="preview results" open={failed > 0 || toCheck > 0}>
                  <summary>Result: {results.length - failed} done{toCheck ? ` (${toCheck} to check)` : ''}{failed ? `, ${failed} failed` : ''}</summary>
                  {results.map((r) => (
                    <div key={r.index} className={`small ${r.ok ? (r.warn ? 'warn-text' : '') : 'bad'}`}>
                      {r.ok ? (r.warn ? '⚠' : '✓') : '✗'} {r.label}{r.ok && !r.warn ? '' : ` — ${r.message}`}
                    </div>
                  ))}
                </details>
              )}
              {ended && <div className="warn-line">{ended}</div>}

              <div className="step-actions">
                <button className="btn btn-primary btn-sm" disabled={!confirmed || running || isReading || pending.length === 0} onClick={fill}>
                  <BoltIcon size={13} /> {running ? 'Adding…' : added.length ? `Add the other ${pending.length}` : 'Fill Treatment Plan'}
                </button>
                {running && <button className="btn btn-danger btn-sm" onClick={() => { stopRequested.current = true; }}><StopIcon size={12} /> Stop</button>}
              </div>
              {!confirmed && <div className="muted small mt-sm">Tick the patient check above to fill.</div>}
              {added.length > 0 && !running && (
                <div className="muted small mt-sm">
                  ✓ {added.length} of {actions.length} added for this bill in this browser session{pending.length ? '' : ' — all of them'}.{' '}
                  <button className="btn btn-text btn-sm" onClick={forgetAdded} title="Use after removing rows on the site">Add all again</button>
                </div>
              )}
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
        <div className="safe"><ShieldIcon size={14} /> Adds rows only — never saves, submits or removes</div>
        <div className="row-inline wrap" style={{ justifyContent: 'center' }}>
          <button className="btn btn-text btn-sm" onClick={copyStructure}>Copy page structure</button>
        </div>
        {copied && <div className="msg msg-success">{copied}</div>}
      </footer>
    </>
  );
}
