// Coal India mode (e-Arogya Suvidha, cilbpa.utiitsl.com): choose the patient's
// Yashoda bill PDFs (final + summary), check the claim open on the site is that
// patient, then fill the Bill Details tab — Bill No., Bill Date, one CGHS row
// per coded service and the hospital's own codes under Unlisted Procedures. The
// site prices its CGHS items itself; the extension never saves or submits.
//
// Like the other bill modes, the bill is read on the server and handed back,
// and lives in this browser session (bill-session.ts) only until it is cleared.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { CilClaim } from '../../../web/projects/shared/src/api-types';
import type { ActionResult, PageIdentity } from '../../../web/projects/shared/src/page-contract';
import { api, messageOf } from './api';
import { cilSession } from './bill-session';
import { BoltIcon, CheckIcon, ShieldIcon, StopIcon, UploadIcon } from './Icons';
import { ActiveTab, bridge } from './page-bridge';
import { CIL_PROBES, buildCilActions, cilAuditLabel } from './cil-plan';

const KIND: Record<string, string> = {
  'yashoda-final-bill': 'final bill',
  'yashoda-summary-bill': 'summary bill',
};
/** The first rows all failing means the page is not what the profile expects — no point going on. */
const PROBE = 3;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
/** "MR. SANJIV SONI" and "SANJIV SONI" are the same name. */
const nameKey = (name: string | null | undefined) =>
  (name ?? '').toUpperCase().replace(/^(MR|MRS|MS|MISS|DR|MASTER|BABY|SMT|SRI|SHRI)\.?\s+/, '').replace(/[^A-Z]+/g, ' ').trim();
/** The site's IP number: printed as "Admission No" on e-Arogya Suvidha. */
const pageIpOf = (identity: PageIdentity | null) => identity?.ipNumber ?? identity?.admissionNumber ?? null;

export function CilView({ tab, onError }: { tab: ActiveTab; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [claim, setClaim] = useState<CilClaim | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [identity, setIdentity] = useState<PageIdentity | null>(null);
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

  useEffect(() => {
    cilSession.load().then(setClaim).catch(() => undefined);
  }, []);

  // Whose claim is open on the site — asked again whenever the page changes; another page may be another patient.
  const pageKey = `${tab.tabId} ${tab.url?.href ?? ''}`;
  useEffect(() => {
    setConfirmed(false);
    if (!claim) return;
    bridge.readIdentity(tab.tabId).then(setIdentity).catch(() => setIdentity(null));
  }, [claim, pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useMemo(() => (claim ? buildCilActions(claim) : []), [claim]);
  const billIp = claim?.patient.ipNo ?? null;
  const pageIp = pageIpOf(identity);
  const ipMismatch = Boolean(billIp && pageIp && billIp !== pageIp);
  const pageName = identity?.patientName ?? null;
  const nameMismatch = Boolean(pageName && claim?.patient.name && nameKey(pageName) !== nameKey(claim.patient.name));
  const canFill = Boolean(claim) && !ipMismatch && (Boolean(pageIp && pageIp === billIp) || confirmed);

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
      const fresh = await api.readCilBills(files);
      await cilSession.save(fresh);
      setClaim(fresh);
      setResults(null);
      setEnded('');
      setConfirmed(false);
      const unread = fresh.documents.filter((d) => d.error).map((d) => `${d.fileName}: ${d.error}`);
      const summary = fresh.documents.some((d) => d.docType === 'yashoda-summary-bill');
      setNote([
        ...unread,
        ...(summary ? [] : ['Only the final bill was read. Choose the final and the summary bill together — Bill No. and Bill Date come from the summary bill.']),
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
    await cilSession.clear().catch(() => undefined);
    setClaim(null);
    setResults(null);
    setEnded('');
    setIdentity(null);
    setConfirmed(false);
    setNote('The bill has been cleared from this browser.');
  }

  /**
   * Runs the Bill Details steps one at a time, so each shows as it is done and
   * Stop takes effect between them. Rows already on the site are not added
   * again, so Fill again carries on where a fill stopped.
   */
  async function fill() {
    if (running || !claim) return;
    // The bill stays loaded while the person moves around the site: same patient before typing anything.
    const now = await bridge.readIdentity(tab.tabId).catch(() => null);
    if (now) setIdentity(now);
    const nowIp = pageIpOf(now);
    if (billIp && nowIp && nowIp !== billIp) {
      onError(`The site now shows Admission No ${nowIp}, but the loaded bill is for IP ${billIp}. Nothing was filled.`);
      return;
    }
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
          why = `Stopped by you after ${done.length} of ${actions.length}. Press Fill again to carry on — rows already on the site are not added twice.`;
          break;
        }
        let result: ActionResult | undefined;
        try {
          [result] = await bridge.runActions(tab.tabId, [actions[i]]);
        } catch {
          result = undefined;
        }
        if (!result) {
          why = 'The page did not answer — it may have reloaded. Open Bill Details again and press Fill again; rows already entered are not added twice.';
          break;
        }
        done.push({ ...result, index: i });
        setResults([...done]);
        if (result.stopped) {
          why = 'Stopped: the page is not as expected (see the message above). Its layout has been saved for the developer.';
          break;
        }
        const rows = done.filter((r) => actions[r.index]?.type === 'addCilRow');
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
    const pageOutline = failed ? await bridge.describePage(tab.tabId, CIL_PROBES).catch(() => null) : null;
    await api
      .recordFill({
        documentIds: [],
        origin: tab.url.origin,
        path: tab.url.pathname,
        formTitle: 'Coal India Bill Details',
        detected: done.length,
        autoMatched: done.length,
        fields: done.map((r) => ({
          label: (actions[r.index] ? cilAuditLabel(actions[r.index]) : 'Bill Details').slice(0, 120),
          fieldKey: 'bill-details',
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
      const outline = await bridge.describePage(tab.tabId, CIL_PROBES);
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
        <div className="label">Bill Details · Coal India</div>
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
              <span className="chip">Bill {claim.hospitalBillNumber ?? '?'}</span>
              <span className="chip">{rupees(claim.totals.netAmount ?? claim.totals.billTotal)}</span>
            </div>
            <div className="muted small mt-sm">
              {claim.documents.filter((d) => !d.error).map((d) => `${KIND[d.docType ?? ''] ?? 'other PDF'}${d.pageCount ? ` · ${d.pageCount} p.` : ''}`).join('  +  ')}
            </div>

            {ipMismatch && (
              <div className="msg msg-error mt">
                The site shows Admission No {pageIp}, but these bills are for IP {billIp}. Open the right claim on the site, or choose the right PDFs.
              </div>
            )}
            {pageIp && !ipMismatch && <div className="outcome ok"><CheckIcon size={14} /> Same patient as on the site (Admission No {pageIp})</div>}
            {!pageIp && (
              <>
                {nameMismatch && (
                  <div className="msg msg-warn mt">The site shows the patient "{pageName}", the bill "{claim.patient.name}". Check it is the same person.</div>
                )}
                <label className="remember">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  <span>The Admission No is not visible on this page — I confirm the claim open on the site is IP {billIp ?? '?'}{pageName && !nameMismatch ? ` (${pageName})` : ''}.</span>
                </label>
              </>
            )}

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
                <div className="step-title truncate">Bill Details</div>
                {results && !running && results.length > 0 && (
                  <span className={`tag tag-${failed ? 'warn' : 'success'}`}>{failed ? `${failed} to fix` : toCheck ? `${toCheck} to check` : 'filled'}</span>
                )}
                {running && <span className="tag tag-info">{results?.length ?? 0}/{total}</span>}
              </div>

              {running && <div className="bar"><span style={{ width: `${Math.round(((results?.length ?? 0) / Math.max(1, total)) * 100)}%` }} /></div>}

              <details className="preview">
                <summary>
                  {claim.cghs.length} CGHS row(s) · {rupees(claim.totals.cghs)}
                  {claim.unlisted.length ? `  +  ${claim.unlisted.length} unlisted · ${rupees(claim.totals.unlisted)}` : ''}
                </summary>
                <div className="small">Bill No. {claim.hospitalBillNumber ?? '—'} · Bill Date {claim.billDate ?? '—'}</div>
                {claim.cghs.map((r) => (
                  <div key={`c|${r.code}|${r.description}|${r.rate}`} className="small">
                    {r.code} — {r.qty} × {rupees(r.rate)} = {rupees(r.amount)} — {r.description}{r.notes.length ? `  ⚠ ${r.notes.join('; ')}` : ''}
                  </div>
                ))}
                {claim.unlisted.map((r) => (
                  <div key={`u|${r.code}|${r.description}|${r.rate}`} className="small">
                    Unlisted {r.code} — {r.qty} × {rupees(r.rate)} = {rupees(r.amount)} — {r.description}{r.notes.length ? `  ⚠ ${r.notes.join('; ')}` : ''}
                  </div>
                ))}
                {claim.pharmacy != null && <div className="small">Pharmacy {rupees(claim.pharmacy)} — compared with the site's Pharmacy Amount</div>}
              </details>
              {claim.manual.length > 0 && (
                <details className="preview">
                  <summary>✎ {claim.manual.length} bill line(s) to enter yourself · {rupees(claim.totals.manual)}</summary>
                  {claim.manual.map((m) => (
                    <div key={`${m.section}|${m.description}`} className="small">
                      {m.description}{m.count > 1 ? ` ×${m.count}` : ''} — {rupees(m.amount)} — {m.reason}
                    </div>
                  ))}
                </details>
              )}
              <div className="warn-line">✎ Open the Bill Details tab on the site first. CGHS items are priced by the site — rows that differ from the bill are marked to check.</div>
              {claim.unlisted.length > 0 && <div className="warn-line">✎ Tick "Prior approval has already taken for Unlisted Procedures" yourself if it applies.</div>}
              {claim.room && (
                <div className="warn-line">
                  ✎ Room rent is added under Unlisted Procedures — also enter the room in Room Details on the Admission tab ({claim.room.days} day(s), {rupees(claim.room.amount)}).
                </div>
              )}

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
                <button className="btn btn-primary btn-sm" disabled={!canFill || running || isReading} onClick={fill}>
                  <BoltIcon size={13} /> {running ? 'Filling…' : results?.length ? 'Fill again' : 'Fill Bill Details'}
                </button>
                {running && <button className="btn btn-danger btn-sm" onClick={() => { stopRequested.current = true; }}><StopIcon size={12} /> Stop</button>}
              </div>
              {!canFill && !ipMismatch && <div className="muted small mt-sm">Tick the patient check above to fill.</div>}
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
        <div className="safe"><ShieldIcon size={14} /> Fills rows only — never saves, submits, deletes rows or ticks declarations</div>
        <div className="row-inline wrap" style={{ justifyContent: 'center' }}>
          <button className="btn btn-text btn-sm" onClick={copyStructure}>Copy page structure</button>
        </div>
        {copied && <div className="msg msg-success">{copied}</div>}
      </footer>
    </>
  );
}
