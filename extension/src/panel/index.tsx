import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, savedTheme } from './theme';

applyTheme(savedTheme());

// A file dropped beside a drop area would otherwise make the browser open it
// in place of the panel.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
