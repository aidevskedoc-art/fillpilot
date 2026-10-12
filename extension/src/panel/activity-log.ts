// What the panel did, kept in the extension's own storage for installations
// without a server-side log ("reader" mode): which steps ran, how each went,
// why a step failed, and the page's structure at that moment. The entries
// name fields and tariff codes, never a patient or an amount — the same
// records the server keeps in its fill history elsewhere.
//
// It exists so that a problem on someone's PC can be understood without
// seeing their screen: "Export activity log" saves it as a file to send.

const KEY = 'fillpilot.activity';
/** The latest runs are enough to diagnose a problem; older ones are dropped. */
const KEEP = 30;
/** A page outline is tens of kilobytes — only the newest runs keep theirs. */
const KEEP_OUTLINES = 8;

type Entry = Record<string, unknown>;

async function read(): Promise<Entry[]> {
  const found = await chrome.storage.local.get(KEY);
  return Array.isArray(found[KEY]) ? (found[KEY] as Entry[]) : [];
}

export const activityLog = {
  async add(entry: unknown): Promise<void> {
    const list = [...(await read()), { at: new Date().toISOString(), ...(entry as Entry) }].slice(-KEEP);
    list.slice(0, Math.max(0, list.length - KEEP_OUTLINES)).forEach((e) => delete e.pageOutline);
    await chrome.storage.local.set({ [KEY]: list });
  },

  /** Saves the log as a file through the browser's own download. → number of entries. */
  async download(): Promise<number> {
    const list = await read();
    const file = new Blob([JSON.stringify({ app: 'FillPilot', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), entries: list }, null, 1)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = `fillpilot-activity-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return list.length;
  },
};
