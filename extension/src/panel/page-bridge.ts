// Talks to the target page through chrome.scripting. Refs from different frames
// can collide ("f1" in two iframes), so they are made unique here as
// "<frameId>:<ref>" and split again when addressing a frame.
import type {
  ActionResult, FieldDescriptor, FillAssignment, FillOutcome, PageAction, PageAgent, PageIdentity, PageOutline,
} from '../../../web/projects/shared/src/page-contract';

export interface ActiveTab {
  tabId: number;
  /** Only known when the extension has host access to the page (approved + enabled). */
  url: URL | null;
  title: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __pdfFormAssistant: PageAgent | undefined;
}

function split(ref: string): { frameId: number; ref: string } {
  const i = ref.indexOf(':');
  return { frameId: Number(ref.slice(0, i)), ref: ref.slice(i + 1) };
}

async function ensureAgent(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
}

export const bridge = {
  async activeTab(): Promise<ActiveTab | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    let url: URL | null = null;
    try {
      url = tab.url ? new URL(tab.url) : null;
    } catch {
      url = null;
    }
    if (url && !['http:', 'https:'].includes(url.protocol)) url = null;
    return { tabId: tab.id, url, title: tab.title || '' };
  },

  /** Must run from a click (user gesture). */
  requestAccess(origin: string): Promise<boolean> {
    return chrome.permissions.request({ origins: [`${origin}/*`] });
  },

  async scan(tabId: number): Promise<FieldDescriptor[]> {
    await ensureAgent(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__pdfFormAssistant?.scan() ?? [],
    });
    return results.flatMap((r) =>
      ((r.result as FieldDescriptor[] | undefined) || []).map((d) => ({ ...d, frameId: r.frameId, ref: `${r.frameId}:${d.ref}` })),
    );
  },

  async fill(tabId: number, assignments: FillAssignment[]): Promise<FillOutcome[]> {
    const byFrame = new Map<number, FillAssignment[]>();
    for (const a of assignments) {
      const { frameId, ref } = split(a.ref);
      if (!byFrame.has(frameId)) byFrame.set(frameId, []);
      byFrame.get(frameId)!.push({ ref, value: a.value });
    }
    const outcomes: FillOutcome[] = [];
    for (const [frameId, list] of byFrame) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: (items: FillAssignment[]) =>
            globalThis.__pdfFormAssistant?.fill(items) ?? items.map((i) => ({ ref: i.ref, ok: false, error: 'Page changed — scan again' })),
          args: [list],
        });
        for (const o of (result?.result as FillOutcome[] | undefined) || []) outcomes.push({ ...o, ref: `${frameId}:${o.ref}` });
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Could not reach the page';
        for (const a of list) outcomes.push({ ref: `${frameId}:${a.ref}`, ok: false, error });
      }
    }
    return outcomes;
  },

  async highlight(tabId: number, ref: string): Promise<void> {
    const { frameId, ref: local } = split(ref);
    await chrome.scripting
      .executeScript({ target: { tabId, frameIds: [frameId] }, func: (r: string) => globalThis.__pdfFormAssistant?.highlight(r), args: [local] })
      .catch(() => undefined);
  },

  /** Runs a site-profile step in the page's main frame (fills, row adds, tab switch, Next). */
  async runActions(tabId: number, actions: PageAction[]): Promise<ActionResult[]> {
    await ensureAgent(tabId);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (list: PageAction[]) => globalThis.__pdfFormAssistant!.runActions(list),
      args: [actions],
    });
    return (result?.result as ActionResult[] | undefined) ?? [];
  },

  async readIdentity(tabId: number): Promise<PageIdentity> {
    await ensureAgent(tabId);
    const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => globalThis.__pdfFormAssistant!.readIdentity() });
    return (result?.result as PageIdentity | undefined) ?? { ipNumber: null, patientName: null };
  },

  async describePage(tabId: number, probes: string[] = []): Promise<PageOutline | null> {
    await ensureAgent(tabId);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (list: string[]) => globalThis.__pdfFormAssistant!.describePage(list),
      args: [probes],
    });
    return (result?.result as PageOutline | undefined) ?? null;
  },

  async clear(tabId: number): Promise<void> {
    await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.__pdfFormAssistant?.clear() })
      .catch(() => undefined);
  },
};
