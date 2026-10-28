import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { AuthService } from '../core/auth.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  admin?: boolean;
}

const NAV: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', icon: 'pi pi-home' },
  { path: '/mappings', label: 'Mappings', icon: 'pi pi-sitemap' },
  { path: '/activity', label: 'Activity', icon: 'pi pi-history' },
  { path: '/team-report', label: 'Team report', icon: 'pi pi-chart-bar', admin: true },
  { path: '/users', label: 'Users', icon: 'pi pi-users', admin: true },
];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ButtonModule],
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="logo"><i class="pi pi-file-edit"></i></span>
          <span class="brand-name">FillPilot</span>
        </div>
        <nav>
          @for (item of nav(); track item.path) {
            <a [routerLink]="item.path" routerLinkActive="active" class="nav-link">
              <i [class]="item.icon"></i><span>{{ item.label }}</span>
            </a>
          }
        </nav>
        <div class="user">
          <div class="min-w-0">
            <div class="truncate font-medium">{{ auth.user()?.fullName }}</div>
            <div class="muted text-xs">{{ auth.user()?.role }}</div>
          </div>
          <p-button icon="pi pi-sign-out" [text]="true" [rounded]="true" severity="secondary" ariaLabel="Sign out" (onClick)="logout()" />
        </div>
      </aside>
      <main class="content"><router-outlet /></main>
    </div>
  `,
  styles: `
    .shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
    .sidebar { display: flex; flex-direction: column; gap: 8px; padding: 18px 12px; border-right: 1px solid var(--app-border); background: var(--app-card); position: sticky; top: 0; height: 100vh; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 14px; }
    .logo { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: var(--p-primary-color); color: var(--p-primary-contrast-color); }
    .brand-name { font-weight: 650; font-size: 15px; }
    nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .nav-link { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; color: var(--app-text); text-decoration: none; }
    .nav-link:hover { background: var(--p-surface-100); }
    .nav-link.active { background: var(--p-highlight-background); color: var(--p-highlight-color); font-weight: 600; }
    .user { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 8px 0; border-top: 1px solid var(--app-border); }
    .content { min-width: 0; }
    @media (prefers-color-scheme: dark) { .nav-link:hover { background: var(--p-surface-800); } }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--app-border); }
      .brand { padding: 0; }
      .brand-name { display: none; }
      nav { flex-direction: row; overflow-x: auto; }
      .nav-link span { display: none; }
      .user { border-top: 0; padding: 0; }
      .user .min-w-0 { display: none; }
    }
  `,
})
export class Shell {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly nav = computed(() => NAV.filter((n) => !n.admin || this.auth.isAdmin()));

  async logout() {
    await this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
