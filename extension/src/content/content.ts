// Injected on demand (chrome.scripting, all frames) only on approved sites the
// user enabled. Installs the agent on this isolated world's global — page
// scripts can't see it, and nothing is ever posted to the page.

import type { PageAgent } from '../../../web/projects/shared/src/page-contract';
import { clearRefs, scanPage } from './scan';
import { fillFields, highlightField } from './fill';
import { describePage, readIdentity, runActions } from './actions';

declare global {
  // eslint-disable-next-line no-var
  var __pdfFormAssistant: PageAgent | undefined;
}

// Re-installed on every injection so a rebuilt extension's newer agent replaces an old one.
globalThis.__pdfFormAssistant = {
  scan: () => scanPage(),
  fill: (assignments) => fillFields(assignments),
  highlight: (ref) => highlightField(ref),
  clear: () => clearRefs(),
  runActions: (actions) => runActions(actions),
  readIdentity: () => readIdentity(),
  describePage: (probes) => describePage(probes),
};
