import type { ThemeId } from "../types.js";
import { THEME_IDS, getTheme, themeCSSVars } from "../themes.js";
import { settingsStore } from "./settings.svelte.js";

const isBrowser = typeof window !== "undefined";

function applyTheme(id: ThemeId) {
  if (!isBrowser) return;
  const theme = getTheme(id);
  const html = document.documentElement;
  html.setAttribute("data-theme", id);
  const vars = themeCSSVars(theme);
  for (const [key, value] of Object.entries(vars)) {
    html.style.setProperty(key, value);
  }
}

class ThemeStore {
  /** Reactive view over the persisted settings — single source of truth. */
  get current(): ThemeId {
    return settingsStore.settings.theme;
  }

  set(id: ThemeId) {
    settingsStore.setTheme(id);
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
