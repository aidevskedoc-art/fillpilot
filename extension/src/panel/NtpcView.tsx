// NTPC mode (Sanjeevani, sanjeevaninew.ntpc.co.in): choose the patient's Yashoda
// summary bill, check the Patient Discharge screen open on the site is that
// patient, then fill it — the dates, Discharge by (the portal's own user id, read
// on the page), Bill No, Bill Date and every charge box the summary bill has lines for.
// The site adds up its own totals; the extension never presses Submit or Save.
//
// Like the other bill modes, the bill is read on the server and handed back,
// and lives in this browser session (bill-session.ts) only until it is cleared.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { NtpcClaim } from '../../../web/projects/shared/src/api-types';
import type { ActionResult, PageAction, PageIdentity } from '../../../web/projects/shared/src/page-contract';
import { api, messageOf } from './api';
import { ntpcSession } from './bill-session';
import { BillChecks, ResultLine, useBillPdfs } from './CheckList';
import { BoltIcon, CheckIcon, ShieldIcon, StopIcon, UploadIcon } from './Icons';
import { ActiveTab, bridge } from './page-bridge';
import { NTPC_PROBES, buildNtpcActions, ntpcAuditLabel } from './ntpc-plan';

const KIND: Record<string, string> = {
  'yashoda-summary-bill': 'summary bill',
  'yashoda-final-bill': 'final bill (only checked)',
  'yashoda-pharmacy-bill': 'pharmacy bill (not needed here)',
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

export function NtpcView({ tab, onError }: { tab: ActiveTab; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [claim, setClaim] = useState<NtpcClaim | null>(null);
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
  /** The PDFs just read — a check opens the bill at its page. */
  const pdfs = useBillPdfs();

  useEffect(() => {
    ntpcSession.load().then(setClaim).catch(() => undefined);
  }, []);

  // The patient's IP number (the site's "Hospital IPD No" box) and the hospital's user id
  // ("Logged in as … (0610)") — asked again whenever the page changes.
  const pageKey = `${tab.tabId} ${tab.url?.href ?? ''}`;
  useEffect(() => {
    setConfirmed(false);
    if (!claim) return;
    bridge.readIdentity(tab.tabId).then(setIdentity).catch(() => setIdentity(null));
  }, [claim, pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loginId = identity?.loginId ?? null;
  const actions = useMemo(() => (claim ? buildNtpcActions(claim, loginId) : []), [claim, loginId]);
  const billIp = claim?.ipNo ?? claim?.patient.ipNo ?? null;
  const pageIp = identity?.ipNumber ?? null;
  const ipMismatch = Boolean(billIp && pageIp && billIp !== pageIp);
  const canFill = Boolean(claim) && !ipMismatch && (Boolean(pageIp && pageIp === billIp) || confirmed);

  async function read(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) {
      if (list?.length) setNote('Choose the summary bill PDF.');
      return;
    }
    if (reading !== null || running) return;
    setNote('');
    setReading(0);
    const started = Date.now();
    const timer = window.setInterval(() => setReading(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const fresh = await api.readNtpcBills(files);
      await ntpcSession.save(fresh);
      pdfs.hold(files, fresh.documents);
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
    await ntpcSession.clear().catch(() => undefined);
    pdfs.release();
    setClaim(null);
    setResults(null);
    setEnded('');
    setConfirmed(false);
    setNote('The bill has been cleared from this browser.');
  }

  /** Runs the steps one at a time, so each shows as it is done and Stop takes effect between them. */
  async function fill() {
    if (running || !claim) return;
    // The bill stays loaded while the person moves around the site: the same patient before anything is typed.
    const now = await bridge.readIdentity(tab.tabId).catch(() => null);
    if (now) setIdentity(now);
    if (billIp && now?.ipNumber && now.ipNumber !== billIp) {
      onError(`The site now shows IPD No ${now.ipNumber}, but the loaded bill is for IP ${billIp}. Nothing was filled.`);
      return;
    }
    const list = buildNtpcActions(claim, now?.loginId ?? loginId);
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
          why = `Stopped by you after ${done.length} of ${list.length}. Press Fill again to carry on — boxes already filled are typed again with the same value.`;
          break;
        }
        let result: ActionResult | undefined;
        try {
          [result] = await bridge.runActions(tab.tabId, [list[i]]);
        } catch {
          result = undefined;
        }
        if (!result) {
          why = 'The page did not answer — it may have reloaded. Open the Patient Discharge screen again and press Fill again.';
          break;
        }
        done.push({ ...result, index: i });
        setResults([...done]);
        if (result.stopped) {
          why = 'Stopped: the page is not as expected (see the message above). Its layout has been saved for the developer.';
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

  /** Activity log: which boxes were filled and how each went, and on any failure the page's structure — never the bill's contents. */
  async function recordAudit(list: PageAction[], done: ActionResult[]) {
    if (!tab.url || !done.length) return;
    const failed = done.some((r) => !r.ok);
    const pageOutline = failed ? await bridge.describePage(tab.tabId, NTPC_PROBES).catch(() => null) : null;
    await api
      .recordFill({
        documentIds: [],
        origin: tab.url.origin,
        path: tab.url.pathname,
        formTitle: 'NTPC Patient Discharge',
        detected: done.length,
        autoMatched: done.length,
        fields: done.map((r) => ({
          label: (list[r.index] ? ntpcAuditLabel(list[r.index]) : 'Patient Discharge').slice(0, 120),
          fieldKey: 'patient-discharge',
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
      const outline = await bridge.describePage(tab.tabId, NTPC_PROBES);
      await navigator.clipboard.writeText(JSON.stringify(outline, null, 2));
      setCopied('Page structure copied. Paste it to the developer. It has the labels, buttons and lists of this page, not what is typed in the fields. '
        + 'Read it before sending: the page\'s own text (the patient\'s name at the top) may be in it, so remove any patient names or numbers.');
    } catch (err) {
      onError(messageOf(err));
    }
  }

  const errors = claim?.checks.filter((c) => c.level === 'error') ?? [];
  const warnings = claim?.checks.filter((c) => c.level === 'warning') ?? [];
  const notes = claim?.checks.filter((c) => c.level === 'info') ?? [];
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
        <div className="label">Patient Discharge · NTPC</div>
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => read(e.target.files)} />

        {!claim && (
          <button type="button" className={`dropzone${over ? ' over' : ''}`} disabled={isReading} onClick={() => input.current?.click()} {...drop}>
            <span className="drop-icon"><UploadIcon size={18} /></span>
            <span className="strong">{reading !== null ? `Reading the bill… ${clock(reading)}` : 'Drop the summary bill PDF here'}</span>
            <span className="muted small">{isReading ? 'Scanned pages are read one by one — usually well under a minute.' : 'The summary bill (with the ICO number), or click to choose it'}</span>
          </button>
        )}

        {claim && (
          <div className="card bill" {...drop}>
            <div className="bill-name truncate">{claim.patient.name}</div>
            <div className="chips">
              <span className="chip">IP {billIp ?? '?'}</span>
              <span className="chip">Bill {claim.billNo ?? '?'}</span>
              <span className="chip">{rupees(claim.totals.billTotal)}</span>
            </div>
            <div className="muted small mt-sm">
              {claim.documents.filter((d) => !d.error).map((d) => `${KIND[d.docType ?? ''] ?? 'other PDF'}${d.pageCount ? ` · ${d.pageCount} p.` : ''}`).join('  +  ')}
            </div>

            {ipMismatch && (
              <div className="msg msg-error mt">
                The site's Hospital IPD No is {pageIp}, but this bill is for IP {billIp}. Open the right patient on the site, or choose the right PDF.
              </div>
            )}
            {pageIp && !ipMismatch && <div className="outcome ok"><CheckIcon size={14} /> Same patient as on the site (IPD No {pageIp})</div>}
            {!pageIp && (
              <label className="remember">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>The Hospital IPD No is not visible on this page — I confirm the patient open on the site is IP {billIp ?? '?'}.</span>
              </label>
            )}

            <div className="row-inline wrap mt">
              <button className="btn btn-secondary btn-sm" disabled={isReading || running} onClick={() => input.current?.click()}>
                <UploadIcon size={13} /> {reading !== null ? `Reading… ${clock(reading)}` : 'Other PDF'}
              </button>
              {(errors.length > 0 || warnings.length > 0 || notes.length > 0) && (
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
                <div className="step-title truncate">Patient Discharge</div>
                {results && !running && results.length > 0 && (
                  <span className={`tag tag-${failed ? 'warn' : 'success'}`}>{failed ? `${failed} to fix` : toCheck ? `${toCheck} to check` : 'filled'}</span>
                )}
                {running && <span className="tag tag-info">{results?.length ?? 0}/{total}</span>}
              </div>

              {running && <div className="bar"><span style={{ width: `${Math.round(((results?.length ?? 0) / Math.max(1, total)) * 100)}%` }} /></div>}

              <details className="preview" open={!results}>
                <summary>{claim.charges.length} charge box(es) · {rupees(claim.totals.boxes)}</summary>
                <div className="small">Admission {claim.admissionDateTime ?? '—'} · Discharge {claim.dischargeDateTime ?? '—'}</div>
                <div className="small">Bill No {claim.billNo ?? '—'} · Bill Date {claim.billDate ?? '—'}</div>
                <div className="small">Discharge by {loginId ?? '— not found on the page (after "Logged in as"): enter it yourself'}</div>
                {claim.charges.map((c) => (
                  <div key={c.key} className="small">
                    {c.box} — {rupees(c.amount)}
                    <span className="muted"> ({c.lines.join(', ')})</span>
                  </div>
                ))}
              </details>
              <div className="warn-line">✎ A box the summary bill has no line for stays empty; lines that fit no box are in Charges Others. The site adds up Total Amount and Bill Amount.</div>
              <div className="warn-line">✎ Last Tentative Cumulative amount, Discharge Summary, Final Diagnosis and the uploads are yours. FillPilot never presses Submit or Save.</div>

              {results && results.length > 0 && (
                <details className="preview results" open={failed > 0 || toCheck > 0}>
                  <summary>Result: {results.length - failed} done{toCheck ? ` (${toCheck} to check)` : ''}{failed ? `, ${failed} failed` : ''}</summary>
                  {results.map((r) => <ResultLine key={r.index} result={r} tabId={tab.tabId} />)}
                </details>
              )}
              {ended && <div className="warn-line">{ended}</div>}

              <div className="step-actions">
                <button className="btn btn-primary btn-sm" disabled={!canFill || running || isReading || !actions.length} onClick={fill}>
                  <BoltIcon size={13} /> {running ? 'Filling…' : results?.length ? 'Fill again' : 'Fill Patient Discharge'}
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
        <div className="safe"><ShieldIcon size={14} /> Fills the screen only — never presses Submit or Save</div>
        <div className="row-inline wrap" style={{ justifyContent: 'center' }}>
          <button className="btn btn-text btn-sm" onClick={copyStructure}>Copy page structure</button>
        </div>
        {copied && <div className="msg msg-success">{copied}</div>}
      </footer>
    </>
  );
}
