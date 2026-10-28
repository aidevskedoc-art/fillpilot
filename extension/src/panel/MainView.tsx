import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AllowedSite, DocumentDto, MatchResponse, User } from '../../../web/projects/shared/src/api-types';
import type { FieldDescriptor } from '../../../web/projects/shared/src/page-contract';
import { confidenceSeverity, pct } from '../../../web/projects/shared/src/format';
import { api, messageOf } from './api';
import { ActiveTab, bridge } from './page-bridge';
import { ReviewRow, toRow } from './review-model';
import { GuideOverlay } from './Guide';
import { ArrowRightIcon, BoltIcon, InfoIcon, LogOutIcon, MoonIcon, RefreshIcon, ScanIcon, SettingsIcon, ShieldIcon, SunIcon } from './Icons';
import { Logo } from './Logo';
import { Settings } from './Settings';
import { TgnpdclView } from './TgnpdclView';
import { isTgnpdclBillPage } from './tgnpdcl-plan';
import { PmjayView } from './PmjayView';
import { isPmjayPage } from './pmjay-plan';
import { CilView } from './CilView';
import { isCilPage } from './cil-plan';
import { Theme, applyTheme, savedTheme } from './theme';
import { UploadPdfs } from './UploadPdfs';

type SiteState = 'no-tab' | 'unknown' | 'not-approved' | 'ready';

/** "Coal India e-BPA" → "CO", "PM-JAY Provider" → "PM": the badge on a site's card. */
const siteInitials = (name: string) => name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?';
/** "https://www.cilbpa.utiitsl.com" → "www.cilbpa.utiitsl.com". */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The bill sites (TGNPDCL, PM-JAY, Coal India): FillPilot works there in bill entry only, never the any-PDF mode. */
const isBillSite = (url: URL | null) => Boolean(url && /(^|\.)(tgnpdcl\.com|provider\.nha\.gov\.in|cilbpa\.utiitsl\.com)$/i.test(url.hostname));
type RowFilter = 'all' | 'review' | 'matched' | 'unmatched';

export function Main({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTabState] = useState<ActiveTab | null>(null);
  const tabRef = useRef<ActiveTab | null>(null);
  const [sites, setSites] = useState<AllowedSite[]>([]);
  /** The site whose access Chrome is being asked for — its card shows it, the others wait. */
  const [enabling, setEnabling] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentDto[]>([]);
  const [docId, setDocId] = useState('');
  const [match, setMatch] = useState<MatchResponse | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [scanning, setScanning] = useState(false);
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<{ filled: number; failed: number } | null>(null);
  const descriptors = useRef(new Map<string, FieldDescriptor>());
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [settings, setSettings] = useState(false);
  const [guide, setGuide] = useState(false);
  const [copied, setCopied] = useState('');
  const closeGuide = useCallback(() => setGuide(false), []);

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  const setTab = (t: ActiveTab | null) => {
    tabRef.current = t;
    setTabState(t);
  };

  const run = useCallback(async (task: () => Promise<void>) => {
    try {
      await task();
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const resetReview = useCallback(() => {
    setMatch(null);
    setRows([]);
    descriptors.current = new Map();
    setSummary(null);
    setFilter('all');
    setCopied('');
  }, []);

  const refreshTab = useCallback(
    (reset: boolean) =>
      run(async () => {
        setTab(await bridge.activeTab());
        if (reset) resetReview();
      }),
    [run, resetReview],
  );

  const loadDocs = useCallback(
    () =>
      run(async () => {
        const list = await api.completedDocuments();
        setDocs(list);
        setDocId((current) => (current && list.some((d) => d.id === current) ? current : list[0]?.id ?? ''));
      }),
    [run],
  );

  useEffect(() => {
    run(async () => setSites(await api.allowedSites()));
    loadDocs();
    refreshTab(false);

    // A different tab, or the page navigated: field refs are gone, start over.
    const onActivated = () => refreshTab(true);
    const onUpdated = (tabId: number, info: { status?: string; url?: string }) => {
      if (tabId === tabRef.current?.tabId && (info.status === 'complete' || info.url)) refreshTab(true);
    };
    const onPageHide = () => {
      if (tabRef.current) bridge.clear(tabRef.current.tabId);
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [run, loadDocs, refreshTab]);

  const site = useMemo(() => {
    const origin = tab?.url?.origin;
    return origin ? sites.find((s) => s.origin === origin) ?? null : null;
  }, [tab, sites]);
  const siteState: SiteState = !tab ? 'no-tab' : !tab.url ? 'unknown' : site ? 'ready' : 'not-approved';

  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const visibleRows = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  const fillCount = rows.filter((r) => r.include && r.selected?.fillValue != null).length;
  const notFound = match?.notFound.map((n) => n.label).join(', ') ?? '';

  const patch = (ref: string, changes: Partial<ReviewRow>) =>
    setRows((current) => current.map((r) => (r.ref === ref ? { ...r, ...changes } : r)));

  const highlight = (row: ReviewRow) => {
    if (tabRef.current) bridge.highlight(tabRef.current.tabId, row.ref);
  };

  const enable = (s: AllowedSite) => {
    setEnabling(s.origin);
    return run(async () => {
      try {
        if (!(await bridge.requestAccess(s.origin))) {
          setError(`Chrome did not give access to ${s.origin} — choose it again and press "Allow".`);
          return;
        }
        const now = await bridge.activeTab();
        setTab(now);
        resetReview();
        // Access is given to the approved address only: a tab on any other one (http/https, "www.", a port) stays unreadable.
        if (now && !now.url) {
          setError(`Access was given to ${s.origin}, but this tab is on a different address, so FillPilot still cannot read it. `
            + `The address bar must begin exactly with ${s.origin} — if it does not (http or https, "www.", a port number), that address has to be approved on the server.`);
        }
      } finally {
        setEnabling(null);
      }
    });
  };

  const scan = () => {
    const t = tabRef.current;
    if (!t?.url || !docId) return;
    setScanning(true);
    setError('');
    resetReview();
    run(async () => {
      const fields = await bridge.scan(t.tabId);
      if (!fields.length) throw new Error('No fillable fields found on this page.');
      descriptors.current = new Map(fields.map((f) => [f.ref, f]));
      const result = await api.match([docId], { origin: t.url!.origin, path: t.url!.pathname, title: t.title }, fields);
      setMatch(result);
      setRows(result.fields.map((f) => toRow(f, result.availableFields)));
    }).finally(() => setScanning(false));
  };

  /** The user picked a different PDF field (or none) for a web field. */
  const remap = (row: ReviewRow, value: string) => {
    const fieldId = value === '' ? null : Number(value);
    if (fieldId === (row.selected?.fieldId ?? null)) return;
    if (fieldId === null) {
      patch(row.ref, { selected: null, include: false, manual: true, status: 'review', warnings: [] });
      return;
    }
    const descriptor = descriptors.current.get(row.ref);
    const origin = tabRef.current?.url?.origin;
    const field = match?.availableFields.find((a) => a.fieldId === fieldId);
    if (!descriptor || !origin || !field) return;
    run(async () => {
      const f = await api.format(fieldId, descriptor, origin);
      patch(row.ref, {
        selected: { fieldId, documentId: field.documentId, fieldKey: field.fieldKey, label: field.label, originalValue: f.originalValue, fillValue: f.fillValue, confidence: 1, source: 'manual' },
        include: f.fillValue !== null,
        manual: true,
        status: 'review',
        warnings: f.problem ? [f.problem, ...f.warnings] : f.warnings,
      });
    });
  };

  const fill = () => {
    const t = tabRef.current;
    if (!t?.url || !match) return;
    const toFill = rows.filter((r) => r.include && r.selected?.fillValue != null);
    setFilling(true);
    run(async () => {
      const outcomes = await bridge.fill(t.tabId, toFill.map((r) => ({ ref: r.ref, value: r.selected!.fillValue! })));
      const byRef = new Map(outcomes.map((o) => [o.ref, o]));
      const updated = rows.map((r): ReviewRow => {
        const o = byRef.get(r.ref);
        if (!o) return { ...r, outcome: 'skipped', error: undefined };
        return { ...r, outcome: o.ok ? 'filled' : 'failed', error: o.error };
      });
      setRows(updated);
      setSummary({ filled: updated.filter((r) => r.outcome === 'filled').length, failed: updated.filter((r) => r.outcome === 'failed').length });
      await recordAudit(t, match, updated);
    }).finally(() => setFilling(false));
  };

  /** Audit (labels/keys/outcomes only), saved manual mappings, and usage of saved ones. Best effort. */
  async function recordAudit(t: ActiveTab, m: MatchResponse, done: ReviewRow[]) {
    const origin = t.url!.origin;
    const path = t.url!.pathname;
    await api
      .recordFill({
        documentIds: m.documents.map((d) => d.id),
        origin,
        path,
        formTitle: t.title,
        detected: done.length,
        autoMatched: done.filter((r) => r.initialStatus === 'matched').length,
        fields: done.map((r) => ({
          label: r.label,
          fieldKey: r.selected?.fieldKey ?? null,
          confidence: r.selected?.confidence ?? null,
          source: r.manual ? 'manual' : r.selected?.source ?? null,
          reviewed: r.initialStatus !== 'matched' && r.outcome === 'filled',
          outcome: r.outcome ?? 'skipped',
        })),
      })
      .catch((err) => setError(`Filled, but the activity log could not be saved: ${messageOf(err)}`));

    for (const r of done.filter((x) => x.manual && x.save && x.selected)) {
      const field = m.availableFields.find((a) => a.fieldId === r.selected!.fieldId);
      await api
        .saveMapping({ origin, path, signature: r.signature, webFieldLabel: r.label, fieldKey: r.selected!.fieldKey, canonicalKey: field?.canonicalKey ?? null })
        .catch((err) => setError(`Could not save the mapping for "${r.label}": ${messageOf(err)}`));
    }
    const used = done.filter((r) => r.selected?.source === 'saved' && r.outcome === 'filled').map((r) => r.signature);
    if (used.length) await api.markMappingsUsed(origin, path, used).catch(() => undefined);
  }

  /**
   * For writing a site profile (like the TGNPDCL one): the page's labels, buttons,
   * tabs, column headings and list items, to paste to the developer. Never the
   * values typed into fields — but lists show what the page shows, so it is checked first.
   */
  const copyStructure = () => {
    const t = tabRef.current;
    if (!t) return;
    run(async () => {
      const outline = await bridge.describePage(t.tabId);
      await navigator.clipboard.writeText(JSON.stringify(outline, null, 2));
      setCopied('Page structure copied. Paste it to the developer. It has the labels, buttons and lists of this page, not what is typed in the fields. '
        + 'Read it before sending: dropdowns and clickable lists are copied as the page shows them, so remove any patient names or numbers.');
    });
  };

  async function logout() {
    if (tabRef.current) await bridge.clear(tabRef.current.tabId);
    resetReview();
    await api.logout();
    onLogout();
  }

  /** Another server was chosen in the settings; the sign-in went with the old one (api.useServer). */
  async function serverChanged() {
    if (tabRef.current) await bridge.clear(tabRef.current.tabId);
    onLogout();
  }

  return (
    <div className="main">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div className="min-w-0">
            <div className="title title-grad">FillPilot</div>
            <div className="muted small truncate">{user.fullName}</div>
          </div>
        </div>
        <div className="row-inline">
          <button className="btn-icon" onClick={() => setGuide(true)} title="How FillPilot works" aria-label="How FillPilot works"><InfoIcon /></button>
          <button className="btn-icon" onClick={() => setSettings((open) => !open)} title="Settings" aria-label="Settings" aria-expanded={settings}><SettingsIcon /></button>
          <button className="btn-icon" onClick={toggleTheme} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Switch theme">
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="btn-icon" onClick={logout} title="Sign out" aria-label="Sign out"><LogOutIcon /></button>
        </div>
      </header>

      {settings && (
        <div className="section">
          <Settings onClose={() => setSettings(false)} onServerChange={serverChanged} signedIn />
        </div>
      )}

      {error && (
        <div className="section">
          <div className="msg msg-error">
            <span>{error}</span>
            <button className="msg-close" onClick={() => setError('')} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}

      <section className="section">
        <div className="label">Website</div>
        {siteState === 'ready' && (
          <div className="site-ok">
            <span className="dot dot-ok" />
            <div className="min-w-0">
              <div className="strong truncate">{site?.displayName}</div>
              <div className="muted small truncate">{tab?.title}</div>
            </div>
          </div>
        )}
        {siteState === 'not-approved' && (
          <div className="msg msg-warn">
            {tab?.url?.origin} is not approved for form filling. An administrator can add it in the dashboard (Mappings → Allowed sites).
          </div>
        )}
        {siteState === 'unknown' && (
          <>
            <p className="muted small">Open the website, then choose it here to let FillPilot work on it.</p>
            {sites.length === 0 && <p className="muted small">No websites are approved yet.</p>}
            <div className="site-list">
              {sites.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="site-card"
                  disabled={enabling !== null}
                  onClick={() => enable(s)}
                  aria-label={`Enable FillPilot on ${s.displayName}`}
                >
                  <span className="site-badge" aria-hidden="true">{siteInitials(s.displayName)}</span>
                  <span className="site-text">
                    <span className="site-name truncate">{s.displayName}</span>
                    <span className="site-host truncate">{hostOf(s.origin)}</span>
                  </span>
                  <span className="site-action">{enabling === s.origin ? 'Enabling…' : <>Enable <ArrowRightIcon size={14} /></>}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {siteState === 'no-tab' && <p className="muted small">No active tab.</p>}
      </section>

      {siteState === 'ready' && tab && isTgnpdclBillPage(tab.url) ? (
        <TgnpdclView tab={tab} onError={setError} />
      ) : siteState === 'ready' && tab && isPmjayPage(tab.url) && api.mode !== 'reader' ? (
        <PmjayView tab={tab} onError={setError} />
      ) : siteState === 'ready' && tab && isCilPage(tab.url) && api.mode !== 'reader' ? (
        <CilView tab={tab} onError={setError} />
      ) : api.mode === 'reader' ? (
        <section className="section">
          <div className="card card-pad">
            <div className="strong">Open the bill on the website</div>
            <div className="muted small mt-sm">
              Go to the TGNPDCL medical bill entry page and open the patient's bill. FillPilot switches to bill entry there.
            </div>
          </div>
        </section>
      ) : siteState !== 'ready' || isBillSite(tab?.url ?? null) ? (
        // The document list and Scan are for other approved forms: not before a site is enabled, nor on a bill site's other pages.
        <section className="section">
          <div className="card card-pad">
            <div className="strong">{siteState === 'ready' ? 'Open the patient\'s bill on this site' : 'Open the website and enable it'}</div>
            <div className="muted small mt-sm">
              {siteState === 'ready'
                ? 'FillPilot switches to bill entry on the bill page: TGNPDCL medical bill entry, the PM-JAY case, or the Coal India claim.'
                : 'Go to TGNPDCL, PM-JAY or Coal India and press Enable above for that site. On the bill page FillPilot switches to bill entry.'}
            </div>
          </div>
        </section>
      ) : (
      <>
      <section className="section">
        <div className="label">Document</div>
        <div className="row-inline">
          <select
            className="input"
            value={docId}
            onChange={(e) => {
              setDocId(e.target.value);
              resetReview();
            }}
          >
            {docs.length === 0 && <option value="">No documents yet — upload a PDF below</option>}
            {docs.map((d) => (
              <option key={d.id} value={d.id}>{d.fileName}</option>
            ))}
          </select>
          <button className="btn-icon" onClick={loadDocs} title="Reload documents" aria-label="Reload documents"><RefreshIcon /></button>
        </div>
        <button className="btn btn-primary btn-block mt" disabled={siteState !== 'ready' || !docId || scanning} onClick={scan}>
          <ScanIcon /> {scanning ? 'Scanning…' : 'Scan this page'}
        </button>
        <div className="mt">
          <UploadPdfs
            label="Upload a PDF"
            disabled={scanning || filling}
            onError={setError}
            onDone={async (read) => {
              await loadDocs();
              if (read[0]) {
                setDocId(read[0].id);
                resetReview();
              }
            }}
          />
        </div>
        {siteState === 'ready' && (
          <div className="mt-sm center-text">
            <button className="btn btn-text btn-sm" onClick={copyStructure}>Copy page structure</button>
            {copied && <div className="msg msg-success mt-sm">{copied}</div>}
          </div>
        )}
      </section>

      {match && (
        <>
          <section className="section">
            <div className="stats">
              <div className="card stat"><div className="stat-value">{match.summary.detected}</div><div className="muted small">fields detected</div></div>
              <div className="card stat"><div className="stat-value ok">{count('matched')}</div><div className="muted small">ready to fill</div></div>
              <div className="card stat"><div className="stat-value warn">{count('review')}</div><div className="muted small">need review</div></div>
            </div>
            <div className="segmented" role="tablist">
              {(
                [
                  ['all', `All ${rows.length}`],
                  ['review', `Review ${count('review')}`],
                  ['matched', `Matched ${count('matched')}`],
                  ['unmatched', `None ${count('unmatched')}`],
                ] as [RowFilter, string][]
              ).map(([value, label]) => (
                <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
          </section>

          <div className="rows">
            {visibleRows.map((row) => (
              <div key={row.ref} className={`review-row${row.include ? '' : ' excluded'}`} onMouseEnter={() => highlight(row)} onFocus={() => highlight(row)}>
                <input
                  type="checkbox"
                  checked={row.include}
                  disabled={row.selected?.fillValue == null}
                  onChange={(e) => patch(row.ref, { include: e.target.checked })}
                  aria-label={`Fill ${row.label}`}
                />
                <div className="min-w-0 grow">
                  <div className="row-head">
                    <div className="strong truncate" title={row.label}>
                      {row.label}
                      {row.required && <span className="req">*</span>}
                    </div>
                    {row.selected ? (
                      <span className={`tag tag-${row.manual ? 'info' : confidenceSeverity(row.selected.confidence)}`}>
                        {row.manual ? 'manual' : pct(row.selected.confidence)}
                      </span>
                    ) : (
                      <span className="tag tag-secondary">no match</span>
                    )}
                  </div>
                  <select className="input input-sm" value={row.selected?.fieldId ?? ''} onChange={(e) => remap(row, e.target.value)}>
                    <option value="">— Don't fill —</option>
                    {row.options.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.items.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {row.selected && (
                    <div className="value">
                      {row.selected.fillValue != null && row.selected.fillValue !== row.selected.originalValue ? (
                        <>
                          <span className="muted">{row.selected.originalValue}</span> → {row.selected.fillValue}
                        </>
                      ) : (
                        row.selected.originalValue
                      )}
                    </div>
                  )}
                  {row.warnings.map((w) => (
                    <div key={w} className="warn-line">⚠ {w}</div>
                  ))}
                  {row.manual && row.selected && (
                    <label className="remember">
                      <input type="checkbox" checked={row.save} onChange={(e) => patch(row.ref, { save: e.target.checked })} /> Remember for this form
                    </label>
                  )}
                  {row.outcome === 'filled' && <div className="outcome ok">✓ Filled</div>}
                  {row.outcome === 'failed' && <div className="outcome bad">✗ {row.error}</div>}
                </div>
              </div>
            ))}
            {visibleRows.length === 0 && <div className="section muted small center-text">Nothing in this view.</div>}
            {notFound && (
              <div className="section muted small">
                <div className="strong">Not on this form ({match.notFound.length}):</div>
                {notFound}
              </div>
            )}
          </div>

          <footer className="footer">
            {summary && (
              <div className={`msg ${summary.failed ? 'msg-warn' : 'msg-success'}`}>
                {summary.filled} filled{summary.failed ? `, ${summary.failed} failed` : ''}. Check the form, then submit it yourself.
              </div>
            )}
            <button className="btn btn-primary btn-block" disabled={fillCount === 0 || filling} onClick={fill}>
              <BoltIcon /> {filling ? 'Filling…' : `Fill ${fillCount} field${fillCount === 1 ? '' : 's'}`}
            </button>
            <div className="safe"><ShieldIcon size={14} /> Nothing is submitted — you review and submit the form.</div>
          </footer>
        </>
      )}
      </>
      )}

      {guide && <GuideOverlay onClose={closeGuide} />}
    </div>
  );
}
