import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AllowedSite, AuditLogEntry, DashboardStats, DocumentDto, ExtractedField, ExtractedTable, FieldAlias,
  FillSession, FormMapping, ManagedUser, UploadResponse,
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

  documents = (params: Record<string, string> = {}) => this.get<DocumentDto[]>('/api/documents', params);
  document = (id: string) => this.get<DocumentDto>(`/api/documents/${id}`);
  upload(files: File[]) {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    return this.post<UploadResponse>('/api/documents', form);
  }
  retry = (id: string) => this.post<DocumentDto>(`/api/documents/${id}/retry`, {});
  deleteDocument = (id: string) => this.delete(`/api/documents/${id}`);
  fileBlob = (id: string) => firstValueFrom(this.http.get(`/api/documents/${id}/file`, { responseType: 'blob' }));
  fields = (id: string) => this.get<ExtractedField[]>(`/api/documents/${id}/fields`);
  tables = (id: string) => this.get<ExtractedTable[]>(`/api/documents/${id}/tables`);
  json = (id: string) => this.get<Record<string, string>>(`/api/documents/${id}/json`);
  updateField = (id: string, fieldId: number, body: { label?: string; value?: string }) =>
    this.patch<ExtractedField>(`/api/documents/${id}/fields/${fieldId}`, body);
  addField = (id: string, body: { label: string; value: string }) => this.post<ExtractedField>(`/api/documents/${id}/fields`, body);
  deleteField = (id: string, fieldId: number) => this.delete(`/api/documents/${id}/fields/${fieldId}`);

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
