// Use require() directly — Electron's main process module is CJS and
// TypeScript's ESM interop helpers can interfere with it.
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
} = require("electron") as typeof import("electron");
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";

// __dirname is available natively in CommonJS.

const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;
let serverPort = 0;

/** Find a free TCP port by binding to :0 and immediately releasing. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not find free port"));
      }
    });
  });
}

/** Wait for a TCP port to accept connections (server ready check). */
function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`server did not start within ${timeoutMs}ms`));
        return;
      }
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => setTimeout(attempt, 200));
    }
    attempt();
  });
}

/** Kill the spawned server process gracefully. */
function killServer() {
  if (!serverProcess) return;
  try {
    serverProcess.kill("SIGTERM");
    const proc = serverProcess;
    setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      } catch {
        // already dead
      }
    }, 3000);
  } catch {
    // already dead
  }
  serverProcess = null;
}

/**
 * Start the SvelteKit Node server (adapter-node output).
 *
 * In dev mode we don't spawn anything — the vite dev server is already
 * running on port 5174 (launched by `concurrently` in the dev script).
 * In production we spawn the built server from extraResources/server.
 */
async function startServer(): Promise<string> {
  if (isDev) {
    // Vite dev server is started externally by the dev script.
    return "http://localhost:5174";
  }

  serverPort = await findFreePort();

  // The adapter-node build output is copied to extraResources/server.
  // process.resourcesPath points to the extraResources root in production.
  const serverDir = path.join(process.resourcesPath, "server");
  const entryFile = path.join(serverDir, "index.js");

  if (!fs.existsSync(entryFile)) {
    throw new Error(`Server entry not found: ${entryFile}`);
  }

  serverProcess = spawn(process.execPath, [entryFile], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: "127.0.0.1",
      // adapter-node serves from the build dir; ORIGIN is needed for CORS.
      ORIGIN: `http://127.0.0.1:${serverPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: serverDir,
  });

  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    console.log(`[server] ${chunk.toString().trim()}`);
  });
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[server] ${chunk.toString().trim()}`);
  });
  serverProcess.on("exit", (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
  });

  await waitForPort(serverPort);
  return `http://127.0.0.1:${serverPort}`;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow: Electron.BrowserWindow | null = null;

function createWindow(url: string) {
  const options: Electron.BrowserWindowConstructorOptions = {
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  mainWindow = new BrowserWindow(options);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.loadURL(url);

  // Open external links in the system browser, not in Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
      // Only allow external URLs to open in browser; internal routes stay in-app.
      if (!targetUrl.includes("localhost") && !targetUrl.includes("127.0.0.1")) {
        return { action: "deny" };
      }
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Native menus
// ---------------------------------------------------------------------------

function buildMenu(): Electron.Menu {
  const isMac = process.platform === "darwin";

  const appMenu: Electron.MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const fileSubmenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Open Workspace…",
      accelerator: "CmdOrCtrl+O",
      click: () => openWorkspaceDialog(),
    },
    {
      label: "Save",
      accelerator: "CmdOrCtrl+S",
      click: () => {
        mainWindow?.webContents.send("menu:save");
      },
    },
    { type: "separator" },
    {
      label: "New File",
      accelerator: "CmdOrCtrl+N",
      click: () => {
        mainWindow?.webContents.send("menu:new-file");
      },
    },
    { type: "separator" },
  ];
  const closeOrQuit: Electron.MenuItemConstructorOptions = isMac
    ? ({ role: "close", label: "Close Window" } as Electron.MenuItemConstructorOptions)
    : ({ role: "quit", label: "Quit" } as Electron.MenuItemConstructorOptions);
  fileSubmenu.push(closeOrQuit);

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: "File",
    submenu: fileSubmenu,
  };

  const editMenu: Electron.MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac
        ? ([{ type: "separator" }, { role: "front" }] as Electron.MenuItemConstructorOptions[])
        : ([{ role: "close" }] as Electron.MenuItemConstructorOptions[])),
    ],
  };

  const template: Electron.MenuItemConstructorOptions[] = isMac
    ? [appMenu, fileMenu, editMenu, viewMenu, windowMenu]
    : [fileMenu, editMenu, viewMenu, windowMenu];

  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------
// IPC: native file dialogs
// ---------------------------------------------------------------------------

async function openWorkspaceDialog(): Promise<void> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Open Workspace",
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const workspacePath = result.filePaths[0];
    mainWindow?.webContents.send("workspace:opened", workspacePath);
  }
}

ipcMain.handle("dialog:open-workspace", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Open Workspace",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Open File",
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:save-file", async (_event, defaultName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: "Save File",
    defaultPath: defaultName,
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle("app:is-dev", () => isDev);

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single instance lock — prevent multiple AdaanIDE windows.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());

  try {
    const url = await startServer();
    createWindow(url);
  } catch (err) {
    dialog.showErrorBox(
      "Failed to start AdaanIDE",
      `The backend server could not be started:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // On macOS, keep the app running with no windows (standard behavior).
  if (process.platform !== "darwin") {
    killServer();
    app.quit();
  }
});

app.on("activate", () => {
  // On macOS, re-create a window when the dock icon is clicked.
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
    if (serverPort || isDev) {
      const url = isDev
        ? "http://localhost:5174"
        : `http://127.0.0.1:${serverPort}`;
      createWindow(url);
    }
  }
});

app.on("before-quit", () => {
  killServer();
});
