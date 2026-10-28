import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import type { BillSite, DashboardStats } from '@shared/api-types';
import { ApiService, errorMessage } from '../core/api.service';

const SITE_NAMES: Record<BillSite, string> = { tgnpdcl: 'TGNPDCL', pmjay: 'PM-JAY', cil: 'Coal India' };

@Component({
  selector: 'app-dashboard',
  imports: [DatePipe, TagModule, SkeletonModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Dashboard</h1>
          <p class="muted">Bills you read and filled with FillPilot in the last 30 days</p>
        </div>
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
          <div class="card stat"><div class="label">TGNPDCL bills</div><div class="value">{{ s.last30Days.bills.tgnpdcl }}</div></div>
          <div class="card stat"><div class="label">PM-JAY bills</div><div class="value">{{ s.last30Days.bills.pmjay }}</div></div>
          <div class="card stat"><div class="label">Coal India bills</div><div class="value">{{ s.last30Days.bills.cil }}</div></div>
          <div class="card stat">
            <div class="label">PDFs read</div>
            <div class="value text-teal-600">{{ s.last30Days.pdfs }}</div>
            <div class="muted text-xs">{{ s.last30Days.pages }} pages</div>
          </div>
        </div>

        <div class="grid md:grid-cols-3 gap-4">
          <div class="card section md:col-span-2">
            <div class="section-title">Recent bills</div>
            @if (s.recentBills.length === 0) {
              <p class="muted">No bills read yet. Open a bill on TGNPDCL, PM-JAY or Coal India and drop the PDFs into the FillPilot panel.</p>
            } @else {
              <table class="w-full text-sm">
                <tbody>
                  @for (b of s.recentBills; track $index) {
                    <tr class="border-b border-[var(--app-border)] last:border-0">
                      <td class="py-2 pr-3"><p-tag [value]="siteName(b.site)" severity="secondary" /></td>
                      <td class="py-2 pr-3 muted whitespace-nowrap">{{ b.pdfs }} PDF{{ b.pdfs === 1 ? '' : 's' }} · {{ b.pages }} pages</td>
                      <td class="py-2 muted whitespace-nowrap text-right">{{ b.at | date: 'd MMM, HH:mm' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
          <div class="card section">
            <div class="section-title">Summary</div>
            <dl class="m-0 grid gap-3">
              <div><dt class="muted text-sm">Bills today</dt><dd class="m-0 text-xl font-semibold">{{ s.today.bills }} <span class="muted text-sm font-normal">{{ s.today.pdfs }} PDFs</span></dd></div>
              <div><dt class="muted text-sm">Bills in the last 30 days</dt><dd class="m-0 text-xl font-semibold">{{ s.last30Days.bills.total }}</dd></div>
              <div><dt class="muted text-sm">Fills</dt><dd class="m-0 text-xl font-semibold">{{ s.last30Days.fills }} <span class="muted text-sm font-normal">{{ s.last30Days.stepsDone }} steps done</span></dd></div>
              <div>
                <dt class="muted text-sm">Steps that failed</dt>
                <dd class="m-0 text-xl font-semibold" [class.text-red-600]="s.last30Days.stepsFailed > 0">{{ s.last30Days.stepsFailed }}</dd>
              </div>
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

  protected siteName(site: BillSite) {
    return SITE_NAMES[site] ?? site;
  }

  async ngOnInit() {
    try {
      this.stats.set(await this.api.stats());
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
