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
  AllowedSite, DocumentDto, FormatResponse, LoginResponse, MatchResponse, TgnpdclClaim, UploadResponse, User,
} from '../../../web/projects/shared/src/api-types';
import type { FieldDescriptor, PageInfo } from '../../../web/projects/shared/src/page-contract';
import { activityLog } from './activity-log';
import { billSession } from './bill-session';
import { FirstLogin, localAccount } from './local-account';

const SESSION_KEY = 'pfa.session';

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

class PanelApi {
  base = 'http://localhost:4100';
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
        this.base = config.apiBase;
        this.mode = config.mode === 'reader' ? 'reader' : 'server';
        this.sites = (config.sites ?? []).map((s, i) => ({ id: i + 1, origin: s.origin, displayName: s.displayName, isActive: true, createdAt: '' }));
        this.firstLogin = config.defaultLogin ?? null;
      }
    } catch {
      /* no config.json — keep the defaults */
    }
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const session = stored[SESSION_KEY] as Session | undefined;
    this.token = session?.token || null;
    return session?.user ?? null;
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
}

export const api = new PanelApi();

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
