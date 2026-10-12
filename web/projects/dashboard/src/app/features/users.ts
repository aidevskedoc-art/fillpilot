import { Component, OnInit, inject, signal } from '@angular/core';
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
import type { ManagedUser } from '@shared/api-types';
import { ApiService, errorMessage } from '../core/api.service';

@Component({
  selector: 'app-users',
  imports: [DatePipe, FormsModule, TableModule, ButtonModule, InputTextModule, PasswordModule, SelectModule, DialogModule, TagModule, ToggleSwitchModule],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="text-2xl">Users</h1>
          <p class="muted">Each user sees only their own documents.</p>
        </div>
        <p-button label="New user" icon="pi pi-user-plus" (onClick)="openCreate()" />
      </div>
      <div class="card">
        <p-table [value]="users()" size="small" [rowHover]="true">
          <ng-template #header><tr><th>Username</th><th>Name</th><th>Role</th><th>Active</th><th>Last login</th><th></th></tr></ng-template>
          <ng-template #body let-u>
            <tr>
              <td class="mono">{{ u.username }} @if (u.locked) { <p-tag value="Locked" severity="danger" /> }</td>
              <td>{{ u.fullName }}</td>
              <td>{{ u.role }}</td>
              <td><p-toggleswitch [ngModel]="u.isActive" (ngModelChange)="update(u, { isActive: $event })" /></td>
              <td>{{ u.lastLoginAt ? (u.lastLoginAt | date: 'd MMM y, HH:mm') : 'Never' }}</td>
              <td class="text-right whitespace-nowrap">
                @if (u.locked) { <p-button label="Unlock" [text]="true" size="small" (onClick)="update(u, { unlock: true })" /> }
                <p-button icon="pi pi-pencil" [text]="true" [rounded]="true" (onClick)="openEdit(u)" />
              </td>
            </tr>
          </ng-template>
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
        <div>
          <label class="block text-sm font-medium mb-1" for="u-role">Role</label>
          <p-select inputId="u-role" [options]="roles" [(ngModel)]="form.role" styleClass="w-full" appendTo="body" />
        </div>
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

  protected readonly users = signal<ManagedUser[]>([]);
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<ManagedUser | null>(null);
  protected readonly saving = signal(false);
  protected readonly roles = ['User', 'Admin'];
  protected form = { username: '', fullName: '', role: 'User', password: '' };

  async ngOnInit() {
    try {
      this.users.set(await this.api.users());
    } catch (err) {
      this.toast.add({ severity: 'error', summary: 'Could not load users', detail: errorMessage(err) });
    }
  }

  openCreate() {
    this.editing.set(null);
    this.form = { username: '', fullName: '', role: 'User', password: '' };
    this.dialogOpen.set(true);
  }

  openEdit(u: ManagedUser) {
    this.editing.set(u);
    this.form = { username: u.username, fullName: u.fullName, role: u.role, password: '' };
    this.dialogOpen.set(true);
  }

  async save() {
    this.saving.set(true);
    try {
      const current = this.editing();
      if (current) {
        const body: Record<string, unknown> = { fullName: this.form.fullName, role: this.form.role };
        if (this.form.password) body['password'] = this.form.password;
        const updated = await this.api.updateUser(current.id, body);
        this.users.update((list) => list.map((u) => (u.id === updated.id ? updated : u)));
      } else {
        const created = await this.api.createUser(this.form);
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
