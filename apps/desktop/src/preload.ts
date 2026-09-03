const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

/**
 * Preload script — runs in an isolated context with Node.js access, and
 * exposes a minimal, safe API to the renderer (the SvelteKit app) via
 * contextBridge. The renderer never touches Node directly.
 *
 * The `adaan` object is available on `window.adaan` in the renderer.
 */
const api = {
  /** Whether we're running in dev mode (vite dev server). */
  isDev: (): Promise<boolean> => ipcRenderer.invoke("app:is-dev"),

  // --- Native dialogs ---

  /** Show the OS "open directory" dialog; returns the path or null. */
  openWorkspaceDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:open-workspace"),

  /** Show the OS "open file" dialog; returns the path or null. */
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:open-file"),

  /** Show the OS "save file" dialog; returns the path or null. */
  saveFileDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke("dialog:save-file", defaultName),

  // --- Menu event listeners (native menu → renderer) ---

  /** Fired when File → Save (Cmd/Ctrl+S) is clicked in the native menu. */
  onSave: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("menu:save", handler);
    return () => ipcRenderer.removeListener("menu:save", handler);
  },

  /** Fired when File → Open Workspace (Cmd/Ctrl+O) is clicked. */
  onOpenWorkspace: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("menu:open-workspace", handler);
    return () => ipcRenderer.removeListener("menu:open-workspace", handler);
  },

  /** Fired when File → New File (Cmd/Ctrl+N) is clicked. */
  onNewFile: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("menu:new-file", handler);
    return () => ipcRenderer.removeListener("menu:new-file", handler);
  },

  /** Fired when a workspace path is selected from the native open dialog. */
  onWorkspaceOpened: (callback: (path: string) => void) => {
    const handler = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on("workspace:opened", handler);
    return () => ipcRenderer.removeListener("workspace:opened", handler);
  },

  // --- Platform info ---

  platform: process.platform,
};

export type AdaanDesktopAPI = typeof api;

contextBridge.exposeInMainWorld("adaan", api);
