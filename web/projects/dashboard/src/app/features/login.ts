import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { MessageModule } from 'primeng/message';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/api.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, ButtonModule, InputTextModule, PasswordModule, MessageModule],
  template: `
    <div class="wrap">
      <form class="card login" (ngSubmit)="submit()">
        <div class="flex items-center gap-3 mb-5">
          <span class="logo"><i class="pi pi-file-edit"></i></span>
          <div>
            <h1 class="text-lg">FillPilot</h1>
            <div class="muted text-sm">Sign in to manage documents and mappings</div>
          </div>
        </div>
        @if (error()) {
          <p-message severity="error" styleClass="mb-4 w-full">{{ error() }}</p-message>
        }
        <label class="block text-sm font-medium mb-1" for="username">Username</label>
        <input pInputText id="username" name="username" [(ngModel)]="username" autocomplete="username" class="w-full mb-4" required />
        <label class="block text-sm font-medium mb-1" for="password">Password</label>
        <p-password inputId="password" name="password" [(ngModel)]="password" [feedback]="false" [toggleMask]="true"
          autocomplete="current-password" styleClass="w-full mb-5" inputStyleClass="w-full" />
        <p-button type="submit" label="Sign in" icon="pi pi-sign-in" styleClass="w-full" [loading]="busy()" />
      </form>
    </div>
  `,
  styles: `
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
    .login { width: 100%; max-width: 380px; padding: 28px; }
    .logo { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; background: var(--p-primary-color); color: var(--p-primary-contrast-color); font-size: 18px; }
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected username = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async submit() {
    if (!this.username || !this.password) {
      this.error.set('Enter your username and password');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.username, this.password);
      this.router.navigateByUrl('/dashboard');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
