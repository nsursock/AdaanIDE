import type { ThemeId, ThemePalette } from "./types.js";

export const THEMES: Record<ThemeId, ThemePalette> = {
  retrowave: {
    id: "retrowave",
    name: "Retrowave",
    base: {
      bg: "#0b0420",
      surface: "#160a35",
      accent: "#ff2e9a",
      text: "#e8e6ff",
      muted: "#7a6aa8",
    },
    syntax: {
      keyword: "#ff2e9a",
      string: "#7afcff",
      comment: "#6b5b95",
      number: "#ffb86c",
      variable: "#e8e6ff",
      function: "#a78bfa",
      type: "#69f0ae",
      operator: "#c084fc",
    },
  },
  ghibli: {
    id: "ghibli",
    name: "Ghibli",
    base: {
      bg: "#f4ecd8",
      surface: "#fff8e7",
      accent: "#4a8b6f",
      text: "#3a3326",
      muted: "#a89a7a",
    },
    syntax: {
      keyword: "#4a8b6f",
      string: "#b5651d",
      comment: "#a89a7a",
      number: "#8b6f47",
      variable: "#3a3326",
      function: "#5a9367",
      type: "#2d6e7e",
      operator: "#7a6a4f",
    },
  },
  fiesta: {
    id: "fiesta",
    name: "Fiesta",
    base: {
      bg: "#0a0414",
      surface: "#281446",
      accent: "#ff006e",
      text: "#f5f0ff",
      muted: "#8a7ab8",
    },
    syntax: {
      keyword: "#ff006e",
      string: "#ffbe0b",
      comment: "#8a7ab8",
      number: "#fb5607",
      variable: "#f5f0ff",
      function: "#a86ff0",
      type: "#3a86ff",
      operator: "#8338ec",
    },
  },
  dawn: {
    id: "dawn",
    name: "Dawn",
    base: {
      bg: "#e9eef6",
      surface: "#f7f3fb",
      accent: "#ff7e6b",
      text: "#2f3340",
      muted: "#a59ac4",
    },
    syntax: {
      keyword: "#ff7e6b",
      string: "#5a8f7b",
      comment: "#a59ac4",
      number: "#d4a017",
      variable: "#2f3340",
      function: "#6b8fd6",
      type: "#8b6fb5",
      operator: "#7a8aa8",
    },
  },
  synthwave84: {
    id: "synthwave84",
    name: "Synthwave '84",
    base: {
      bg: "#241b33",
      surface: "#34294f",
      accent: "#ff7edb",
      text: "#fefefe",
      muted: "#848bbd",
    },
    syntax: {
      keyword: "#ff7edb",
      string: "#fede5d",
      comment: "#848bbd",
      number: "#f92aad",
      variable: "#fefefe",
      function: "#36f9f6",
      type: "#ff7edb",
      operator: "#ff7edb",
    },
  },
  solarizedDark: {
    id: "solarizedDark",
    name: "Solarized Dark",
    base: {
      bg: "#002b36",
      surface: "#073642",
      accent: "#268bd2",
      text: "#93a1a1",
      muted: "#586e75",
    },
    syntax: {
      keyword: "#859900",
      string: "#2aa198",
      comment: "#586e75",
      number: "#d33682",
      variable: "#93a1a1",
      function: "#268bd2",
      type: "#b58900",
      operator: "#859900",
    },
  },
  cottonCandy: {
    id: "cottonCandy",
    name: "Cotton Candy",
    base: {
      bg: "#fbdce2",
      surface: "#fff5f8",
      accent: "#ff9fb2",
      text: "#4a3b4a",
      muted: "#b0a0b0",
    },
    syntax: {
      keyword: "#e87b95",
      string: "#0acdff",
      comment: "#b0a0b0",
      number: "#60ab9a",
      variable: "#4a3b4a",
      function: "#2b9fd6",
      type: "#4a8b7a",
      operator: "#c98ba0",
    },
  },
  goldenTwilight: {
    id: "goldenTwilight",
    name: "Golden Twilight",
    base: {
      bg: "#000814",
      surface: "#001d3d",
      accent: "#ffd60a",
      text: "#f0e8c8",
      muted: "#5a7a9a",
    },
    syntax: {
      keyword: "#ffc300",
      string: "#ffd60a",
      comment: "#5a7a9a",
      number: "#ffd60a",
      variable: "#f0e8c8",
      function: "#ffc300",
      type: "#0acdff",
      operator: "#c8a800",
    },
  },
  brightContrasts: {
    id: "brightContrasts",
    name: "Bright Contrasts",
    base: {
      bg: "#f8ffe5",
      surface: "#ffffff",
      accent: "#ef476f",
      text: "#2d3a2d",
      muted: "#8a9a8a",
    },
    syntax: {
      keyword: "#ef476f",
      string: "#06d6a0",
      comment: "#8a9a8a",
      number: "#ffc43d",
      variable: "#2d3a2d",
      function: "#1b9aaa",
      type: "#06d6a0",
      operator: "#ef476f",
    },
  },
};

export const DEFAULT_THEME: ThemeId = "retrowave";

export const THEME_IDS: ThemeId[] = ["retrowave", "ghibli", "fiesta", "dawn", "synthwave84", "solarizedDark", "cottonCandy", "goldenTwilight", "brightContrasts"];

export function getTheme(id: ThemeId): ThemePalette {
  return THEMES[id] ?? THEMES[DEFAULT_THEME];
}

/**
 * Returns the 5 base CSS custom properties for a theme as an object
 * suitable for applying to a DOM element's style.
 */
export function themeCSSVars(theme: ThemePalette): Record<string, string> {
  return {
    "--bg": theme.base.bg,
    "--surface": theme.base.surface,
    "--accent": theme.base.accent,
    "--text": theme.base.text,
    "--muted": theme.base.muted,
  };
}
