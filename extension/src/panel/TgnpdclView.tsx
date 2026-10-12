// TGNPDCL bill-entry mode: choose the patient's Yashoda bill PDFs (final +
// summary), check the patient matches the bill open on the site, then fill one
// wizard tab at a time — the person reviews each tab and only then moves on.
// The extension never saves or submits.
//
// The bill is not stored anywhere on the server: it is read there and handed
// back, and lives in this browser session (bill-session.ts) only until it is
// cleared, the person signs out, or the browser closes.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { TgnpdclClaim } from '../../../web/projects/shared/src/api-types';
import type { ActionResult, PageAction, PageIdentity } from '../../../web/projects/shared/src/page-contract';
import { activityLog } from './activity-log';
import { api, messageOf } from './api';
import { billSession } from './bill-session';
import { ArrowRightIcon, BoltIcon, CheckIcon, ShieldIcon, StopIcon, UploadIcon } from './Icons';
import { ActiveTab, bridge } from './page-bridge';
import { NEXT_ACTION, OUTLINE_PROBES, PlanStep, auditLabel, buildPlan } from './tgnpdcl-plan';

interface StepState {
  running: boolean;
  results: ActionResult[] | null;
  /** Why the step ended early, when it did. */
  note?: string;
}

const KIND: Record<string, string> = {
  'yashoda-final-bill': 'final bill',
  'yashoda-summary-bill': 'summary bill',
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function TgnpdclView({ tab, onError }: {
  tab: ActiveTab;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [claim, setClaim] = useState<TgnpdclClaim | null>(null);
  /** Seconds since reading started; null when no bill is being read. */
  const [reading, setReading] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [identity, setIdentity] = useState<PageIdentity | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  /** null = not chosen yet: the checks open by themselves when one of them is a problem. */
  const [showChecks, setShowChecks] = useState<boolean | null>(null);
  const [copied, setCopied] = useState('');
  const [note, setNote] = useState('');
  /** Key of the step that is running, if any. */
  const [busy, setBusy] = useState<string | null>(null);
  const stopRequested = useRef(false);

  // A bill loaded earlier in this browser session is still there after the panel was closed.
  useEffect(() => {
    billSession.load().then(setClaim).catch(() => undefined);
  }, []);

  // Whose bill is open on the site — asked again whenever the page changes.
  const pageKey = `${tab.tabId} ${tab.url?.href ?? ''}`;
  useEffect(() => {
    if (!claim) return;
    bridge.readIdentity(tab.tabId).then(setIdentity).catch(() => setIdentity(null));
  }, [claim, pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = useMemo(() => (claim ? buildPlan(claim) : []), [claim]);
  const billIp = claim?.patient.ipNo ?? null;
  const pageIp = identity?.ipNumber ?? null;
  const ipMismatch = Boolean(billIp && pageIp && billIp !== pageIp);
  const canFill = Boolean(claim) && !ipMismatch && (Boolean(pageIp && pageIp === billIp) || confirmed);

  /** Sends the chosen PDFs to be read and keeps the answer for this session — nothing is stored on the server. */
  async function read(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) {
      if (list?.length) setNote('Choose PDF files — the final bill and the summary bill.');
      return;
    }
    if (reading !== null || busy) return;
    setNote('');
    setReading(0);
    const started = Date.now();
    const timer = window.setInterval(() => setReading(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const fresh = await api.readTgnpdclBills(files);
      await billSession.save(fresh);
      setClaim(fresh);
      setSteps({});
      setConfirmed(false);
      const unread = fresh.documents.filter((d) => d.error).map((d) => `${d.fileName}: ${d.error}`);
      const summary = fresh.documents.some((d) => d.docType === 'yashoda-summary-bill');
      setNote([
        ...unread,
        ...(summary ? [] : ['Only the final bill was read. Choose the final and the summary bill together — "Employee paid" and the hospital bill number come from the summary bill.']),
      ].join(' '));
    } catch (err) {
      onError(messageOf(err));
    } finally {
      window.clearInterval(timer);
      setReading(null);
      // Lets the same files be chosen again.
      if (input.current) input.current.value = '';
    }
  }

  /** The bill is entered (or the wrong one was chosen): forget it. */
  async function clear() {
    await billSession.clear().catch(() => undefined);
    setClaim(null);
    setSteps({});
    setIdentity(null);
    setConfirmed(false);
    setNote('The bill has been cleared from this browser.');
  }

  /**
   * Runs one step, one wizard tab at a time (never two at once — they would
   * type over each other). Quick field fills go to the page in groups; tariff
   * codes go one by one, so each shows as it is done and Stop takes effect
   * within a code.
   */
  async function run(step: PlanStep, withNext: boolean) {
    if (busy) return;
    const GROUP = 6;
    const TARIFF_PROBE = 3;
    const actions = withNext ? [NEXT_ACTION] : step.actions;
    const prior = withNext ? steps[step.key]?.results ?? [] : [];
    const done: ActionResult[] = [];
    const show = (running: boolean, ended?: string) =>
      setSteps((s) => ({ ...s, [step.key]: { running, results: [...prior, ...done], note: ended } }));
    let ended: string | undefined;
    stopRequested.current = false;
    setBusy(step.key);
    try {
      // The bill stays loaded while the person moves around the site, so make
      // sure the site still shows the same patient before typing anything.
      if (!withNext) {
        const now = await bridge.readIdentity(tab.tabId).catch(() => null);
        if (now) setIdentity(now);
        if (billIp && now?.ipNumber && now.ipNumber !== billIp) {
          onError(`The site now shows IP ${now.ipNumber}, but the loaded bill is for IP ${billIp}. Nothing was filled.`);
          return;
        }
      }
      setSteps((s) => ({ ...s, [step.key]: { running: true, results: withNext ? s[step.key]?.results ?? null : [] } }));
      for (let i = 0; i < actions.length; ) {
        if (stopRequested.current) {
          ended = `Stopped by you after ${done.length} of ${actions.length}. Press Fill to carry on — what is already on the site is kept.`;
          break;
        }
        let end = i + 1;
        if (actions[i].type !== 'addTariffItem') while (end < actions.length && end - i < GROUP && actions[end].type !== 'addTariffItem') end++;
        const slice = actions.slice(i, end);
        const batch = await bridge.runActions(tab.tabId, slice);
        done.push(...batch.map((r) => ({ ...r, index: r.index + i })));
        show(true);
        // Fewer results than actions: the page reported the step cannot go on.
        if (batch.length < slice.length) break;
        // The first codes all failing means the search itself does not work here — no point grinding through the rest.
        const codes = done.filter((r) => actions[r.index]?.type === 'addTariffItem');
        if (codes.length === TARIFF_PROBE && codes.every((r) => !r.ok)) {
          ended = `The first ${TARIFF_PROBE} tariff codes could not be added, so the other ${actions.length - end} were not tried. The reasons are saved for the developer.`;
          break;
        }
        i = end;
      }
      show(false, ended);
    } catch (err) {
      show(false, ended);
      onError(messageOf(err));
    } finally {
      setBusy(null);
      await recordAudit(step, actions, done, withNext);
    }
  }

  /**
   * Activity log: which steps were attempted and how each went — named by
   * field or tariff code, never by what was typed — with the reason for
   * anything that failed and the page's structure at that moment (captions,
   * labels, column headings), so the site profile can be corrected without
   * anyone having to describe the page. It carries nothing of the bill.
   */
  async function recordAudit(step: PlanStep, actions: PageAction[], results: ActionResult[], next: boolean) {
    if (!tab.url || !results.length) return;
    const failed = results.some((r) => !r.ok);
    if (next && !failed) return;
    const pageOutline = await bridge.describePage(tab.tabId, OUTLINE_PROBES).catch(() => null);
    await api
      .recordFill({
        documentIds: [],
        origin: tab.url.origin,
        path: tab.url.pathname,
        formTitle: `TGNPDCL ${step.title}${next ? ' — Next' : ''}`,
        detected: results.length,
        autoMatched: results.length,
        fields: results.map((r) => ({
          label: (actions[r.index] ? auditLabel(actions[r.index]) : step.title).slice(0, 120),
          fieldKey: step.key,
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
      const outline = await bridge.describePage(tab.tabId, OUTLINE_PROBES);
      await navigator.clipboard.writeText(JSON.stringify(outline, null, 2));
      setCopied('Page structure copied — paste it to the developer. It holds captions, labels and column headings, not the values in the fields.');
    } catch (err) {
      onError(messageOf(err));
    }
  }

  /** Reader installations: the record of what ran and what failed, as a file to send to support. */
  async function exportLog() {
    try {
      const count = await activityLog.download();
      setCopied(`Activity log saved to your Downloads (${count} run(s)). It names fields and tariff codes — no patient details. Send it to support.`);
    } catch (err) {
      onError(messageOf(err));
    }
  }

  const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const errors = claim?.checks.filter((c) => c.level === 'error') ?? [];
  const warnings = claim?.checks.filter((c) => c.level !== 'error') ?? [];
  const isReading = reading !== null;
  const checksOpen = showChecks ?? errors.length > 0;

  /** How a step stands, for its colours: idle → running → done / problem. */
  const standing = (key: string): 'idle' | 'running' | 'done' | 'problem' => {
    const state = steps[key];
    if (state?.running) return 'running';
    if (!state?.results?.length) return 'idle';
    return state.results.some((r) => !r.ok) ? 'problem' : 'done';
  };

  const drop = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); read(e.dataTransfer.files); },
  };

  return (
    <>
      <section className="section">
        <div className="label">Bill entry · TGNPDCL</div>
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => read(e.target.files)} />

        {!claim && (
          <button type="button" className={`dropzone${over ? ' over' : ''}`} disabled={isReading} onClick={() => input.current?.click()} {...drop}>
            <span className="drop-icon"><UploadIcon size={18} /></span>
            <span className="strong">{reading !== null ? `Reading the bills… ${clock(reading)}` : 'Drop the bill PDFs here'}</span>
            <span className="muted small">
              {isReading ? 'Scanned pages are read one by one — usually well under a minute.' : 'Final bill + summary bill, or click to choose them'}
            </span>
          </button>
        )}

        {claim && (
          <div className="card bill" {...drop}>
            <div className="bill-name truncate">{claim.patient.name}</div>
            <div className="chips">
              <span className="chip">IP {billIp ?? '?'}</span>
              <span className="chip">Bill {claim.hospitalBillNumber ?? '?'}</span>
              <span className="chip">{rupees(claim.totals.billTotal)}</span>
            </div>
            <div className="muted small mt-sm">
              {claim.documents.filter((d) => !d.error).map((d) => `${KIND[d.docType ?? ''] ?? 'other PDF'}${d.pageCount ? ` · ${d.pageCount} p.` : ''}`).join('  +  ')}
            </div>

            {ipMismatch && (
              <div className="msg msg-error mt">
                The site shows IP {pageIp}, but these bills are for IP {billIp}. Open the right bill on the site, or choose the right PDFs.
              </div>
            )}
            {pageIp && !ipMismatch && <div className="outcome ok"><CheckIcon size={14} /> Same patient as on the site (IP {pageIp})</div>}
            {!pageIp && (
              <label className="remember">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>The IP number is not visible on this page — I confirm the bill open on the site is IP {billIp}.</span>
              </label>
            )}

            <div className="row-inline wrap mt">
              <button className="btn btn-secondary btn-sm" disabled={isReading || Boolean(busy)} onClick={() => input.current?.click()}>
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
          <div className="section">
            <div className="rail" aria-hidden="true">
              {plan.map((step) => <span key={step.key} className={`rail-seg ${standing(step.key)}`} />)}
            </div>
          </div>

          <div className="steps">
            {plan.map((step, n) => {
              const state = steps[step.key];
              const failed = state?.results?.filter((r) => !r.ok).length ?? 0;
              const toCheck = state?.results?.filter((r) => r.ok && r.warn).length ?? 0;
              const doneCount = state?.results?.length ?? 0;
              return (
                <div key={step.key} className={`step ${standing(step.key)}`}>
                  <div className="step-head">
                    <span className="step-num">{standing(step.key) === 'done' ? <CheckIcon size={14} /> : n + 1}</span>
                    <div className="step-title truncate">{step.title.split('. ')[1]}</div>
                    {state?.results && !state.running && (
                      <span className={`tag tag-${failed ? 'warn' : 'success'}`}>{failed ? `${failed} to fix` : toCheck ? `${toCheck} to check` : 'filled'}</span>
                    )}
                    {state?.running && <span className="tag tag-info">{doneCount}/{step.actions.length}</span>}
                  </div>

                  {state?.running && <div className="bar"><span style={{ width: `${Math.round((doneCount / step.actions.length) * 100)}%` }} /></div>}

                  {step.preview.length > 0 && (
                    <details className="preview">
                      <summary>{step.preview.length} item(s) to fill</summary>
                      {step.preview.map((p) => <div key={p} className="small">{p}</div>)}
                    </details>
                  )}
                  {step.manual.map((m) => <div key={m} className="warn-line">✎ {m}</div>)}
                  {step.nothingToFill && <div className="warn-line muted">Nothing to fill on this tab from these bills.</div>}
                  {state?.results && (
                    <details className="preview results" open={failed > 0 || toCheck > 0}>
                      <summary>Result: {state.results.length - failed} done{toCheck ? ` (${toCheck} to check)` : ''}{failed ? `, ${failed} failed` : ''}</summary>
                      {state.results.map((r) => (
                        <div key={r.index + r.label} className={`small ${r.ok ? (r.warn ? 'warn-text' : '') : 'bad'}`}>
                          {r.ok ? (r.warn ? '⚠' : '✓') : '✗'} {r.label}{r.ok && !r.warn ? '' : ` — ${r.message}`}
                        </div>
                      ))}
                    </details>
                  )}
                  {state?.note && <div className="warn-line">{state.note}</div>}

                  <div className="step-actions">
                    {!step.nothingToFill && (
                      <button className="btn btn-primary btn-sm" disabled={!canFill || Boolean(busy) || isReading} onClick={() => run(step, false)}>
                        <BoltIcon size={13} /> {state?.running ? 'Filling…' : state?.results ? 'Fill again' : 'Fill this tab'}
                      </button>
                    )}
                    {state?.running && step.actions.length > 12 && (
                      <button className="btn btn-danger btn-sm" onClick={() => { stopRequested.current = true; }}><StopIcon size={12} /> Stop</button>
                    )}
                    {step.key !== 'summary' && (
                      <button className="btn btn-secondary btn-sm" disabled={!canFill || Boolean(busy) || isReading} onClick={() => run(step, true)} title="Clicks the site's Next button">
                        Next <ArrowRightIcon size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <section className="section">
            <button className="btn btn-secondary btn-block" disabled={Boolean(busy) || isReading} onClick={clear}>
              <CheckIcon size={14} /> Finished — clear this bill
            </button>
            <div className="muted small center-text mt-sm">
              Held only in this browser session. It also goes when you sign out or close the browser.
            </div>
          </section>
        </>
      )}

      <footer className="footer">
        <div className="safe"><ShieldIcon size={14} /> Fills and clicks Next only — never saves, submits or ticks declarations</div>
        <div className="row-inline wrap" style={{ justifyContent: 'center' }}>
          <button className="btn btn-text btn-sm" onClick={copyStructure}>Copy page structure</button>
          {api.mode === 'reader' && <button className="btn btn-text btn-sm" onClick={exportLog}>Export activity log</button>}
        </div>
        {copied && <div className="msg msg-success">{copied}</div>}
      </footer>
    </>
  );
}
