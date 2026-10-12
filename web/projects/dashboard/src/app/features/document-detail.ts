import { Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TabsModule } from 'primeng/tabs';
import { DialogModule } from 'primeng/dialog';
import { TooltipModule } from 'primeng/tooltip';
import { MessageModule } from 'primeng/message';
import { ConfirmationService, MessageService } from 'primeng/api';
import type { DocumentDto, ExtractedField, ExtractedTable } from '@shared/api-types';
import { IN_PROGRESS, confidenceSeverity, pct, statusLabel, statusSeverity } from '@shared/format';
import { ApiService, errorMessage } from '../core/api.service';

@Component({
  selector: 'app-document-detail',
  imports: [DatePipe, JsonPipe, FormsModule, RouterLink, TableModule, TagModule, ButtonModule, InputTextModule, TabsModule, DialogModule, TooltipModule, MessageModule],
  template: `
    <div class="page">
      <a routerLink="/documents" class="text-sm"><i class="pi pi-arrow-left text-xs"></i> Documents</a>
      @if (doc(); as d) {
        <div class="page-header mt-2">
          <div class="min-w-0">
            <h1 class="text-2xl truncate">{{ d.fileName }}</h1>
            <p class="muted">
              <p-tag [value]="statusLabel(d.status)" [severity]="statusSeverity(d.status)" />
              <span class="ml-2">{{ d.pageCount ?? '?' }} page(s) · {{ d.fieldCount }} fields · uploaded {{ d.uploadedAt | date: 'd MMM y, HH:mm' }}</span>
              @if (d.retentionExpiresAt) { <span class="ml-1">· auto-deleted {{ d.retentionExpiresAt | date: 'd MMM y' }}</span> }
            </p>
          </div>
          <div class="flex gap-2">
            <p-button label="Add field" icon="pi pi-plus" severity="secondary" [disabled]="d.status !== 'completed'" (onClick)="openAdd()" />
            <p-button [label]="showPdf() ? 'Hide PDF' : 'Show PDF'" icon="pi pi-file-pdf" severity="secondary" (onClick)="togglePdf()" />
          </div>
        </div>

        @if (d.status === 'failed') {
          <p-message severity="error" styleClass="mb-4">{{ d.failureReason }}</p-message>
        }
        @for (w of d.warnings; track w) {
          <p-message severity="warn" styleClass="mb-3">{{ w }}</p-message>
        }
        @if (inProgress()) {
          <p-message severity="info" styleClass="mb-4">Processing… this page refreshes when extraction finishes.</p-message>
        }

        <div class="layout" [class.with-pdf]="showPdf()">
          <div class="card min-w-0">
            <p-tabs value="fields">
              <p-tablist>
                <p-tab value="fields">Fields ({{ fields().length }})</p-tab>
                <p-tab value="json">JSON</p-tab>
                <p-tab value="tables">Tables ({{ tables().length }})</p-tab>
              </p-tablist>
              <p-tabpanels>
                <p-tabpanel value="fields">
                  <div class="flex items-center gap-3 mb-3 flex-wrap">
                    <input pInputText type="search" placeholder="Filter fields" [ngModel]="filter()" (ngModelChange)="filter.set($event)" class="w-64" />
                    <span class="muted text-sm">Bold keys are recognised fields (alias dictionary); others are the PDF's own labels.</span>
                  </div>
                  <p-table [value]="visibleFields()" dataKey="id" editMode="row" size="small" [rowHover]="true" [scrollable]="true">
                    <ng-template #header>
                      <tr><th>Label (as printed)</th><th>Key</th><th>Value</th><th>Type</th><th>Confidence</th><th>Page</th><th class="text-right"></th></tr>
                    </ng-template>
                    <ng-template #body let-f let-editing="editing">
                      <tr [pEditableRow]="f">
                        <td class="min-w-40">
                          @if (editing) { <input pInputText [(ngModel)]="draft.label" class="w-full" /> } @else { {{ f.label }} }
                        </td>
                        <td class="mono" [class.font-bold]="f.canonicalKey">{{ f.canonicalKey || f.fieldKey }}</td>
                        <td class="min-w-56">
                          @if (editing) {
                            <input pInputText [(ngModel)]="draft.value" class="w-full" />
                          } @else {
                            <div>{{ f.valueRaw }}</div>
                            @if (f.valueNormalized && f.valueNormalized !== f.valueRaw) { <div class="muted text-xs">→ {{ f.valueNormalized }}</div> }
                            @for (p of f.validation.problems || []; track p) { <div class="text-xs text-amber-600"><i class="pi pi-exclamation-triangle text-xs"></i> {{ p }}</div> }
                            @if (f.validation.alternates?.length) {
                              <div class="text-xs muted" [pTooltip]="alternatesText(f)">also seen: {{ f.validation.alternates.length }} other value(s)</div>
                            }
                          }
                        </td>
                        <td><span class="muted text-xs">{{ f.valueType }}</span></td>
                        <td>
                          <p-tag [value]="pct(f.confidence)" [severity]="confidenceSeverity(f.confidence)" [pTooltip]="f.edited ? 'Edited by a user' : 'Rule: ' + f.method" />
                        </td>
                        <td>{{ f.page ?? '—' }}</td>
                        <td class="text-right whitespace-nowrap">
                          @if (editing) {
                            <p-button pSaveEditableRow icon="pi pi-check" [text]="true" [rounded]="true" (onClick)="save(f)" />
                            <p-button pCancelEditableRow icon="pi pi-times" [text]="true" [rounded]="true" severity="secondary" />
                          } @else {
                            <p-button pInitEditableRow icon="pi pi-pencil" [text]="true" [rounded]="true" (onClick)="startEdit(f)" />
                            <p-button icon="pi pi-trash" [text]="true" [rounded]="true" severity="danger" (onClick)="removeField(f)" />
                          }
                        </td>
                      </tr>
                    </ng-template>
                    <ng-template #emptymessage>
                      <tr><td colspan="7" class="text-center muted py-6">{{ inProgress() ? 'Extracting…' : 'No fields.' }}</td></tr>
                    </ng-template>
                  </p-table>
                </p-tabpanel>
                <p-tabpanel value="json">
                  <p class="muted text-sm mt-0">The structured data the extension uses — recognised fields under their standard key, others under the PDF's label.</p>
                  <pre class="json mono">{{ json() | json }}</pre>
                </p-tabpanel>
                <p-tabpanel value="tables">
                  @for (t of tables(); track t.id) {
                    <div class="mb-5 overflow-x-auto">
                      <div class="muted text-sm mb-1">Page {{ t.page }}</div>
                      <table class="grid-table">
                        <thead><tr>@for (h of t.headers; track $index) { <th>{{ h }}</th> }</tr></thead>
                        <tbody>@for (r of t.rows; track $index) { <tr>@for (c of r; track $index) { <td>{{ c }}</td> }</tr> }</tbody>
                      </table>
                    </div>
                  } @empty {
                    <p class="muted">No tables detected. (Table extraction is basic in this version.)</p>
                  }
                </p-tabpanel>
              </p-tabpanels>
            </p-tabs>
          </div>
          @if (showPdf()) {
            <div class="card pdf">
              @if (pdfUrl()) { <iframe [src]="pdfUrl()" title="PDF preview"></iframe> } @else { <p class="muted p-4">Loading PDF…</p> }
            </div>
          }
        </div>
      } @else if (error()) {
        <p-message severity="error" styleClass="mt-4">{{ error() }}</p-message>
      }
    </div>

    <p-dialog header="Add a field" [visible]="addOpen()" (visibleChange)="addOpen.set($event)" [modal]="true" [style]="{ width: '26rem' }">
      <p class="muted text-sm mt-0">For a value the extractor missed. It is saved as a confirmed (100%) field.</p>
      <label class="block text-sm font-medium mb-1" for="newLabel">Label</label>
      <input pInputText id="newLabel" [(ngModel)]="draft.label" class="w-full mb-3" placeholder="e.g. Date of Birth" />
      <label class="block text-sm font-medium mb-1" for="newValue">Value</label>
      <input pInputText id="newValue" [(ngModel)]="draft.value" class="w-full" />
      <ng-template #footer>
        <p-button label="Cancel" [text]="true" severity="secondary" (onClick)="addOpen.set(false)" />
        <p-button label="Add" icon="pi pi-check" (onClick)="add()" />
      </ng-template>
    </p-dialog>
  `,
  styles: `
    .layout { display: grid; gap: 16px; grid-template-columns: 1fr; }
    .layout.with-pdf { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); }
    .pdf { position: sticky; top: 16px; height: calc(100vh - 140px); overflow: hidden; }
    .pdf iframe { width: 100%; height: 100%; border: 0; }
    .json { background: var(--app-bg); border: 1px solid var(--app-border); border-radius: 8px; padding: 12px; max-height: 60vh; overflow: auto; }
    .grid-table { border-collapse: collapse; font-size: 13px; }
    .grid-table th, .grid-table td { border: 1px solid var(--app-border); padding: 4px 8px; text-align: left; vertical-align: top; }
    .grid-table th { background: var(--app-bg); }
    @media (max-width: 1100px) { .layout.with-pdf { grid-template-columns: 1fr; } .pdf { position: static; height: 70vh; } }
  `,
})
export class DocumentDetailPage implements OnInit, OnDestroy {
  readonly id = input.required<string>();

  private readonly api = inject(ApiService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly doc = signal<DocumentDto | null>(null);
  protected readonly fields = signal<ExtractedField[]>([]);
  protected readonly tables = signal<ExtractedTable[]>([]);
  protected readonly json = signal<Record<string, string>>({});
  protected readonly error = signal('');
  protected readonly filter = signal('');
  protected readonly showPdf = signal(false);
  protected readonly pdfUrl = signal<SafeResourceUrl | null>(null);
  protected readonly inProgress = computed(() => {
    const d = this.doc();
    return Boolean(d && IN_PROGRESS.includes(d.status));
  });
  protected readonly visibleFields = computed(() => {
    const q = this.filter().trim().toLowerCase();
    if (!q) return this.fields();
    return this.fields().filter((f) => `${f.label} ${f.fieldKey} ${f.canonicalKey ?? ''} ${f.valueRaw}`.toLowerCase().includes(q));
  });

  protected draft = { label: '', value: '' };
  protected readonly addOpen = signal(false);
  private objectUrl: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly statusLabel = statusLabel;
  protected readonly statusSeverity = statusSeverity;
  protected readonly confidenceSeverity = confidenceSeverity;
  protected readonly pct = pct;

  ngOnInit() {
    this.load();
  }

  ngOnDestroy() {
    if (this.timer) clearTimeout(this.timer);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  private async load() {
    try {
      const d = await this.api.document(this.id());
      this.doc.set(d);
      if (d.status === 'completed') {
        const [fields, tables, json] = await Promise.all([this.api.fields(d.id), this.api.tables(d.id), this.api.json(d.id)]);
        this.fields.set(fields);
        this.tables.set(tables);
        this.json.set(json);
      } else if (IN_PROGRESS.includes(d.status)) {
        this.timer = setTimeout(() => this.load(), 2000);
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected alternatesText(f: ExtractedField) {
    return (f.validation.alternates || []).map((a) => `p${a.page}: ${a.value}`).join('\n');
  }

  async togglePdf() {
    this.showPdf.update((v) => !v);
    if (this.showPdf() && !this.objectUrl) {
      try {
        const blob = await this.api.fileBlob(this.id());
        this.objectUrl = URL.createObjectURL(blob);
        this.pdfUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.objectUrl));
      } catch (err) {
        this.toast.add({ severity: 'error', summary: 'Could not load the PDF', detail: errorMessage(err) });
      }
    }
  }

  startEdit(f: ExtractedField) {
    this.draft = { label: f.label, value: f.valueRaw };
  }

  async save(f: ExtractedField) {
    try {
      const updated = await this.api.updateField(this.id(), f.id, { label: this.draft.label, value: this.draft.value });
      this.fields.update((list) => list.map((x) => (x.id === f.id ? updated : x)));
      this.json.set(await this.api.json(this.id()));
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Save failed', detail: errorMessage(err) });
    }
  }

  openAdd() {
    this.draft = { label: '', value: '' };
    this.addOpen.set(true);
  }

  async add() {
    try {
      const created = await this.api.addField(this.id(), { label: this.draft.label, value: this.draft.value });
      this.fields.update((list) => [...list, created]);
      this.json.set(await this.api.json(this.id()));
      this.addOpen.set(false);
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not add the field', detail: errorMessage(err) });
    }
  }

  removeField(f: ExtractedField) {
    this.confirm.confirm({
      header: 'Delete field?',
      message: `Remove "${f.label}" from this document's data?`,
      acceptButtonProps: { label: 'Delete', severity: 'danger' },
      rejectButtonProps: { label: 'Cancel', severity: 'secondary', text: true },
      accept: async () => {
        try {
          await this.api.deleteField(this.id(), f.id);
          this.fields.update((list) => list.filter((x) => x.id !== f.id));
          this.json.set(await this.api.json(this.id()));
        } catch (err) {
          this.toast.add({ severity: 'error', summary: 'Delete failed', detail: errorMessage(err) });
        }
      },
    });
  }
}
