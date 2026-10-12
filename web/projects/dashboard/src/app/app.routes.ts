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
      { path: 'documents', title: 'Documents', loadComponent: () => import('./features/documents').then((m) => m.DocumentsPage) },
      { path: 'documents/:id', title: 'Document', loadComponent: () => import('./features/document-detail').then((m) => m.DocumentDetailPage) },
      { path: 'mappings', title: 'Mappings', loadComponent: () => import('./features/mappings').then((m) => m.MappingsPage) },
      { path: 'activity', title: 'Activity', loadComponent: () => import('./features/activity').then((m) => m.ActivityPage) },
      { path: 'users', title: 'Users', canActivate: [adminGuard], loadComponent: () => import('./features/users').then((m) => m.UsersPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
