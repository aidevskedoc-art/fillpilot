// The sign-in for installations that have no server-side accounts ("reader"
// mode, see build.mjs): it is kept in the extension's own storage on this PC.
//
// What it is, plainly: a lock on the panel, so that someone else using this
// browser profile does not start filling bills by accident. It is not a
// defence against a person who controls the PC — nothing here needs one: the
// bill is never stored, and the reading service answers this PC only.
//
// Until a password is chosen, the installation's first sign-in (from
// config.json) applies. A chosen password is stored salted and hashed
// (PBKDF2), never as typed.
import type { User } from '../../../web/projects/shared/src/api-types';

const KEY = 'fillpilot.account';
const ITERATIONS = 150_000;
const MIN_PASSWORD = 4;

interface Account {
  username: string;
  salt: string;
  hash: string;
}

export interface FirstLogin {
  username: string;
  password: string;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations: ITERATIONS }, key, 256);
  return toBase64(new Uint8Array(bits));
}

async function stored(): Promise<Account | null> {
  const found = await chrome.storage.local.get(KEY);
  return (found[KEY] as Account | undefined) ?? null;
}

const userOf = (username: string): User => ({ id: 1, username, fullName: username, role: 'Admin' });

export const localAccount = {
  /** → the signed-in user, or throws with a message for the person. */
  async signIn(username: string, password: string, first: FirstLogin | null): Promise<User> {
    const account = await stored();
    const ok = account
      ? sameName(username, account.username) && (await derive(password, account.salt)) === account.hash
      : Boolean(first) && sameName(username, first!.username) && password === first!.password;
    if (!ok) {
      // A pause, so guessing by hand or by script is slow.
      await new Promise((r) => setTimeout(r, 700));
      throw new Error('Invalid username or password');
    }
    return userOf(account ? account.username : first!.username);
  },

  /** Replaces the password (and, if given, the username) after checking the current one. */
  async change(username: string, current: string, next: string, first: FirstLogin | null): Promise<User> {
    await this.signIn(username, current, first);
    if (next.length < MIN_PASSWORD) throw new Error(`Choose a new password of at least ${MIN_PASSWORD} characters`);
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const account: Account = { username: username.trim(), salt, hash: await derive(next, salt) };
    await chrome.storage.local.set({ [KEY]: account });
    return userOf(account.username);
  },
};
