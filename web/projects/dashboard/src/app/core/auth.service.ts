import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { LoginResponse, User } from '@shared/api-types';

const TOKEN_KEY = 'pfa.token';
const USER_KEY = 'pfa.user';

/**
 * Session lives in sessionStorage: gone when the tab closes, not shared with
 * other tabs or left on disk like localStorage would be.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly token = signal<string | null>(read(TOKEN_KEY));
  readonly user = signal<User | null>(parse(read(USER_KEY)));
  readonly isAuthenticated = computed(() => Boolean(this.token()));
  readonly isAdmin = computed(() => this.user()?.role === 'Admin');

  async login(username: string, password: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<LoginResponse>('/api/auth/login', { username, password }));
    write(TOKEN_KEY, res.token);
    write(USER_KEY, JSON.stringify(res.user));
    this.token.set(res.token);
    this.user.set(res.user);
  }

  async logout(): Promise<void> {
    if (this.token()) {
      await firstValueFrom(this.http.post('/api/auth/logout', {})).catch(() => undefined);
    }
    this.clear();
  }

  /** Local sign-out without calling the API (expired token). */
  clear(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    this.token.set(null);
    this.user.set(null);
  }
}

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage blocked — the in-memory signal still works for this page */
  }
}

function parse(json: string | null): User | null {
  try {
    return json ? (JSON.parse(json) as User) : null;
  } catch {
    return null;
  }
}
