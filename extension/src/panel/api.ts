// Backend calls from the panel. The sign-in lives in chrome.storage.session —
// memory only, cleared when the browser closes, never written to disk.
//
// Two kinds of installation (config.json, written by build.mjs):
//   server  the full backend: accounts, approved sites and the fill history
//           are on the server (PostgreSQL), and every call carries a token.
//   reader  the backend only reads bill PDFs and stores nothing. The sign-in
//           (local-account.ts), the approved sites (config.json) and the
//           activity log (activity-log.ts) live in the extension itself.
import type {
  AllowedSite, CilClaim, DocumentDto, FormatResponse, LoginResponse, MatchResponse, PmjayClaim, TgnpdclClaim, UploadResponse, User,
} from '../../../web/projects/shared/src/api-types';
import type { FieldDescriptor, PageInfo } from '../../../web/projects/shared/src/page-contract';
import { activityLog } from './activity-log';
import { billSession, cilSession, pmjayAdded, pmjaySession } from './bill-session';
import { FirstLogin, localAccount } from './local-account';

const SESSION_KEY = 'pfa.session';
/** chrome.storage.local: the server chosen in the settings, when it is not the one this copy was built with. */
const SERVER_KEY = 'fillpilot.server';

interface Session {
  token: string;
  user: User;
}

interface PanelConfig {
  apiBase: string;
  mode?: 'server' | 'reader';
  sites?: { origin: string; displayName: string }[];
  defaultLogin?: FirstLogin;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** "192.168.1.20:4100" or a full URL → "http://192.168.1.20:4100". Throws when it is not a web address. */
export function serverOrigin(input: string): string {
  const text = input.trim();
  let url: URL | null = null;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    /* reported below */
  }
  if (!text || !url || !/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new ApiError('That is not a server address. Write it like http://192.168.1.20:4100', 0);
  }
  return url.origin;
}

class PanelApi {
  base = 'http://localhost:4100';
  /** The address this copy was built with (config.json). `base` differs once another one is chosen in the settings. */
  builtBase = this.base;
  mode: 'server' | 'reader' = 'server';
  private sites: AllowedSite[] = [];
  private firstLogin: FirstLogin | null = null;
  private token: string | null = null;
  /** Called when the server rejects the token (expired), so the UI can show the login. */
  onSessionEnd: (() => void) | null = null;

  /** Loads config.json (written by build.mjs) and any session from this browser session. */
  async init(): Promise<User | null> {
    try {
      const res = await fetch('./config.json', { cache: 'no-store' });
      if (res.ok) {
        const config = (await res.json()) as PanelConfig;
        this.base = this.builtBase = config.apiBase;
        this.mode = config.mode === 'reader' ? 'reader' : 'server';
        this.sites = (config.sites ?? []).map((s, i) => ({ id: i + 1, origin: s.origin, displayName: s.displayName, isActive: true, createdAt: '' }));
        this.firstLogin = config.defaultLogin ?? null;
      }
    } catch {
      /* no config.json — keep the defaults */
    }
    if (this.mode === 'server') {
      const chosen = (await chrome.storage.local.get(SERVER_KEY))[SERVER_KEY];
      if (typeof chosen === 'string' && chosen) this.base = chosen;
    }
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const session = stored[SESSION_KEY] as Session | undefined;
    this.token = session?.token || null;
    return session?.user ?? null;
  }

  /** Does a FillPilot server answer at `base` right now? Needs no sign-in — for the settings card. */
  async ping(): Promise<{ ok: boolean; ms: number }> {
    const started = performance.now();
    let ok = false;
    try {
      const res = await fetch(`${this.base}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      ok = res.ok && ((await res.json()) as { status?: string }).status === 'ok';
    } catch {
      /* not reachable, no answer in time, or something else answers there */
    }
    return { ok, ms: Math.round(performance.now() - started) };
  }

  /**
   * Points this installation at another server; null goes back to the one it
   * was built with. The choice stays in this browser (chrome.storage.local).
   * A sign-in belongs to the server that gave it, so it ends here, and the
   * bill held for the session goes with it. The new server must list this
   * extension in its CORS_ORIGIN, as every FillPilot server does.
   */
  async useServer(address: string | null): Promise<void> {
    if (this.mode === 'reader') throw new ApiError('This installation runs on this PC — its address cannot be changed.', 0);
    const next = address === null ? this.builtBase : serverOrigin(address);
    if (next === this.base) return;
    if (next === this.builtBase) await chrome.storage.local.remove(SERVER_KEY);
    else await chrome.storage.local.set({ [SERVER_KEY]: next });
    this.base = next;
    await this.clearSession();
  }

  /** The full backend's features (stored documents, any-PDF matching) are not part of a reader installation. */
  private serverOnly(): void {
    if (this.mode === 'reader') throw new ApiError('This installation fills TGNPDCL bills only.', 0);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Files go as multipart; the browser writes that Content-Type (with its boundary) itself.
    const files = body instanceof FormData;
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          ...(files ? {} : { 'Content-Type': 'application/json' }),
          'X-Client': 'extension',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : files ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(
        this.mode === 'reader'
          ? 'FillPilot is not running on this PC. Double-click "FillPilot-Start.cmd" in the FillPilot folder, then try again.'
          : `Cannot reach the server at ${this.base}. Is the backend running?`,
        0,
      );
    }
    if (res.status === 401 && this.token) {
      await this.clearSession();
      this.onSessionEnd?.();
      throw new ApiError('Your session expired. Sign in again.', 401);
    }
    const text = await res.text();
    let data: { error?: string; rejected?: { fileName: string; error: string }[] } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const refused = data?.rejected?.map((r) => `${r.fileName}: ${r.error}`).join('; ');
      throw new ApiError(data?.error || refused || `Request failed (${res.status})`, res.status);
    }
    return data as T;
  }

  async login(username: string, password: string): Promise<User> {
    if (this.mode === 'reader') return this.remember(await localAccount.signIn(username, password, this.firstLogin));
    const res = await this.call<LoginResponse>('POST', '/api/auth/login', { username, password });
    this.token = res.token;
    await chrome.storage.session.set({ [SESSION_KEY]: { token: res.token, user: res.user } satisfies Session });
    return res.user;
  }

  /** Reader installations: choose a password of one's own in place of the first sign-in. */
  async changePassword(username: string, current: string, next: string): Promise<User> {
    return this.remember(await localAccount.change(username, current, next, this.firstLogin));
  }

  private async remember(user: User): Promise<User> {
    await chrome.storage.session.set({ [SESSION_KEY]: { token: '', user } satisfies Session });
    return user;
  }

  async logout(): Promise<void> {
    if (this.mode === 'server') await this.call('POST', '/api/auth/logout').catch(() => undefined);
    await this.clearSession();
  }

  /** Signing out (or an expired sign-in) also drops the bill held for this session. */
  private async clearSession(): Promise<void> {
    this.token = null;
    await chrome.storage.session.remove(SESSION_KEY);
    await billSession.clear();
    await pmjaySession.clear();
    await pmjayAdded.clear();
    await cilSession.clear();
  }

  completedDocuments = async () =>
    this.mode === 'reader' ? [] : this.call<DocumentDto[]>('GET', '/api/documents?status=completed&limit=100');

  document = (id: string) => this.call<DocumentDto>('GET', `/api/documents/${id}`);

  /** Sends PDFs to the server to be read; reading goes on in the background (poll `document`). */
  async upload(files: File[]): Promise<UploadResponse> {
    this.serverOnly();
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    return this.call<UploadResponse>('POST', '/api/documents', form);
  }

  allowedSites = async () => (this.mode === 'reader' ? this.sites : this.call<AllowedSite[]>('GET', '/api/allowed-sites'));

  async match(documentIds: string[], page: PageInfo, fields: FieldDescriptor[]): Promise<MatchResponse> {
    this.serverOnly();
    return this.call<MatchResponse>('POST', '/api/match', { documentIds, page, fields });
  }

  format = (fieldId: number, descriptor: FieldDescriptor, origin: string) =>
    this.call<FormatResponse>('POST', '/api/match/format', { fieldId, descriptor, origin });

  saveMapping = (body: { origin: string; path: string; signature: string; webFieldLabel: string; fieldKey: string; canonicalKey: string | null }) =>
    this.call('POST', '/api/form-mappings', body);

  markMappingsUsed = (origin: string, path: string, signatures: string[]) =>
    this.call('POST', '/api/form-mappings/used', { origin, path, signatures });

  /** What was attempted and how it went — to the server's fill history, or to the extension's own log. */
  recordFill = async (body: unknown): Promise<unknown> =>
    this.mode === 'reader' ? activityLog.add(body) : this.call('POST', '/api/fill-sessions', body);

  /**
   * Has the server read the bill PDFs and answer with what the TGNPDCL tabs
   * need. The server keeps neither the PDFs nor the answer. Scanned bills are
   * read page by page: about 15 seconds for an 11-page pair.
   */
  readTgnpdclBills(files: File[]): Promise<TgnpdclClaim> {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    return this.call<TgnpdclClaim>('POST', '/api/claims/tgnpdcl', form);
  }

  /** The same bills, read for the PM-JAY Treatment Plan: one row per package code. Nothing is kept on the server. */
  readPmjayBills(files: File[]): Promise<PmjayClaim> {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    return this.call<PmjayClaim>('POST', '/api/claims/pmjay', form);
  }

  /** The same bills, read for the Coal India claim's Bill Details (e-Arogya Suvidha). Nothing is kept on the server. */
  readCilBills(files: File[]): Promise<CilClaim> {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    return this.call<CilClaim>('POST', '/api/claims/cil', form);
  }
}

export const api = new PanelApi();

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
