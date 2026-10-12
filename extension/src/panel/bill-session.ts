// The bill being entered, kept for this browser session only. It is needed to
// fill the form and for nothing afterwards, so it is never stored on the
// server: chrome.storage.session lives in memory, is not written to disk, is
// readable by the extension's own pages only (not by websites), and is
// emptied when the browser closes or the extension reloads. Keeping it there
// rather than in the panel's own memory lets the panel be closed and reopened
// in the middle of a bill.
import type { TgnpdclClaim } from '../../../web/projects/shared/src/api-types';

const KEY = 'pfa.bill';

export const billSession = {
  async load(): Promise<TgnpdclClaim | null> {
    const stored = await chrome.storage.session.get(KEY);
    return (stored[KEY] as TgnpdclClaim | undefined) ?? null;
  },
  save(claim: TgnpdclClaim): Promise<void> {
    return chrome.storage.session.set({ [KEY]: claim });
  },
  clear(): Promise<void> {
    return chrome.storage.session.remove(KEY);
  },
};
