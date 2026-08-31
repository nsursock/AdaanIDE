import type { ThemeId } from "../types.js";
import { DEFAULT_THEME, THEME_IDS, getTheme, themeCSSVars } from "../themes.js";

const STORAGE_KEY = "adaan-theme";

const isBrowser = typeof window !== "undefined";

function loadTheme(): ThemeId {
  if (!isBrowser) return DEFAULT_THEME;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (THEME_IDS as string[]).includes(stored)) return stored as ThemeId;
  } catch {
    // localStorage not available
  }
  return DEFAULT_THEME;
}

function applyTheme(id: ThemeId) {
  if (!isBrowser) return;
  const theme = getTheme(id);
  const html = document.documentElement;
  html.setAttribute("data-theme", id);
  const vars = themeCSSVars(theme);
  for (const [key, value] of Object.entries(vars)) {
    html.style.setProperty(key, value);
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
}

class ThemeStore {
  current = $state<ThemeId>(loadTheme());

  set(id: ThemeId) {
    this.current = id;
    applyTheme(id);
  }

  toggle() {
    const idx = THEME_IDS.indexOf(this.current);
    this.set(THEME_IDS[(idx + 1) % THEME_IDS.length]);
  }

  init() {
    applyTheme(this.current);
  }
}

export const themeStore = new ThemeStore();
