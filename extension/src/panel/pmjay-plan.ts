// PM-JAY provider portal (provider.nha.gov.in, Transaction Management System)
// site profile: the claim's procedure rows → one "add to Treatment Plan" action
// each. Labels are matched as written on the site (screenshots, 2026-10-13); a
// step that fails saves the page outline, so the profile can be corrected.

import type { PmjayClaim } from '../../../web/projects/shared/src/api-types';
import type { PageAction } from '../../../web/projects/shared/src/page-contract';

/** Any page of the PM-JAY provider portal — the Treatment Plan is on several (discharge, resubmission…). */
export function isPmjayPage(url: URL | null): boolean {
  return Boolean(url && /(^|\.)provider\.nha\.gov\.in$/i.test(url.hostname));
}

/** Captions this profile relies on — located in the page outline saved when a step fails. */
export const PMJAY_PROBES = [
  'Treatment\\s*Plan', '^\\s*Speciality\\s*:?$', '^\\s*Procedure\\s*:?$', 'No\\.?\\s*of\\s*Days', '^\\s*ICHI\\s*Code\\s*:?$',
  'Stratification', 'Level\\s*of\\s*care', '^\\s*\\+\\s*$',
];

export function buildPmjayActions(claim: PmjayClaim): PageAction[] {
  return claim.procedures.map((p) => ({
    type: 'addProcedure',
    code: p.code,
    units: p.units,
    label: `${p.code} ${p.description} — ${p.units} unit(s)`,
  }));
}

/** What a step was, without anything from the bill beyond the package code. */
export function pmjayAuditLabel(action: PageAction): string {
  return action.type === 'addProcedure' ? `Procedure ${action.code}` : action.label;
}
