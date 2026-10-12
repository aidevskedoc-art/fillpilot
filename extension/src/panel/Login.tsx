import { FormEvent, useState } from 'react';
import type { User } from '../../../web/projects/shared/src/api-types';
import { api, messageOf } from './api';
import { ShieldIcon } from './Icons';
import { Logo } from './Logo';

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  /** Reader installations keep the sign-in in this browser, so the password is changed here too. */
  const [changing, setChanging] = useState(false);
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = api.mode === 'reader';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username || !password) {
      setError('Enter your username and password');
      return;
    }
    if (changing && next !== again) {
      setError('The new password and its repeat are not the same');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onLogin(changing ? await api.changePassword(username, password, next) : await api.login(username, password));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="hero" onSubmit={submit}>
      <div className="hero-brand">
        <Logo size={54} />
        <div>
          <div className="hero-name title-grad">FillPilot</div>
          <div className="muted small">From PDF to web form — you review, you submit</div>
        </div>
      </div>
      {error && <div className="msg msg-error">{error}</div>}
      <label className="field">
        <span>Username</span>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label className="field">
        <span>{changing ? 'Current password' : 'Password'}</span>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      {changing && (
        <>
          <label className="field">
            <span>New password</span>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="field">
            <span>New password again</span>
            <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </label>
        </>
      )}
      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Please wait…' : changing ? 'Change password and sign in' : 'Sign in'}
      </button>
      {local && (
        <button className="btn btn-text btn-sm" type="button" onClick={() => { setChanging((v) => !v); setError(''); }}>
          {changing ? 'Back to sign in' : 'Change password'}
        </button>
      )}
      <div className="safe"><ShieldIcon size={14} /> Never saves or submits a form for you</div>
      <div className="muted small center-text">{local ? 'The sign-in is kept in this browser on this PC' : `Server: ${api.base}`}</div>
    </form>
  );
}
