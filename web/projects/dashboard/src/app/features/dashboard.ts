import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import type { DashboardStats } from '@shared/api-types';
import { pct, statusLabel, statusSeverity } from '@shared/format';
import { ApiService, errorMessage } from '../core/api.service';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, DatePipe, TagModule, ButtonModule, SkeletonModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Dashboard</h1>
          <p class="muted">Your documents and form-filling activity</p>
        </div>
        <p-button label="Upload PDFs" icon="pi pi-upload" routerLink="/documents" />
      </div>

      @if (error()) {
        <div class="card section text-red-600">{{ error() }}</div>
      } @else if (!stats()) {
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          @for (i of [1, 2, 3, 4]; track i) { <p-skeleton height="88px" /> }
        </div>
      } @else {
        @let s = stats()!;
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div class="card stat"><div class="label">Total documents</div><div class="value">{{ s.documents.total }}</div></div>
          <div class="card stat"><div class="label">Processed</div><div class="value text-teal-600">{{ s.documents.processed }}</div></div>
          <div class="card stat"><div class="label">Pending</div><div class="value text-sky-600">{{ s.documents.pending }}</div></div>
          <div class="card stat"><div class="label">Failed</div><div class="value text-red-600">{{ s.documents.failed }}</div></div>
        </div>

        <div class="grid md:grid-cols-3 gap-4">
          <div class="card section md:col-span-2">
            <div class="section-title">Recent documents</div>
            @if (s.recent.length === 0) {
              <p class="muted">No documents yet. <a routerLink="/documents">Upload your first PDF</a>.</p>
            } @else {
              <table class="w-full text-sm">
                <tbody>
                  @for (d of s.recent; track d.id) {
                    <tr class="border-b border-[var(--app-border)] last:border-0">
                      <td class="py-2 pr-3"><a [routerLink]="['/documents', d.id]" class="font-medium">{{ d.fileName }}</a></td>
                      <td class="py-2 pr-3"><p-tag [value]="statusLabel(d.status)" [severity]="statusSeverity(d.status)" /></td>
                      <td class="py-2 pr-3 muted whitespace-nowrap">{{ d.fieldCount }} fields</td>
                      <td class="py-2 muted whitespace-nowrap text-right">{{ d.uploadedAt | date: 'd MMM, HH:mm' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
          <div class="card section">
            <div class="section-title">Last 30 days</div>
            <dl class="m-0 grid gap-3">
              <div><dt class="muted text-sm">Forms filled</dt><dd class="m-0 text-xl font-semibold">{{ s.last30Days.fillSessions }}</dd></div>
              <div><dt class="muted text-sm">Fields filled automatically</dt><dd class="m-0 text-xl font-semibold">{{ s.last30Days.fieldsFilled }} <span class="muted text-sm font-normal">of {{ s.last30Days.fieldsDetected }} detected</span></dd></div>
              <div><dt class="muted text-sm">Average extraction confidence</dt><dd class="m-0 text-xl font-semibold">{{ pct(s.documents.avgConfidence) }}</dd></div>
            </dl>
          </div>
        </div>
      }
    </div>
  `,
})
export class DashboardPage implements OnInit {
  private readonly api = inject(ApiService);
  protected readonly stats = signal<DashboardStats | null>(null);
  protected readonly error = signal('');
  protected readonly statusLabel = statusLabel;
  protected readonly statusSeverity = statusSeverity;
  protected readonly pct = pct;

  async ngOnInit() {
    try {
      this.stats.set(await this.api.stats());
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
