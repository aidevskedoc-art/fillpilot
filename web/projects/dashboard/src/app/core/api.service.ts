import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AllowedSite, AuditLogEntry, DashboardStats, FieldAlias, FillSession, FormMapping, ManagedUser, TeamReport,
} from '@shared/api-types';

/** Promise-returning wrappers over the backend API (backend/src/routes). */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  private get<T>(url: string, params?: Record<string, string>) {
    return firstValueFrom(this.http.get<T>(url, { params }));
  }
  private post<T>(url: string, body: unknown) {
    return firstValueFrom(this.http.post<T>(url, body));
  }
  private patch<T>(url: string, body: unknown) {
    return firstValueFrom(this.http.patch<T>(url, body));
  }
  private delete(url: string) {
    return firstValueFrom(this.http.delete<void>(url));
  }

  stats = () => this.get<DashboardStats>('/api/dashboard/stats');

  allowedSites = (all = false) => this.get<AllowedSite[]>('/api/allowed-sites', all ? { all: 'true' } : {});
  addSite = (body: { origin: string; displayName: string }) => this.post<AllowedSite>('/api/allowed-sites', body);
  updateSite = (id: number, body: { displayName?: string; isActive?: boolean }) => this.patch<AllowedSite>(`/api/allowed-sites/${id}`, body);
  deleteSite = (id: number) => this.delete(`/api/allowed-sites/${id}`);

  formMappings = () => this.get<FormMapping[]>('/api/form-mappings');
  deleteMapping = (id: number) => this.delete(`/api/form-mappings/${id}`);

  aliases = () => this.get<FieldAlias[]>('/api/field-aliases');
  addAlias = (body: { canonicalKey: string; alias: string }) => this.post<FieldAlias>('/api/field-aliases', body);
  deleteAlias = (id: number) => this.delete(`/api/field-aliases/${id}`);

  fillSessions = (all = false) => this.get<FillSession[]>('/api/fill-sessions', all ? { all: 'true' } : {});
  fillSession = (id: number) => this.get<FillSession>(`/api/fill-sessions/${id}`);
  auditLogs = (params: Record<string, string> = {}) => this.get<AuditLogEntry[]>('/api/audit-logs', params);
  teamReport = (from: string, to: string) => this.get<TeamReport>('/api/reports/team', { from, to });

  users = () => this.get<ManagedUser[]>('/api/users');
  createUser = (body: { username: string; fullName: string; password: string; role: string }) => this.post<ManagedUser>('/api/users', body);
  updateUser = (id: number, body: Record<string, unknown>) => this.patch<ManagedUser>(`/api/users/${id}`, body);
}

/** The API's { error } message, or a generic one. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server. Is the backend running?';
    return (err.error && typeof err.error === 'object' && 'error' in err.error ? String(err.error.error) : null) || err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
