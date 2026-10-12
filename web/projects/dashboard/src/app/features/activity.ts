import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MessageService } from 'primeng/api';
import type { AuditLogEntry, FillSession } from '@shared/api-types';
import { pct } from '@shared/format';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-activity',
  imports: [DatePipe, JsonPipe, FormsModule, TableModule, TabsModule, DialogModule, TagModule, ButtonModule, ToggleSwitchModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Activity</h1>
          <p class="muted">Every form the extension filled (field labels and outcomes — never the values).</p>
        </div>
        @if (auth.isAdmin()) {
          <label class="flex items-center gap-2 text-sm">
            <p-toggleswitch [ngModel]="allUsers()" (ngModelChange)="allUsers.set($event); loadSessions()" /> All users
          </label>
        }
      </div>

      <div class="card">
        <p-tabs value="fills">
          <p-tablist>
            <p-tab value="fills">Form fills</p-tab>
            @if (auth.isAdmin()) { <p-tab value="audit" (click)="loadAudit()">Audit log</p-tab> }
          </p-tablist>
          <p-tabpanels>
            <p-tabpanel value="fills">
              <p-table [value]="sessions()" size="small" [rowHover]="true" [paginator]="sessions().length > 25" [rows]="25">
                <ng-template #header>
                  <tr><th>When</th>@if (allUsers()) { <th>User</th> }<th>Website / form</th><th>Document(s)</th><th>Detected</th><th>Filled</th><th>Reviewed</th><th>Failed</th><th></th></tr>
                </ng-template>
                <ng-template #body let-s>
                  <tr>
                    <td class="whitespace-nowrap">{{ s.createdAt | date: 'd MMM y, HH:mm' }}</td>
                    @if (allUsers()) { <td>{{ s.user }}</td> }
                    <td><div>{{ s.formTitle || s.path }}</div><div class="muted text-xs mono">{{ s.origin }}</div></td>
                    <td class="text-sm">{{ s.documentNames.join(', ') }}</td>
                    <td>{{ s.detected }}</td>
                    <td><span class="text-teal-600 font-semibold">{{ s.filled }}</span></td>
                    <td>{{ s.reviewed }}</td>
                    <td>@if (s.failed) { <span class="text-red-600 font-semibold">{{ s.failed }}</span> } @else { 0 }</td>
                    <td class="text-right"><p-button icon="pi pi-list" [text]="true" [rounded]="true" (onClick)="open(s)" /></td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="9" class="muted text-center py-6">No forms filled yet.</td></tr></ng-template>
              </p-table>
            </p-tabpanel>
            @if (auth.isAdmin()) {
              <p-tabpanel value="audit">
                <p-table [value]="audit()" size="small" [rowHover]="true" [paginator]="audit().length > 50" [rows]="50">
                  <ng-template #header><tr><th>When</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th><th>IP</th></tr></ng-template>
                  <ng-template #body let-a>
                    <tr>
                      <td class="whitespace-nowrap">{{ a.createdAt | date: 'd MMM y, HH:mm:ss' }}</td>
                      <td><p-tag [value]="a.action" severity="secondary" /></td>
                      <td>{{ a.actor || '—' }}</td>
                      <td>{{ a.target || (a.entityType ? a.entityType + ' ' + a.entityId : '—') }}</td>
                      <td class="mono text-xs max-w-96 truncate">{{ a.details ? (a.details | json) : '' }}</td>
                      <td class="mono text-xs">{{ a.ipAddress }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              </p-tabpanel>
            }
          </p-tabpanels>
        </p-tabs>
      </div>
    </div>

    <p-dialog [header]="detail()?.formTitle || 'Form fill'" [visible]="!!detail()" (visibleChange)="!$event && detail.set(null)" [modal]="true" [style]="{ width: '40rem' }">
      @if (detail(); as d) {
        <p class="muted text-sm mt-0">{{ d.origin }}{{ d.path }} · {{ d.createdAt | date: 'd MMM y, HH:mm' }}</p>
        <p-table [value]="d.fields || []" size="small">
          <ng-template #header><tr><th>Web field</th><th>PDF field</th><th>Confidence</th><th>Source</th><th>Outcome</th></tr></ng-template>
          <ng-template #body let-f>
            <tr>
              <td>{{ f.label }}</td>
              <td class="mono">{{ f.fieldKey || '—' }}</td>
              <td>{{ pct(f.confidence) }}</td>
              <td>{{ f.source || '—' }}</td>
              <td><p-tag [value]="f.outcome" [severity]="f.outcome === 'filled' ? 'success' : f.outcome === 'failed' ? 'danger' : 'secondary'" /></td>
            </tr>
          </ng-template>
        </p-table>
      }
    </p-dialog>
  `,
})
export class ActivityPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MessageService);

  protected readonly sessions = signal<FillSession[]>([]);
  protected readonly audit = signal<AuditLogEntry[]>([]);
  protected readonly allUsers = signal(false);
  protected readonly detail = signal<FillSession | null>(null);
  protected readonly pct = pct;

  ngOnInit() {
    this.loadSessions();
  }

  async loadSessions() {
    try {
      this.sessions.set(await this.api.fillSessions(this.allUsers()));
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not load activity', detail: errorMessage(err) });
    }
  }

  async loadAudit() {
    if (this.audit().length) return;
    try {
      this.audit.set(await this.api.auditLogs({ limit: '500' }));
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not load the audit log', detail: errorMessage(err) });
    }
  }

  async open(s: FillSession) {
    try {
      this.detail.set(await this.api.fillSession(s.id));
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not load the details', detail: errorMessage(err) });
    }
  }
}
