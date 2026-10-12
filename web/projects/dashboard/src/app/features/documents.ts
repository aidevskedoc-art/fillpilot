import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { ProgressBarModule } from 'primeng/progressbar';
import { ConfirmationService, MessageService } from 'primeng/api';
import type { DocumentDto } from '@shared/api-types';
import { IN_PROGRESS, fileSize, pct, statusLabel, statusSeverity } from '@shared/format';
import { ApiService, errorMessage } from '../core/api.service';

const POLL_MS = 2000;

@Component({
  selector: 'app-documents',
  imports: [DatePipe, FormsModule, RouterLink, TableModule, TagModule, ButtonModule, InputTextModule, TooltipModule, ProgressBarModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Documents</h1>
          <p class="muted">Upload PDFs; their data is extracted automatically and used by the browser extension.</p>
        </div>
      </div>

      <label class="dropzone card" [class.over]="dragOver()"
        (dragover)="$event.preventDefault(); dragOver.set(true)" (dragleave)="dragOver.set(false)" (drop)="onDrop($event)">
        <input type="file" accept="application/pdf,.pdf" multiple (change)="onPick($event)" hidden />
        <i class="pi pi-cloud-upload text-3xl" style="color: var(--p-primary-color)"></i>
        <div class="font-medium">Drop PDFs here or click to choose</div>
        <div class="muted text-sm">Up to 10 files, 20 MB each. Text-based PDFs (scanned PDFs need OCR, coming in Phase 2).</div>
        @if (uploading()) { <p-progressbar mode="indeterminate" [style]="{ height: '4px', width: '220px' }" /> }
      </label>

      <div class="card mt-5">
        <div class="flex items-center justify-between gap-3 p-3 flex-wrap">
          <input pInputText type="search" placeholder="Search file name" [ngModel]="query()" (ngModelChange)="query.set($event)" class="w-64" />
          <span class="muted text-sm">{{ filtered().length }} document(s)</span>
        </div>
        <p-table [value]="filtered()" [rowHover]="true" dataKey="id" [paginator]="filtered().length > 25" [rows]="25" size="small">
          <ng-template #header>
            <tr>
              <th>File</th><th>Status</th><th>Pages</th><th>Fields</th><th>Confidence</th><th>Uploaded</th><th class="text-right">Actions</th>
            </tr>
          </ng-template>
          <ng-template #body let-d>
            <tr>
              <td>
                <a [routerLink]="['/documents', d.id]" class="font-medium">{{ d.fileName }}</a>
                <div class="muted text-xs">{{ size(d.fileSize) }}</div>
              </td>
              <td>
                <p-tag [value]="statusLabel(d.status)" [severity]="statusSeverity(d.status)" [pTooltip]="d.failureReason || ''" />
                @if (d.status === 'failed' && d.failureReason) { <div class="text-xs text-red-600 mt-1 max-w-72">{{ d.failureReason }}</div> }
              </td>
              <td>{{ d.pageCount ?? '—' }}</td>
              <td>{{ d.status === 'completed' ? d.fieldCount : '—' }}</td>
              <td>{{ pct(d.avgConfidence) }}</td>
              <td class="whitespace-nowrap">{{ d.uploadedAt | date: 'd MMM y, HH:mm' }}</td>
              <td class="text-right whitespace-nowrap">
                <p-button icon="pi pi-eye" [text]="true" [rounded]="true" pTooltip="View extracted data" [routerLink]="['/documents', d.id]" />
                <p-button icon="pi pi-refresh" [text]="true" [rounded]="true" [pTooltip]="d.fileKept ? 'Re-run extraction' : 'The PDF was not kept — upload it again to re-read it'" [disabled]="inProgress(d) || !d.fileKept" (onClick)="retry(d)" />
                <p-button icon="pi pi-trash" [text]="true" [rounded]="true" severity="danger" pTooltip="Delete" (onClick)="remove(d)" />
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="7" class="text-center muted py-8">No documents yet.</td></tr>
          </ng-template>
        </p-table>
      </div>
    </div>
  `,
  styles: `
    .dropzone { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 28px 16px; border-style: dashed; border-width: 2px; cursor: pointer; text-align: center; }
    .dropzone.over, .dropzone:hover { border-color: var(--p-primary-color); background: var(--p-highlight-background); }
  `,
})
export class DocumentsPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  protected readonly docs = signal<DocumentDto[]>([]);
  protected readonly uploading = signal(false);
  protected readonly dragOver = signal(false);
  protected readonly query = signal('');
  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return q ? this.docs().filter((d) => d.fileName.toLowerCase().includes(q)) : this.docs();
  });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  protected readonly statusLabel = statusLabel;
  protected readonly statusSeverity = statusSeverity;
  protected readonly pct = pct;
  protected readonly size = fileSize;
  protected inProgress = (d: DocumentDto) => IN_PROGRESS.includes(d.status);

  ngOnInit() {
    this.load();
  }

  ngOnDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.destroyed = true;
  }

  /** Reloads; keeps polling while anything is still being processed. */
  private async load() {
    if (this.timer) clearTimeout(this.timer);
    try {
      this.docs.set(await this.api.documents());
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not load documents', detail: errorMessage(err) });
    }
    if (!this.destroyed && this.docs().some((d) => IN_PROGRESS.includes(d.status))) {
      this.timer = setTimeout(() => this.load(), POLL_MS);
    }
  }

  onPick(event: Event) {
    const input = event.target as HTMLInputElement;
    this.upload(Array.from(input.files || []));
    input.value = '';
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.dragOver.set(false);
    this.upload(Array.from(event.dataTransfer?.files || []));
  }

  private async upload(files: File[]) {
    if (!files.length) return;
    this.uploading.set(true);
    try {
      const res = await this.api.upload(files);
      if (res.documents.length) {
        this.toast.add({ severity: 'success', summary: `${res.documents.length} file(s) uploaded`, detail: 'Extraction runs in the background.' });
      }
      for (const dup of res.documents.filter((d) => d.duplicateOf)) {
        this.toast.add({ severity: 'warn', summary: 'Duplicate', detail: `${dup.fileName} was uploaded before.` });
      }
      for (const r of res.rejected) this.toast.add({ severity: 'error', summary: r.fileName, detail: r.error });
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Upload failed', detail: errorMessage(err) });
    } finally {
      this.uploading.set(false);
      this.load();
    }
  }

  async retry(d: DocumentDto) {
    try {
      await this.api.retry(d.id);
      this.load();
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Retry failed', detail: errorMessage(err) });
    }
  }

  remove(d: DocumentDto) {
    this.confirm.confirm({
      header: 'Delete document?',
      message: `"${d.fileName}" and all data extracted from it will be permanently deleted.`,
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: { label: 'Delete', severity: 'danger' },
      rejectButtonProps: { label: 'Cancel', severity: 'secondary', text: true },
      accept: async () => {
        try {
          await this.api.deleteDocument(d.id);
          this.docs.update((list) => list.filter((x) => x.id !== d.id));
        } catch (err) {
          this.toast.add({ severity: 'error', summary: 'Delete failed', detail: errorMessage(err) });
        }
      },
    });
  }
}
