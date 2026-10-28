import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import type { TeamReport, TeamReportRow } from '@shared/api-types';
import { ApiService, errorMessage } from '../core/api.service';

type Preset = 'today' | 'week' | 'month' | 'lastMonth';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
];

/** 'YYYY-MM-DD' of a local date (what <input type="date"> holds). */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Local midnight of a 'YYYY-MM-DD', `addDays` later. */
const midnight = (s: string, addDays = 0) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d + addDays);
};

function presetRange(p: Preset): [string, string] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (p) {
    case 'today': return [ymd(now), ymd(now)];
    case 'week': return [ymd(new Date(y, m, now.getDate() - 6)), ymd(now)];
    case 'month': return [ymd(new Date(y, m, 1)), ymd(now)];
    case 'lastMonth': return [ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))];
  }
}

const used = (r: TeamReportRow) => r.bills.total > 0 || r.fills > 0 || r.uploads > 0;

@Component({
  selector: 'app-team-report',
  imports: [DatePipe, FormsModule, TableModule, ButtonModule, InputTextModule, TagModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Team report</h1>
          <p class="muted">Bills each person read and filled with FillPilot. Counts only, with no patient details.</p>
        </div>
        <p-button label="Export CSV" icon="pi pi-download" [outlined]="true" [disabled]="!report()" (onClick)="exportCsv()" />
      </div>

      <div class="card section mb-6 flex flex-wrap items-end gap-3">
        <div class="flex flex-wrap gap-2">
          @for (p of presets; track p.key) {
            <p-button [label]="p.label" size="small" [outlined]="preset() !== p.key" (onClick)="choose(p.key)" />
          }
        </div>
        <div class="flex items-end gap-2 ml-auto">
          <label class="text-sm">From<br /><input pInputText type="date" [ngModel]="from()" (ngModelChange)="setRange($event, to())" [max]="to()" /></label>
          <label class="text-sm">To<br /><input pInputText type="date" [ngModel]="to()" (ngModelChange)="setRange(from(), $event)" [min]="from()" /></label>
        </div>
      </div>

      @if (report(); as r) {
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div class="card stat">
            <div class="label">Bills read</div>
            <div class="value">{{ totals().bills }}</div>
            <div class="muted text-xs">TGNPDCL {{ totals().tgnpdcl }} · PM-JAY {{ totals().pmjay }} · Coal India {{ totals().cil }}</div>
          </div>
          <div class="card stat">
            <div class="label">PDFs read</div>
            <div class="value">{{ totals().pdfs }}</div>
            <div class="muted text-xs">{{ totals().pages }} pages</div>
          </div>
          <div class="card stat">
            <div class="label">Fills</div>
            <div class="value text-teal-600">{{ totals().fills }}</div>
            <div class="muted text-xs">{{ totals().stepsDone }} steps done · {{ totals().stepsFailed }} failed</div>
          </div>
          <div class="card stat">
            <div class="label">People using FillPilot</div>
            <div class="value">{{ totals().users }} <span class="muted text-base font-normal">of {{ r.rows.length }}</span></div>
          </div>
        </div>

        <div class="card">
          <p-table [value]="r.rows" size="small" [rowHover]="true" [scrollable]="true">
            <ng-template #header>
              <tr>
                <th>Person</th><th class="text-right">TGNPDCL</th><th class="text-right">PM-JAY</th><th class="text-right">Coal India</th>
                <th class="text-right">Bills</th><th class="text-right">PDFs</th><th class="text-right">Pages</th>
                @if (showUploads()) { <th class="text-right">Other PDFs</th> }
                <th class="text-right">Fills</th><th class="text-right">Steps done</th><th class="text-right">Failed</th><th>Last active</th>
              </tr>
            </ng-template>
            <ng-template #body let-u>
              <tr [class.muted]="!used(u)">
                <td>
                  <div class="font-medium">{{ u.fullName }}
                    @if (!used(u)) { <p-tag value="Not used" severity="secondary" /> }
                    @if (!u.isActive) { <p-tag value="Inactive" severity="secondary" /> }
                  </div>
                  <div class="muted text-xs mono">{{ u.username }}</div>
                </td>
                <td class="text-right">{{ u.bills.tgnpdcl }}</td>
                <td class="text-right">{{ u.bills.pmjay }}</td>
                <td class="text-right">{{ u.bills.cil }}</td>
                <td class="text-right font-semibold">{{ u.bills.total }}</td>
                <td class="text-right">{{ u.pdfs }}</td>
                <td class="text-right">{{ u.pages }}</td>
                @if (showUploads()) { <td class="text-right">{{ u.uploads }}</td> }
                <td class="text-right">{{ u.fills }}</td>
                <td class="text-right">{{ u.stepsDone }}</td>
                <td class="text-right">@if (u.stepsFailed) { <span class="text-red-600 font-semibold">{{ u.stepsFailed }}</span> } @else { 0 }</td>
                <td class="whitespace-nowrap">{{ u.lastActive ? (u.lastActive | date: 'd MMM y, HH:mm') : 'Never' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="12" class="muted text-center py-6">No users yet.</td></tr></ng-template>
          </p-table>
        </div>
        <p class="muted text-xs mt-3">
          A bill is one patient's final bill and summary bill read together. "Fills" counts each press of Fill; "Failed" is the steps it could not do.
          Only work done through the extension is counted.
        </p>
      } @else if (error()) {
        <div class="card section text-red-600">{{ error() }}</div>
      } @else {
        <div class="card section muted">Loading…</div>
      }
    </div>
  `,
})
export class TeamReportPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MessageService);

  protected readonly presets = PRESETS;
  protected readonly used = used;
  protected readonly preset = signal<Preset | null>('week');
  protected readonly from = signal(presetRange('week')[0]);
  protected readonly to = signal(presetRange('week')[1]);
  protected readonly report = signal<TeamReport | null>(null);
  protected readonly error = signal('');

  protected readonly showUploads = computed(() => (this.report()?.rows ?? []).some((r) => r.uploads > 0));
  protected readonly totals = computed(() => {
    const rows = this.report()?.rows ?? [];
    const sum = (f: (r: TeamReportRow) => number) => rows.reduce((n, r) => n + f(r), 0);
    return {
      bills: sum((r) => r.bills.total),
      tgnpdcl: sum((r) => r.bills.tgnpdcl),
      pmjay: sum((r) => r.bills.pmjay),
      cil: sum((r) => r.bills.cil),
      pdfs: sum((r) => r.pdfs),
      pages: sum((r) => r.pages),
      fills: sum((r) => r.fills),
      stepsDone: sum((r) => r.stepsDone),
      stepsFailed: sum((r) => r.stepsFailed),
      users: rows.filter(used).length,
    };
  });

  ngOnInit() {
    this.load();
  }

  choose(p: Preset) {
    const [from, to] = presetRange(p);
    this.from.set(from);
    this.to.set(to);
    this.preset.set(p);
    this.load();
  }

  setRange(from: string, to: string) {
    if (!from || !to || from > to) return;
    this.from.set(from);
    this.to.set(to);
    this.preset.set(null);
    this.load();
  }

  async load() {
    this.error.set('');
    try {
      // Whole local days: from the first day's midnight to the midnight after the last.
      this.report.set(await this.api.teamReport(midnight(this.from()).toISOString(), midnight(this.to(), 1).toISOString()));
    } catch (err) {
      this.report.set(null);
      this.error.set(errorMessage(err));
    }
  }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const head = ['Person', 'Username', 'TGNPDCL', 'PM-JAY', 'Coal India', 'Bills', 'PDFs', 'Pages', 'Other PDFs', 'Fills', 'Steps done', 'Failed', 'Last active'];
    const lines = r.rows.map((u) => [
      u.fullName, u.username, u.bills.tgnpdcl, u.bills.pmjay, u.bills.cil, u.bills.total, u.pdfs, u.pages, u.uploads,
      u.fills, u.stepsDone, u.stepsFailed, u.lastActive ? new Date(u.lastActive).toLocaleString('en-IN') : 'Never',
    ]);
    const cell = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [head, ...lines].map((row) => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `FillPilot-team-report_${this.from()}_to_${this.to()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast.add({ severity: 'success', summary: 'Report exported', detail: a.download });
  }
}
