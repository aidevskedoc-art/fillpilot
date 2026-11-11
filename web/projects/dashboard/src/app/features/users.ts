import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MessageService } from 'primeng/api';
import type { ManagedUser, Role, Unit } from '@shared/api-types';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';

const ROLE_NAMES: Record<Role, string> = { Admin: 'Main admin', UnitAdmin: 'Unit admin', User: 'User' };
/** The unit filter's "users without a unit" entry. */
const NO_UNIT = '-';

@Component({
  selector: 'app-users',
  imports: [DatePipe, FormsModule, TableModule, ButtonModule, InputTextModule, PasswordModule, SelectModule, DialogModule, TagModule, ToggleSwitchModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Users</h1>
          <p class="muted">
            @if (auth.isAdmin()) {
              Each person belongs to a unit. A unit admin manages their own unit's users; the main admin manages all units.
            } @else {
              The users of {{ unitName(auth.user()?.unit) }}. Each user sees only their own work.
            }
          </p>
        </div>
        <div class="flex items-center gap-2">
          @if (auth.isAdmin()) {
            <p-select [options]="filterOptions()" [(ngModel)]="unitShown" optionLabel="label" optionValue="value" ariaLabel="Unit" appendTo="body" />
          }
          <p-button label="New user" icon="pi pi-user-plus" (onClick)="openCreate()" />
        </div>
      </div>
      @if (auth.isAdmin() && withoutUnit() > 0) {
        <div class="card section mb-4 text-sm">
          <i class="pi pi-info-circle"></i> {{ withoutUnit() }} user(s) have no unit yet. Edit them to give each one a unit.
        </div>
      }
      <div class="card">
        <p-table [value]="shown()" size="small" [rowHover]="true">
          <ng-template #header><tr><th>Username</th><th>Name</th><th>Role</th><th>Unit</th><th>Active</th><th>Last login</th><th></th></tr></ng-template>
          <ng-template #body let-u>
            <tr>
              <td class="mono">{{ u.username }} @if (u.locked) { <p-tag value="Locked" severity="danger" /> }</td>
              <td>{{ u.fullName }}</td>
              <td>{{ roleName(u.role) }}</td>
              <td>
                @if (u.unit) { {{ unitName(u.unit) }} <span class="muted text-xs mono">{{ u.unit }}</span> }
                @else if (u.role !== 'Admin') { <p-tag value="No unit" severity="warn" /> }
                @else { <span class="muted">All units</span> }
              </td>
              <td><p-toggleswitch [ngModel]="u.isActive" [disabled]="u.id === auth.user()?.id" (ngModelChange)="update(u, { isActive: $event })" /></td>
              <td>{{ u.lastLoginAt ? (u.lastLoginAt | date: 'd MMM y, HH:mm') : 'Never' }}</td>
              <td class="text-right whitespace-nowrap">
                @if (u.locked) { <p-button label="Unlock" [text]="true" size="small" (onClick)="update(u, { unlock: true })" /> }
                <p-button icon="pi pi-pencil" [text]="true" [rounded]="true" (onClick)="openEdit(u)" />
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="7" class="muted text-center py-6">No users here yet.</td></tr></ng-template>
        </p-table>
      </div>
    </div>

    <p-dialog [header]="editing() ? 'Edit user' : 'New user'" [visible]="dialogOpen()" (visibleChange)="dialogOpen.set($event)" [modal]="true" [style]="{ width: '26rem' }">
      <div class="grid gap-3">
        <div>
          <label class="block text-sm font-medium mb-1" for="u-username">Username</label>
          <input pInputText id="u-username" [(ngModel)]="form.username" [disabled]="!!editing()" class="w-full" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1" for="u-name">Full name</label>
          <input pInputText id="u-name" [(ngModel)]="form.fullName" class="w-full" />
        </div>
        @if (auth.isAdmin()) {
          <div>
            <label class="block text-sm font-medium mb-1" for="u-role">Role</label>
            <p-select inputId="u-role" [options]="roleOptions" optionLabel="label" optionValue="value" [(ngModel)]="form.role"
              [disabled]="editing()?.id === auth.user()?.id" styleClass="w-full" appendTo="body" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1" for="u-unit">Unit</label>
            <p-select inputId="u-unit" [options]="unitOptions()" optionLabel="label" optionValue="value" [(ngModel)]="form.unit"
              [placeholder]="form.role === 'Admin' ? 'All units (none)' : 'Choose the unit'" [showClear]="form.role === 'Admin'" styleClass="w-full" appendTo="body" />
            <div class="muted text-xs mt-1">
              {{ form.role === 'Admin' ? 'A main admin sees every unit; a unit here is only for information.' : form.role === 'UnitAdmin' ? 'Manages the users of this unit and sees its activity and team report.' : 'Sees only their own work.' }}
            </div>
          </div>
        } @else {
          <div class="muted text-sm">
            {{ editing()?.id === auth.user()?.id ? 'Your own account: name and password.' : 'A user of ' + unitName(auth.user()?.unit) + '.' }}
          </div>
        }
        <div>
          <label class="block text-sm font-medium mb-1" for="u-pass">{{ editing() ? 'New password (leave empty to keep)' : 'Password' }}</label>
          <p-password inputId="u-pass" [(ngModel)]="form.password" [feedback]="false" [toggleMask]="true" styleClass="w-full" inputStyleClass="w-full" />
          <div class="muted text-xs mt-1">At least 8 characters.</div>
        </div>
      </div>
      <ng-template #footer>
        <p-button label="Cancel" [text]="true" severity="secondary" (onClick)="dialogOpen.set(false)" />
        <p-button label="Save" icon="pi pi-check" [loading]="saving()" (onClick)="save()" />
      </ng-template>
    </p-dialog>
  `,
})
export class UsersPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MessageService);
  protected readonly auth = inject(AuthService);

  protected readonly users = signal<ManagedUser[]>([]);
  protected readonly units = signal<Unit[]>([]);
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<ManagedUser | null>(null);
  protected readonly saving = signal(false);
  /** The Main Admin's unit filter: '' = all, NO_UNIT = users without one, else a unit code. */
  protected readonly unitFilter = signal('');
  protected readonly roleOptions = (Object.keys(ROLE_NAMES) as Role[]).reverse().map((value) => ({ label: ROLE_NAMES[value], value }));
  protected form: { username: string; fullName: string; role: Role; unit: string | null; password: string } = { username: '', fullName: '', role: 'User', unit: null, password: '' };

  protected readonly unitOptions = computed(() => this.units().map((u) => ({ label: `${u.name} (${u.code})`, value: u.code })));
  protected readonly filterOptions = computed(() => [
    { label: 'All units', value: '' },
    ...this.unitOptions(),
    { label: 'No unit yet', value: NO_UNIT },
  ]);
  protected readonly withoutUnit = computed(() => this.users().filter((u) => !u.unit && u.role !== 'Admin').length);
  protected readonly shown = computed(() => {
    const f = this.unitFilter();
    if (!f) return this.users();
    return this.users().filter((u) => (f === NO_UNIT ? !u.unit : u.unit === f));
  });

  get unitShown() {
    return this.unitFilter();
  }
  set unitShown(value: string) {
    this.unitFilter.set(value ?? '');
  }

  async ngOnInit() {
    try {
      const [users, units] = await Promise.all([this.api.users(), this.api.units()]);
      this.users.set(users);
      this.units.set(units);
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not load users', detail: errorMessage(err) });
    }
  }

  protected roleName(role: Role): string {
    return ROLE_NAMES[role] ?? role;
  }

  protected unitName(code: string | null | undefined): string {
    if (!code) return 'no unit';
    return this.units().find((u) => u.code === code)?.name ?? code;
  }

  openCreate() {
    this.editing.set(null);
    const f = this.unitFilter();
    this.form = { username: '', fullName: '', role: 'User', unit: this.auth.isAdmin() ? (f && f !== NO_UNIT ? f : null) : this.auth.user()?.unit ?? null, password: '' };
    this.dialogOpen.set(true);
  }

  openEdit(u: ManagedUser) {
    this.editing.set(u);
    this.form = { username: u.username, fullName: u.fullName, role: u.role, unit: u.unit ?? null, password: '' };
    this.dialogOpen.set(true);
  }

  async save() {
    if (this.auth.isAdmin() && this.form.role !== 'Admin' && !this.form.unit) {
      this.toast.add({ severity: 'warn', summary: 'Choose the unit', detail: 'A user or unit admin must belong to a unit.' });
      return;
    }
    this.saving.set(true);
    try {
      const current = this.editing();
      // A Unit Admin sends no role or unit: their users are Users of their own unit.
      const roleAndUnit = this.auth.isAdmin() ? { role: this.form.role, unit: this.form.unit ?? null } : {};
      if (current) {
        const body: Record<string, unknown> = { fullName: this.form.fullName, ...(current.id === this.auth.user()?.id ? {} : roleAndUnit) };
        if (this.form.password) body['password'] = this.form.password;
        const updated = await this.api.updateUser(current.id, body);
        this.users.update((list) => list.map((u) => (u.id === updated.id ? updated : u)));
      } else {
        const created = await this.api.createUser({ username: this.form.username, fullName: this.form.fullName, password: this.form.password, role: 'User', ...roleAndUnit });
        this.users.update((list) => [...list, created]);
      }
      this.dialogOpen.set(false);
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not save', detail: errorMessage(err) });
    } finally {
      this.saving.set(false);
    }
  }

  async update(u: ManagedUser, body: Record<string, unknown>) {
    try {
      const updated = await this.api.updateUser(u.id, body);
      this.users.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not update', detail: errorMessage(err) });
      this.ngOnInit();
    }
  }
}
