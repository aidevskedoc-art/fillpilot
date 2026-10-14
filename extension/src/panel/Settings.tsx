import { useCallback, useEffect, useState } from 'react';
import { api, messageOf } from './api';
import { RefreshIcon } from './Icons';

type Reach = 'checking' | 'ok' | 'down';

/**
 * Which server this installation talks to, whether it answers right now, and
 * — for a shared server — a way to point at another one without a new build
 * (api.useServer). The copy that runs on the PC itself (reader) has one fixed
 * address.
 *
 * It is rendered inside the sign-in form too, so it has no <form> of its own.
 */
export function Settings({ onClose, onServerChange, signedIn = false }: { onClose: () => void; onServerChange: () => void; signedIn?: boolean }) {
  const [base, setBase] = useState(api.base);
  const [reach, setReach] = useState<Reach>('checking');
  const [ms, setMs] = useState(0);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const local = api.mode === 'reader';

  const check = useCallback(async () => {
    setReach('checking');
    const answer = await api.ping();
    setMs(answer.ms);
    setReach(answer.ok ? 'ok' : 'down');
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  async function copy() {
    await navigator.clipboard.writeText(base).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /** null = back to the address this copy was built with. */
  async function change(address: string | null) {
    setProblem('');
    try {
      await api.useServer(address);
    } catch (err) {
      setProblem(messageOf(err));
      return;
    }
    setEditing(false);
    if (api.base === base) return;
    setBase(api.base);
    check();
    onServerChange();
  }

  return (
    <div className="card card-pad settings">
      <div className="row-head">
        <div className="label">Settings</div>
        <button className="msg-close muted" type="button" onClick={onClose} aria-label="Close settings">×</button>
      </div>

      <div className="muted small">Server (API) address</div>
      {editing ? (
        <>
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              change(draft);
            }}
            placeholder="http://192.168.1.20:4100"
            spellCheck={false}
            autoFocus
            aria-label="Server address"
          />
          <div className="row-inline">
            <button className="btn btn-primary btn-sm" type="button" onClick={() => change(draft)}>Save</button>
            <button className="btn btn-text btn-sm" type="button" onClick={() => { setEditing(false); setProblem(''); }}>Cancel</button>
          </div>
          {signedIn && <div className="muted small">Saving another server signs you out and clears the bill held in this session.</div>}
        </>
      ) : (
        <div className="row-head">
          <div className="value">{base}</div>
          <div className="row-inline">
            <button className="btn btn-secondary btn-sm" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            {!local && <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setDraft(base); setEditing(true); }}>Change</button>}
          </div>
        </div>
      )}
      {problem && <div className="warn-line bad">{problem}</div>}
      {!local && !editing && base !== api.builtBase && (
        <div className="muted small">
          Built-in address: {api.builtBase}{' '}
          <button className="btn-link" type="button" onClick={() => change(null)}>Use it again</button>
        </div>
      )}

      <div className="row-head">
        <div className="row-inline min-w-0">
          <span className={`dot dot-${reach === 'ok' ? 'ok' : reach === 'down' ? 'bad' : 'wait'}`} />
          <span className={reach === 'down' ? 'bad' : undefined}>
            {reach === 'checking' ? 'Checking…' : reach === 'ok' ? `Connected (${ms} ms)` : 'Not reachable'}
          </span>
        </div>
        <button className="btn-icon" type="button" onClick={check} disabled={reach === 'checking'} title="Check again" aria-label="Check the connection again">
          <RefreshIcon />
        </button>
      </div>
      {reach === 'down' && (local ? (
        <div className="muted small">
          FillPilot is not running on this PC. Double-click "FillPilot-Start.cmd" in the FillPilot folder, then check again.
        </div>
      ) : (
        <div className="muted small">
          No FillPilot server answers at this address. It must be switched on and running, and this computer must be on the same network as it.{' '}
          <a href={`${base}/api/health`} target="_blank" rel="noreferrer">Open the test page</a> — it shows "ok" when the server can be reached.
        </div>
      ))}

      <div className="kv">
        <span className="muted">Installation</span>
        <span>{local ? 'This PC only — the sign-in is kept in this browser' : 'Shared server — the accounts are on the server'}</span>
        <span className="muted">Stored here</span>
        <span>
          {local
            ? 'The sign-in and the activity record; the open bill only until the browser closes'
            : 'The sign-in and the open bill, only until the browser closes'}
        </span>
        <span className="muted">Version</span>
        <span>FillPilot {chrome.runtime.getManifest().version}</span>
        <span className="muted">Extension ID</span>
        <span>{chrome.runtime.id}</span>
      </div>
      <div className="muted small">
        {local
          ? 'This copy reads the bills on this PC; its address is fixed.'
          : 'The bill PDFs are sent to this address to be read. A change is remembered in this browser.'}
      </div>
    </div>
  );
}
