// "How FillPilot works" — a short, illustrated explanation for the people who
// use FillPilot or decide on it. Opened from the ⓘ icon in the panel, or as a
// full page (panel/index.html?guide) that can be printed or saved as a PDF.
import { ReactNode, useEffect, useRef } from 'react';
import { api } from './api';
import { CheckIcon, ExternalIcon, InfoIcon, PrintIcon, ShieldIcon } from './Icons';
import { Logo } from './Logo';

type Level = 'full' | 'part' | 'you';

const TABS: { n: number; name: string; level: Level; fills: string; you: string }[] = [
  {
    n: 1,
    name: 'Room & Consultation',
    level: 'full',
    fills: 'ICU days, the ward rows (rate and days), the number of doctors, and each doctor with their days.',
    you: 'Check the ward type — it is chosen only when the site\'s rate is the same as the bill\'s. Add any doctor specialization the bill does not show.',
  },
  {
    n: 2,
    name: 'Investigations and Procedures',
    level: 'part',
    fills: 'Every tariff code on the bill, with its quantity and the amount claimed, picked from the site\'s own tariff list. It warns when the site\'s rate does not match the bill.',
    you: 'The items FillPilot lists as not added (no code on the bill, or a tariff type it does not know), implants, reports and the declaration.',
  },
  {
    n: 3,
    name: 'Pharmacy',
    level: 'you',
    fills: 'Opens the tab.',
    you: 'The pharmacy items — the bills give only a pharmacy total, not an item-wise list.',
  },
  {
    n: 4,
    name: 'Summary',
    level: 'part',
    fills: 'Employee paid, concession, and the hospital bill number.',
    you: 'Check the totals, tick the declarations, and press Save & Submit.',
  },
];

/** What is stored, where, and for how long: [what, where, how long]. Checked against the code, 2026-10-12. */
const STORAGE: Record<'server' | 'reader', [string, string, string][]> = {
  server: [
    ['The bill PDFs', 'Server memory, only while reading', 'Never saved'],
    ['Scanned page images', 'Server\'s temporary folder', 'Deleted straight after reading'],
    ['The open bill (patient, items, amounts)', 'This browser, session memory', 'Until Finished, sign-out or closing the browser'],
    ['Your sign-in', 'This browser, session memory', 'Until sign-out or closing the browser'],
    ['Accounts and approved websites', 'Server database (PostgreSQL)', 'Until an administrator removes them'],
    ['Fill records: who, when, which tab, how each step went — no patient names', 'Server database (PostgreSQL)', 'Kept, for support'],
    ['Theme and chosen server address', 'This browser', 'Until you change them'],
  ],
  reader: [
    ['The bill PDFs', 'Memory on this PC, only while reading', 'Never saved'],
    ['Scanned page images', 'This PC\'s temporary folder', 'Deleted straight after reading'],
    ['The open bill (patient, items, amounts)', 'This browser, session memory', 'Until Finished, sign-out or closing the browser'],
    ['Sign-in (password stored scrambled)', 'This browser', 'Until you change it'],
    ['Activity record: which steps ran and how — no patient names', 'This browser', 'The latest 30 runs; "Export activity log" saves them for support'],
    ['Theme', 'This browser', 'Until you change it'],
  ],
};

function Figure({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <figure className="fig card">
      {children}
      <figcaption><span className="fig-n">Figure {n}</span> {title}</figcaption>
    </figure>
  );
}

/** Figure 1: PDFs → FillPilot → the site's form → the person. */
function FlowFigure() {
  const labels = [['Final bill +', 'summary bill'], ['FillPilot', 'reads them'], ['Bill entry', 'filled tab by tab'], ['You check', 'and submit']];
  return (
    <svg viewBox="0 0 360 112" role="img" aria-label="The bill PDFs go to FillPilot, which fills the bill entry form; you check it and submit.">
      <defs>
        <linearGradient id="fp-guide-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cff" />
          <stop offset="0.52" stopColor="#3d7bff" />
          <stop offset="1" stopColor="#19e0ff" />
        </linearGradient>
        <marker id="fp-guide-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" className="fig-head" />
        </marker>
      </defs>
      {[45, 135, 225].map((x) => <line key={x} x1={x + 31} y1={42} x2={x + 58} y2={42} className="fig-arrow" markerEnd="url(#fp-guide-arrow)" />)}

      {/* the two bill PDFs */}
      <rect x={17} y={14} width={56} height={56} rx={14} className="fig-node" />
      <rect x={28} y={22} width={22} height={28} rx={2} className="fig-page" />
      <rect x={36} y={29} width={24} height={31} rx={2} className="fig-page" />
      <path d="M40 36h16M40 41h12" className="fig-line" />
      <text x={48} y={55} className="fig-pdf">PDF</text>

      {/* FillPilot */}
      <rect x={107} y={14} width={56} height={56} rx={14} fill="url(#fp-guide-grad)" />
      <path d="M13 2 4.5 13.5H11l-1 8.5 9.5-12.5H13z" fill="#fff" transform="translate(120 27) scale(1.25)" />

      {/* the site's form, filled */}
      <rect x={197} y={14} width={56} height={56} rx={14} className="fig-node" />
      <rect x={207} y={22} width={36} height={40} rx={3} className="fig-page" />
      {[30, 39, 48].map((y) => (
        <g key={y}>
          <path d={`M211 ${y + 3}h7`} className="fig-line" />
          <rect x={221} y={y} width={18} height={6} rx={1.5} className="fig-filled" />
        </g>
      ))}

      {/* the person */}
      <rect x={287} y={14} width={56} height={56} rx={14} className="fig-node" />
      <circle cx={315} cy={42} r={15} className="fig-ok" />
      <path d="m307.5 42.5 5 5 10-10.5" className="fig-tick" />

      {labels.map(([a, b], i) => (
        <g key={a}>
          <text x={45 + i * 90} y={88} className="fig-label">{a}</text>
          <text x={45 + i * 90} y={102} className="fig-label-sub">{b}</text>
        </g>
      ))}
    </svg>
  );
}

/** Figure 2: where each part runs, and that nothing goes outside. */
function WhereFigure({ local }: { local: boolean }) {
  const box = (x: number, y: number, title: string, a: string, b: string, cls = '') => (
    <g>
      <rect x={x} y={y} width={160} height={76} rx={12} className={`fig-box ${cls}`} />
      <text x={x + 12} y={y + 24} className="fig-title">{title}</text>
      <text x={x + 12} y={y + 42} className="fig-sub">{a}</text>
      <text x={x + 12} y={y + 58} className="fig-sub">{b}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 360 214" role="img" aria-label="Your computer runs Chrome with FillPilot and fills the TGNPDCL website. The bill PDFs are read by FillPilot, which keeps nothing. No outside service or AI is used.">
      <defs>
        <marker id="fp-guide-arrow2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" className="fig-head" />
        </marker>
      </defs>
      {box(8, 8, 'This computer', 'Chrome + FillPilot', 'you check and submit')}
      {box(192, 8, 'TGNPDCL website', 'bill entry form', 'filled; Next pressed')}
      {box(8, 130, local ? 'FillPilot on this PC' : 'FillPilot server', local ? 'runs on this computer' : 'your own server', 'reads the PDFs, keeps none', 'fig-accent')}
      {box(192, 130, 'Outside services', 'no AI, no cloud service', 'nothing is sent there', 'fig-dashed')}
      <circle cx={334} cy={150} r={9} className="fig-no" />
      <path d="m330 146 8 8m0-8-8 8" className="fig-no" />

      <line x1={170} y1={46} x2={189} y2={46} className="fig-arrow" markerEnd="url(#fp-guide-arrow2)" />
      <line x1={46} y1={86} x2={46} y2={126} className="fig-arrow" markerEnd="url(#fp-guide-arrow2)" />
      <text x={54} y={110} className="fig-note">bill PDFs</text>
      <line x1={126} y1={128} x2={126} y2={88} className="fig-arrow" markerEnd="url(#fp-guide-arrow2)" />
      <text x={134} y={110} className="fig-note">bill data</text>
    </svg>
  );
}

/** Figure 3: the site's five tabs and who fills each. */
function TabsFigure() {
  const tabs: [string, string, Level][] = [['0', 'CC', 'you'], ['1', 'Room', 'full'], ['2', 'Investigations', 'part'], ['3', 'Pharmacy', 'you'], ['4', 'Summary', 'part']];
  const legend: [Level, string][] = [['full', 'FillPilot fills'], ['part', 'fills part — you finish'], ['you', 'you fill']];
  return (
    <svg viewBox="0 0 360 76" role="img" aria-label="Tab 1 is filled by FillPilot; tabs 2 and 4 partly; tab 0 and tab 3 are filled by you.">
      {tabs.map(([n, name, level], i) => (
        <g key={n}>
          <rect x={4 + i * 71} y={4} width={66} height={44} rx={8} className={`fig-tab-${level}`} />
          <text x={37 + i * 71} y={22} className="fig-tab-n">{n}</text>
          <text x={37 + i * 71} y={38} className="fig-tab-name">{name}</text>
        </g>
      ))}
      {legend.map(([level, text], i) => (
        <g key={level}>
          <rect x={4 + i * 120} y={58} width={10} height={10} rx={2} className={`fig-tab-${level}`} />
          <text x={19 + i * 120} y={67} className="fig-note">{text}</text>
        </g>
      ))}
    </svg>
  );
}

/** Figure 4: the places data is kept, and what is never kept. */
function StorageFigure({ local }: { local: boolean }) {
  const box = (x: number, y: number, title: string, a: string, b: string, foot: string, cls = '') => (
    <g>
      <rect x={x} y={y} width={160} height={82} rx={12} className={`fig-box ${cls}`} />
      <text x={x + 12} y={y + 22} className="fig-title">{title}</text>
      <text x={x + 12} y={y + 40} className="fig-sub">• {a}</text>
      <text x={x + 12} y={y + 54} className="fig-sub">• {b}</text>
      <text x={x + 12} y={y + 72} className={cls === 'fig-dashed' ? 'fig-foot-ok' : 'fig-foot'}>{foot}</text>
    </g>
  );
  const browser = (x: number, y: number) => (
    <g className="fig-icon">
      <rect x={x} y={y} width={18} height={14} rx={2.5} />
      <path d={`M${x} ${y + 4.5}h18`} />
    </g>
  );
  return (
    <svg viewBox="0 0 360 200" role="img" aria-label="The sign-in and the open bill are kept in the browser session until it closes. The PDFs and page images are not kept anywhere.">
      {box(8, 8, 'Browser session', 'your sign-in', 'the open bill', 'cleared when it closes')}
      {browser(141, 15)}
      {local
        ? box(192, 8, 'Browser storage', 'sign-in (scrambled)', 'last 30 activity runs', 'stays in this browser')
        : box(192, 8, 'Browser storage', 'theme', 'chosen server address', 'until you change it')}
      {browser(325, 15)}
      {local
        ? box(8, 110, 'FillPilot on this PC', 'no database', 'reads PDFs in memory', 'keeps no bills')
        : box(8, 110, 'Server database', 'accounts, websites', 'fill records (no names)', 'kept for support', 'fig-accent')}
      {!local && (
        <g className="fig-icon">
          <ellipse cx={150} cy={121} rx={9} ry={3.5} />
          <path d="M141 121v13c0 2 4 3.5 9 3.5s9-1.5 9-3.5v-13M141 127.5c0 2 4 3.5 9 3.5s9-1.5 9-3.5" />
        </g>
      )}
      {box(192, 110, 'Not kept anywhere', 'the bill PDFs', 'scanned page images', 'deleted once read', 'fig-dashed')}
      <circle cx={334} cy={128} r={9} className="fig-no" />
      <path d="m330 124 8 8m0-8-8 8" className="fig-no" />
    </svg>
  );
}

export function Guide() {
  const local = api.mode === 'reader';
  return (
    <article className="guide">
      <p className="guide-lead">
        FillPilot reads a patient's hospital bills and fills the TGNPDCL medical bill entry from them.
        You check every value and submit the bill yourself — FillPilot never submits.
      </p>

      <Figure n={1} title="From bill to form"><FlowFigure /></Figure>

      <h3>Step by step</h3>
      <ol className="guide-steps">
        <li><b>Open the patient's bill on the TGNPDCL site.</b> FillPilot sees the bill entry page and gets ready for it.</li>
        <li><b>Drop the two PDFs on FillPilot</b> — the final bill and the summary bill. Scanned bills are fine.</li>
        <li>
          <b>FillPilot reads them</b>, usually in 5 to 20 seconds, and shows the patient, IP number, bill number and total.
          It also checks the bill's own sums and points out anything that does not add up.
        </li>
        <li>
          <b>Fill one tab at a time.</b> Each step lists what it will type; <i>Fill this tab</i> types it and <i>Next</i> moves the site on.
          Before every fill, FillPilot checks that the site still shows the same patient (IP number).
        </li>
        <li>
          <b>Check, complete and submit.</b> Finish what FillPilot lists for you, tick the declarations and press Save &amp; Submit yourself.
          Then press <i>Finished — clear this bill</i>.
        </li>
      </ol>

      <Figure n={2} title="Where it runs"><WhereFigure local={local} /></Figure>
      <p className="muted small">
        {local
          ? 'The FillPilot program on this computer reads the PDFs and keeps neither the PDFs nor the bill.'
          : 'The PDFs go to the FillPilot server, which reads them and sends back only what the form needs. It keeps neither the PDFs nor the bill.'}{' '}
        No outside service or AI is used: the bills are read with rules written for them.
      </p>

      <Figure n={3} title="What it fills on each tab"><TabsFigure /></Figure>
      <div className="guide-tabs">
        {TABS.map((t) => (
          <div key={t.n} className="card card-pad guide-tab">
            <div className="row-inline">
              <span className={`guide-badge guide-badge-${t.level}`}>{t.n}</span>
              <span className="strong">{t.name}</span>
            </div>
            <div className="small"><span className="guide-key ok">FillPilot</span> {t.fills}</div>
            <div className="small"><span className="guide-key">You</span> {t.you}</div>
          </div>
        ))}
      </div>

      <h3>Safe by design</h3>
      <div className="guide-two">
        <div className="card card-pad">
          <div className="strong bad">FillPilot never</div>
          <ul className="guide-list guide-list-no">
            <li>presses Save as Draft or Save &amp; Submit</li>
            <li>ticks a declaration</li>
            <li>guesses a tariff type or a ward</li>
            <li>keeps the PDFs or the bill</li>
          </ul>
        </div>
        <div className="card card-pad">
          <div className="strong ok">FillPilot always</div>
          <ul className="guide-list guide-list-yes">
            <li>shows what it will fill first</li>
            <li>checks it is the same patient</li>
            <li>lists what it could not fill</li>
            <li>leaves the final check to you</li>
          </ul>
        </div>
      </div>

      <h3>What is stored, and where</h3>
      <Figure n={4} title="Where data is kept"><StorageFigure local={local} /></Figure>
      <div className="guide-store">
        <div className="guide-store-row guide-store-head"><span>What</span><span>Where</span><span>How long</span></div>
        {STORAGE[local ? 'reader' : 'server'].map(([what, where, long]) => (
          <div key={what} className="guide-store-row">
            <span className="strong">{what}</span>
            <span data-k="Where">{where}</span>
            <span data-k="How long" className="muted">{long}</span>
          </div>
        ))}
      </div>
      {!local && (
        <p className="muted small">
          Bill entry stores no bill on the server. Only the general <i>Upload a PDF</i> feature (any PDF, not used for bill entry) keeps a document on the server, for the number of days set there.
        </p>
      )}

      <h3>Good to know</h3>
      <ul className="guide-list">
        <li>Tariff codes are added one at a time, so a long bill takes a few minutes on tab 2. <i>Stop</i> pauses it; <i>Fill</i> carries on.</li>
        <li>If the TGNPDCL site renames a label, FillPilot stops at that step and says which label it could not find.</li>
        <li>
          {local
            ? 'The gear icon shows whether FillPilot is running on this PC.'
            : 'The gear icon shows which server FillPilot uses and whether it can be reached.'}
        </li>
      </ul>
    </article>
  );
}

/** The guide over the side panel. It covers the panel without closing anything under it — a fill keeps running. */
export function GuideOverlay({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div ref={dialog} className="guide-overlay" role="dialog" aria-modal="true" aria-labelledby="fp-guide-title" tabIndex={-1}>
      <header className="topbar">
        <div className="brand">
          <InfoIcon size={18} />
          <div className="title" id="fp-guide-title">How FillPilot works</div>
        </div>
        <div className="row-inline">
          <button
            className="btn-icon"
            type="button"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('panel/index.html?guide') })}
            title="Open as a full page (to show or print)"
            aria-label="Open as a full page"
          >
            <ExternalIcon />
          </button>
          <button className="btn-icon" type="button" onClick={onClose} title="Close" aria-label="Close the guide">×</button>
        </div>
      </header>
      <div className="section">
        <Guide />
      </div>
    </div>
  );
}

/** The guide as a page of its own, wide enough to present, and printable (always in the light theme on paper). */
export function GuidePage() {
  useEffect(() => {
    document.title = 'How FillPilot works';
    const root = document.documentElement;
    let theme = root.dataset.theme;
    const before = () => {
      theme = root.dataset.theme;
      root.dataset.theme = 'light';
    };
    const after = () => {
      if (theme) root.dataset.theme = theme;
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  return (
    <div className="guide-page">
      <header className="guide-page-head">
        <div className="brand">
          <Logo size={40} />
          <div>
            <div className="hero-name title-grad">FillPilot</div>
            <div className="muted small">How it works</div>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm no-print" type="button" onClick={() => window.print()}>
          <PrintIcon size={14} /> Print / save as PDF
        </button>
      </header>
      <Guide />
      <footer className="guide-page-foot muted small">
        <ShieldIcon size={14} /> FillPilot {chrome.runtime.getManifest().version} · fills and presses Next only <CheckIcon size={14} /> you submit
      </footer>
    </div>
  );
}
