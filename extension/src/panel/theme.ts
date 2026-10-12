// Dark is the product's look; light is there for bright rooms. The choice is
// a display preference only, so it is kept in this page's localStorage.
export type Theme = 'dark' | 'light';

const KEY = 'fillpilot.theme';

export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode — the theme still applies for this visit */
  }
}
