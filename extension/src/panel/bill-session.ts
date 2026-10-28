// The bill being entered, kept for this browser session only. It is needed to
// fill the form and for nothing afterwards, so it is never stored on the
// server: chrome.storage.session lives in memory, is not written to disk, is
// readable by the extension's own pages only (not by websites), and is
// emptied when the browser closes or the extension reloads. Keeping it there
// rather than in the panel's own memory lets the panel be closed and reopened
// in the middle of a bill.
import type { CilClaim, PmjayClaim, TgnpdclClaim } from '../../../web/projects/shared/src/api-types';

function session<T>(key: string) {
  return {
    async load(): Promise<T | null> {
      const stored = await chrome.storage.session.get(key);
      return (stored[key] as T | undefined) ?? null;
    },
    save(claim: T): Promise<void> {
      return chrome.storage.session.set({ [key]: claim });
    },
    clear(): Promise<void> {
      return chrome.storage.session.remove(key);
    },
  };
}

/** TGNPDCL bill entry. */
export const billSession = session<TgnpdclClaim>('pfa.bill');
/** PM-JAY Treatment Plan — its own slot, so a bill loaded for one site never fills the other. */
export const pmjaySession = session<PmjayClaim>('pfa.pmjay');
/**
 * The package codes the extension has added for that bill — so "Fill again"
 * goes on with the rest instead of guessing from the shortened names in the
 * site's table. `bill` ties the list to the bill it was made for.
 */
export const pmjayAdded = session<{ bill: string; codes: string[] }>('pfa.pmjay.added');
/** Coal India Bill Details (e-Arogya Suvidha). */
export const cilSession = session<CilClaim>('pfa.cil');
