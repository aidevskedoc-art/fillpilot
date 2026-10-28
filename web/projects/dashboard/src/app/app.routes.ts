import { Routes } from '@angular/router';
import { adminGuard, authGuard, loginRedirectGuard } from './core/guards';

export const routes: Routes = [
  { path: 'login', canActivate: [loginRedirectGuard], loadComponent: () => import('./features/login').then((m) => m.LoginPage) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', title: 'Dashboard', loadComponent: () => import('./features/dashboard').then((m) => m.DashboardPage) },
      { path: 'mappings', title: 'Mappings', loadComponent: () => import('./features/mappings').then((m) => m.MappingsPage) },
      { path: 'activity', title: 'Activity', loadComponent: () => import('./features/activity').then((m) => m.ActivityPage) },
      { path: 'team-report', title: 'Team report', canActivate: [adminGuard], loadComponent: () => import('./features/team-report').then((m) => m.TeamReportPage) },
      { path: 'users', title: 'Users', canActivate: [adminGuard], loadComponent: () => import('./features/users').then((m) => m.UsersPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
