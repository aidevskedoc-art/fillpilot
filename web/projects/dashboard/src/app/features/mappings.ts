import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TagModule } from 'primeng/tag';
import { ConfirmationService, MessageService } from 'primeng/api';
import type { AllowedSite, FieldAlias, FormMapping } from '@shared/api-types';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';

interface AliasGroup {
  canonicalKey: string;
  aliases: FieldAlias[];
}

@Component({
  selector: 'app-mappings',
  imports: [DatePipe, FormsModule, TableModule, TabsModule, ButtonModule, InputTextModule, ToggleSwitchModule, TagModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Mappings</h1>
          <p class="muted">Which websites the extension may fill, what it learned from confirmed mappings, and the label dictionary it matches with.</p>
        </div>
      </div>

      <div class="card">
        <p-tabs value="sites">
          <p-tablist>
            <p-tab value="sites">Allowed sites ({{ sites().length }})</p-tab>
            <p-tab value="saved">Saved form mappings ({{ mappings().length }})</p-tab>
            <p-tab value="aliases">Field aliases ({{ aliasGroups().length }} keys)</p-tab>
          </p-tablist>
          <p-tabpanels>
            <p-tabpanel value="sites">
              <p class="muted text-sm mt-0">The extension refuses to scan or fill any website not on this list.</p>
              @if (auth.isAdmin()) {
                <div class="flex gap-2 flex-wrap mb-4">
                  <input pInputText placeholder="https://portal.example.com" [(ngModel)]="newSite.origin" class="w-80" />
                  <input pInputText placeholder="Display name" [(ngModel)]="newSite.displayName" class="w-56" />
                  <p-button label="Allow site" icon="pi pi-plus" (onClick)="addSite()" />
                </div>
              }
              <p-table [value]="sites()" size="small" [rowHover]="true">
                <ng-template #header><tr><th>Website</th><th>Name</th><th>Active</th><th>Added</th><th></th></tr></ng-template>
                <ng-template #body let-s>
                  <tr>
                    <td class="mono">{{ s.origin }}</td>
                    <td>{{ s.displayName }}</td>
                    <td>
                      @if (auth.isAdmin()) {
                        <p-toggleswitch [ngModel]="s.isActive" (ngModelChange)="toggleSite(s, $event)" />
                      } @else {
                        <p-tag [value]="s.isActive ? 'Active' : 'Off'" [severity]="s.isActive ? 'success' : 'secondary'" />
                      }
                    </td>
                    <td>{{ s.createdAt | date: 'd MMM y' }}</td>
                    <td class="text-right">
                      @if (auth.isAdmin()) { <p-button icon="pi pi-trash" [text]="true" [rounded]="true" severity="danger" (onClick)="removeSite(s)" /> }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="5" class="muted text-center py-6">No websites approved yet{{ auth.isAdmin() ? ' — add one above.' : '. Ask an administrator.' }}</td></tr></ng-template>
              </p-table>
            </p-tabpanel>

            <p-tabpanel value="saved">
              <p class="muted text-sm mt-0">Created when a user confirms a manual mapping in the extension with "Save for this form". Used as a 100% match next time, for everyone.</p>
              <p-table [value]="mappings()" size="small" [rowHover]="true" [paginator]="mappings().length > 25" [rows]="25">
                <ng-template #header><tr><th>Website</th><th>Form</th><th>Web field</th><th>PDF field</th><th>Used</th><th>By</th><th></th></tr></ng-template>
                <ng-template #body let-m>
                  <tr>
                    <td class="mono">{{ m.origin }}</td>
                    <td class="mono">{{ m.formKey }}</td>
                    <td>{{ m.webFieldLabel }}</td>
                    <td class="mono">{{ m.canonicalKey || m.fieldKey }}</td>
                    <td>{{ m.useCount }}×</td>
                    <td>{{ m.createdBy }}<div class="muted text-xs">{{ m.createdAt | date: 'd MMM y' }}</div></td>
                    <td class="text-right"><p-button icon="pi pi-trash" [text]="true" [rounded]="true" severity="danger" (onClick)="removeMapping(m)" /></td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="7" class="muted text-center py-6">No saved mappings yet.</td></tr></ng-template>
              </p-table>
            </p-tabpanel>

            <p-tabpanel value="aliases">
              <p class="muted text-sm mt-0">
                Labels that mean the same thing ("Name of Patient", "Insured Name", "Policyholder" → patientName). Both PDF labels and website labels are matched through this list.
                After changing it, re-run extraction on a document (Documents → refresh) to re-tag its fields.
              </p>
              @if (auth.isAdmin()) {
                <div class="flex gap-2 flex-wrap mb-4">
                  <input pInputText placeholder="canonical key, e.g. patientName" [(ngModel)]="newAlias.canonicalKey" class="w-64 mono" />
                  <input pInputText placeholder="label, e.g. Name of Beneficiary" [(ngModel)]="newAlias.alias" class="w-72" />
                  <p-button label="Add alias" icon="pi pi-plus" (onClick)="addAlias()" />
                </div>
              }
              <input pInputText type="search" placeholder="Filter" [ngModel]="aliasFilter()" (ngModelChange)="aliasFilter.set($event)" class="w-64 mb-3" />
              <div class="grid gap-2">
                @for (g of filteredGroups(); track g.canonicalKey) {
                  <div class="alias-row">
                    <div class="mono font-bold">{{ g.canonicalKey }}</div>
                    <div class="flex flex-wrap gap-1">
                      @for (a of g.aliases; track a.id) {
                        <span class="chip">{{ a.alias }}
                          @if (auth.isAdmin()) { <button type="button" class="chip-x" (click)="removeAlias(a)" [attr.aria-label]="'Remove ' + a.alias">×</button> }
                        </span>
                      }
                    </div>
                  </div>
                }
              </div>
            </p-tabpanel>
          </p-tabpanels>
        </p-tabs>
      </div>
    </div>
  `,
  styles: `
    .alias-row { display: grid; grid-template-columns: 200px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--app-border); }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; background: var(--app-bg); border: 1px solid var(--app-border); font-size: 12.5px; }
    .chip-x { border: 0; background: none; cursor: pointer; color: var(--app-muted); padding: 0 2px; font-size: 14px; line-height: 1; }
    .chip-x:hover { color: var(--p-red-500); }
    @media (max-width: 640px) { .alias-row { grid-template-columns: 1fr; gap: 4px; } }
  `,
})
export class MappingsPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  protected readonly sites = signal<AllowedSite[]>([]);
  protected readonly mappings = signal<FormMapping[]>([]);
  protected readonly aliases = signal<FieldAlias[]>([]);
  protected readonly aliasFilter = signal('');
  protected readonly aliasGroups = computed<AliasGroup[]>(() => {
    const groups = new Map<string, FieldAlias[]>();
    for (const a of this.aliases()) groups.set(a.canonicalKey, [...(groups.get(a.canonicalKey) || []), a]);
    return [...groups.entries()].map(([canonicalKey, aliases]) => ({ canonicalKey, aliases }));
  });
  protected readonly filteredGroups = computed(() => {
    const q = this.aliasFilter().trim().toLowerCase();
    if (!q) return this.aliasGroups();
    return this.aliasGroups().filter((g) => g.canonicalKey.toLowerCase().includes(q) || g.aliases.some((a) => a.alias.toLowerCase().includes(q)));
  });

  protected newSite = { origin: '', displayName: '' };
  protected newAlias = { canonicalKey: '', alias: '' };

  async ngOnInit() {
    try {
      const [sites, mappings, aliases] = await Promise.all([this.api.allowedSites(this.auth.isAdmin()), this.api.formMappings(), this.api.aliases()]);
      this.sites.set(sites);
      this.mappings.set(mappings);
      this.aliases.set(aliases);
    } catch (err) {
      this.fail('Could not load mappings', err);
    }
  }

  private fail(summary: string, err: unknown) {
    this.toast.add({ severity: 'error', summary, detail: errorMessage(err) });
  }

  async addSite() {
    try {
      const site = await this.api.addSite(this.newSite);
      this.sites.update((list) => [...list, site]);
      this.newSite = { origin: '', displayName: '' };
    } catch (err) {
      this.fail('Could not add the site', err);
    }
  }

  async toggleSite(site: AllowedSite, isActive: boolean) {
    try {
      const updated = await this.api.updateSite(site.id, { isActive });
      this.sites.update((list) => list.map((s) => (s.id === site.id ? updated : s)));
    } catch (err) {
      this.fail('Could not update the site', err);
    }
  }

  removeSite(site: AllowedSite) {
    this.confirm.confirm({
      header: 'Remove website?',
      message: `The extension will stop filling forms on ${site.origin}.`,
      acceptButtonProps: { label: 'Remove', severity: 'danger' },
      rejectButtonProps: { label: 'Cancel', severity: 'secondary', text: true },
      accept: async () => {
        try {
          await this.api.deleteSite(site.id);
          this.sites.update((list) => list.filter((s) => s.id !== site.id));
        } catch (err) {
          this.fail('Could not remove the site', err);
        }
      },
    });
  }

  async removeMapping(m: FormMapping) {
    try {
      await this.api.deleteMapping(m.id);
      this.mappings.update((list) => list.filter((x) => x.id !== m.id));
    } catch (err) {
      this.fail('Could not delete the mapping', err);
    }
  }

  async addAlias() {
    try {
      const alias = await this.api.addAlias(this.newAlias);
      this.aliases.update((list) => [...list, alias]);
      this.newAlias = { canonicalKey: this.newAlias.canonicalKey, alias: '' };
    } catch (err) {
      this.fail('Could not add the alias', err);
    }
  }

  async removeAlias(a: FieldAlias) {
    try {
      await this.api.deleteAlias(a.id);
      this.aliases.update((list) => list.filter((x) => x.id !== a.id));
    } catch (err) {
      this.fail('Could not delete the alias', err);
    }
  }
}
