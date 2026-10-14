import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { App } from './App';
import { GuidePage } from './Guide';
import { applyTheme, savedTheme } from './theme';

applyTheme(savedTheme());

// A file dropped beside a drop area would otherwise make the browser open it
// in place of the panel.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

const root = createRoot(document.getElementById('root')!);

// index.html?guide — "How FillPilot works" as a page of its own (opened from the guide in the panel).
if (new URLSearchParams(location.search).has('guide')) {
  api.init().catch(() => null).finally(() => root.render(<StrictMode><GuidePage /></StrictMode>));
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
