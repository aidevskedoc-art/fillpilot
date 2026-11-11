import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = () =>
  inject(AuthService).isAuthenticated() ? true : inject(Router).parseUrl('/login');

export const loginRedirectGuard: CanActivateFn = () =>
  inject(AuthService).isAuthenticated() ? inject(Router).parseUrl('/dashboard') : true;

export const adminGuard: CanActivateFn = () =>
  inject(AuthService).isAdmin() ? true : inject(Router).parseUrl('/dashboard');

/** The Main Admin or a Unit Admin. */
export const managerGuard: CanActivateFn = () =>
  inject(AuthService).isManager() ? true : inject(Router).parseUrl('/dashboard');
