/// <reference types="@sveltejs/kit" />

// --- Electron desktop bridge (only available when running inside the
// --- AdaanIDE Electron wrapper; absent in a plain browser). ---

export interface AdaanDesktopAPI {
  isDev: () => Promise<boolean>;
  openWorkspaceDialog: () => Promise<string | null>;
  openFileDialog: () => Promise<string | null>;
  saveFileDialog: (defaultName: string) => Promise<string | null>;
  onSave: (callback: () => void) => () => void;
  onOpenWorkspace: (callback: () => void) => () => void;
  onNewFile: (callback: () => void) => () => void;
  onWorkspaceOpened: (callback: (path: string) => void) => () => void;
  platform: string;
}

declare global {
  interface Window {
    adaan?: AdaanDesktopAPI;
  }
}

export {};
