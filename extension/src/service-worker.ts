// The toolbar button opens the side panel; everything else happens in the panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err));

/**
 * A click the page must see as its own, made in the page's world. Older sites
 * wire buttons as <a href="javascript:addRow()">; Chrome refuses to follow
 * such an address for an extension ("Running the JavaScript URL violates the
 * following Content Security Policy directive…"). So the link is not followed:
 * its own click handlers run, and the code in its address runs as the page's
 * own script — what following it would have done. The content script marks the
 * element; the same refusal of save / submit / delete as in content/actions.ts applies.
 *
 * Answers 'clicked', or why not: 'missing' | 'refused' | 'error: …'.
 */
chrome.runtime.onMessage.addListener((message: { type?: string; token?: string }, sender, sendResponse) => {
  if (message?.type !== 'fillpilot.pageClick' || !message.token || sender.tab?.id == null) return undefined;
  chrome.scripting
    .executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: 'MAIN',
      func: (token: string) => {
        const forbidden = /\b(save|submit|remove|delete|request|print|cancel|log\s*out|sign\s*out|upload|download)\b/i;
        const el = document.querySelector(`[data-fillpilot-click="${token}"]`);
        if (!(el instanceof HTMLElement)) return 'missing';
        el.removeAttribute('data-fillpilot-click');
        const owner = el.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
        const captions = [el, owner].map((n) => (n instanceof HTMLInputElement ? n.value : n?.textContent || ''));
        if (captions.some((c) => forbidden.test(c))) return 'refused';

        const link = el.closest('a');
        const href = link?.getAttribute('href') ?? '';
        if (!link || !/^\s*javascript:/i.test(href)) {
          el.click();
          return 'clicked';
        }
        let code = href.replace(/^\s*javascript:/i, '');
        try {
          code = decodeURIComponent(code);
        } catch {
          /* used as written */
        }
        if (/del|remov|submit|save/i.test(code)) return 'refused';
        const noFollow = (e: Event) => e.preventDefault();
        link.addEventListener('click', noFollow);
        el.click();
        link.removeEventListener('click', noFollow);
        // "javascript:void(0)" only stops the link — its onclick did the work. Else the address is the action.
        const hasHandler = el.hasAttribute('onclick') || link.hasAttribute('onclick');
        if (!hasHandler && code.trim() && !/^void\s*\(?\s*0\s*\)?\s*;?$/i.test(code.trim())) {
          const script = document.createElement('script');
          script.textContent = code;
          (document.head || document.documentElement).appendChild(script);
          script.remove();
        }
        return 'clicked';
      },
      args: [message.token],
    })
    .then(([result]) => sendResponse(String(result?.result ?? 'error: no answer from the page')))
    .catch((err: Error) => sendResponse(`error: ${err.message}`));
  return true; // answered asynchronously
});
