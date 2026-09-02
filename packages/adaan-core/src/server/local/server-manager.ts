import { spawn, execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { getProviderSpec, PROVIDER_SPECS } from "./providers.js";
import { probeServer } from "./discovery.js";
import type { ProviderSpec } from "./types.js";

const execFileAsync = promisify(execFile);

/** Max time to wait for a server to become ready after spawning. */
const READINESS_TIMEOUT_MS = 60_000;
/** Interval between readiness probes. */
const PROBE_INTERVAL_MS = 1_500;
/** Timeout for the load command (LM Studio). */
const LOAD_TIMEOUT_MS = 30_000;
/** Time to wait after stopping a server before checking the port. */
const STOP_SETTLE_MS = 500;
/** Max retries when waiting for a port to be released after kill. */
const PORT_RELEASE_RETRIES = 20;

interface ManagedServer {
  pid: number;
  providerId: string;
  /** The model id the caller asked for (the discovery alias). */
  requestedModelId: string | null;
  /** The model the server actually reports via /v1/models — the name the
   *  API expects in chat requests. May differ from `requestedModelId`. */
  modelId: string | null;
  startedAt: number;
}

/** Currently managed server processes, keyed by providerId. */
const servers = new Map<string, ManagedServer>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if a TCP port is open (something is listening on it). Faster
 *  and more reliable than probeServer for checking if a killed process
 *  has released its port. */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "localhost" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Kill all processes matching a `pkill -f` pattern. Uses SIGKILL
 *  directly because ML server processes (Python, etc.) often don't
 *  respond to SIGTERM during model loading. We use `pkill -f` instead
 *  of killing by PID because CLI tools (rapid-mlx, etc.) fork child
 *  processes that hold the port, and `process.kill(pid)` can hang on
 *  macOS when targeting these processes. */
async function killByPattern(pattern: string): Promise<void> {
  return new Promise((resolve) => {
    exec(`pkill -9 -f '${pattern.replace(/'/g, "'\\''")}'`, { timeout: 5_000 }, () => {
      // pkill returns non-zero if no processes matched — that's fine
      resolve();
    });
  });
}

/** Stop a single provider's server. Tries the provider's clean stop
 *  command first, then falls back to `pkill -f` with the kill pattern. */
async function stopProviderServer(providerId: string): Promise<boolean> {
  const spec = getProviderSpec(providerId);
  if (!spec) return false;

  // Try the provider's clean stop command first (LM Studio has one)
  if (spec.stopCommand) {
    try {
      await execFileAsync(spec.stopCommand[0], spec.stopCommand.slice(1), {
        timeout: 5_000,
      });
      // Check if the port was actually released
      if (!(await isPortOpen(spec.port))) return true;
    } catch {
      // Fall through to pkill
    }
  }

  // Kill by pattern — most reliable way to kill ML server processes
  await killByPattern(spec.killPattern);

  // Wait for port to be released
  for (let i = 0; i < PORT_RELEASE_RETRIES; i++) {
    await sleep(STOP_SETTLE_MS);
    if (!(await isPortOpen(spec.port))) return true;
  }

  return false;
}

/** Wait for a server to respond on its endpoint, polling until ready or
 *  the timeout expires. */
async function waitForReady(port: number, apiPath: string): Promise<boolean> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeServer(port, apiPath)) return true;
    await sleep(PROBE_INTERVAL_MS);
  }
  return false;
}

/** Query a running server's /v1/models endpoint and return the first
 *  model id it reports. The alias used to start the server (e.g.
 *  `qwen3.5-4b-4bit`) may differ from the model name the API expects
 *  (e.g. `mlx-community/Qwen3.5-4B-MLX-4bit`). */
async function getServedModelName(port: number, apiPath: string): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}${apiPath}/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    if (data.data && data.data.length > 0) {
      return data.data[0].id;
    }
  } catch {
    // server not ready or unexpected response
  }
  return null;
}

/** Stop ALL running servers across all providers. Probes ports in
 *  parallel (TCP, not HTTP) for speed. */
async function stopAllServers(): Promise<void> {
  const probes = await Promise.all(
    PROVIDER_SPECS.map(async (spec) => ({
      spec,
      running: await isPortOpen(spec.port),
    })),
  );
  const toStop = probes
    .filter(({ spec, running }) => running || servers.has(spec.id))
    .map(({ spec }) =>
      (async () => {
        await stopProviderServer(spec.id);
        servers.delete(spec.id);
      })(),
    );
  await Promise.all(toStop);
}

/** Stop all running servers except the given provider. */
async function stopAllServersExcept(keepProviderId: string): Promise<void> {
  const probes = await Promise.all(
    PROVIDER_SPECS.filter((s) => s.id !== keepProviderId).map(async (spec) => ({
      spec,
      running: await isPortOpen(spec.port),
    })),
  );
  const toStop = probes
    .filter(({ spec, running }) => running || servers.has(spec.id))
    .map(({ spec }) =>
      (async () => {
        await stopProviderServer(spec.id);
        servers.delete(spec.id);
      })(),
    );
  await Promise.all(toStop);
}

/** Start a local model server.
 *
 *  When `singleModel` is true (default), all other running servers are
 *  stopped first so only one model runs on the machine at a time. When
 *  false, other providers' servers are left running — useful on machines
 *  with enough RAM to hold multiple models simultaneously (each provider
 *  uses its own port).
 *
 *  For per-model strategy (Rapid-MLX), the same provider's server is
 *  always stopped and restarted with the new model, regardless of
 *  `singleModel`, because one server can only serve one model.
 *
 *  After the server is ready, queries /v1/models to discover the actual
 *  model name the API expects. Returns the endpoint and served model name. */
export async function startServer(
  providerId: string,
  modelId?: string,
  singleModel: boolean = true,
): Promise<{ endpoint: string; alreadyRunning: boolean; servedModel: string | null }> {
  const spec = getProviderSpec(providerId);
  if (!spec) throw new Error(`Unknown provider: ${providerId}`);

  const sameProviderRunning = await isPortOpen(spec.port);
  const tracked = servers.get(providerId);
  const sameModel = tracked?.modelId === modelId;

  // Ollama (single-server): if already running with the same model, reuse it.
  // Just stop other providers if singleModel is on.
  if (spec.serveStrategy === "single-server" && sameProviderRunning && sameModel) {
    if (singleModel) {
      await stopAllServersExcept(providerId);
    }
    if (!tracked) {
      servers.set(providerId, {
        pid: 0,
        providerId,
        requestedModelId: modelId ?? null,
        modelId: modelId ?? null,
        startedAt: Date.now(),
      });
    }
    const servedModel = await getServedModelName(spec.port, spec.apiPath);
    return {
      endpoint: `http://localhost:${spec.port}${spec.apiPath}`,
      alreadyRunning: true,
      servedModel: servedModel ?? modelId ?? null,
    };
  }

  // Stop servers before starting the new one.
  if (singleModel) {
    // Stop ALL servers (including the same provider — it's serving a
    // different model or we need to restart it).
    await stopAllServers();
  } else if (sameProviderRunning) {
    // Multi mode: only stop the same provider if it can't serve the new
    // model on the same port (per-model strategy).
    if (spec.serveStrategy === "per-model") {
      await stopProviderServer(providerId);
      servers.delete(providerId);
    }
  }

  // Build the spawn command
  const cmd = [...spec.serveCommand];
  if (spec.serveStrategy === "per-model" && modelId) {
    cmd.push(modelId);
  }

  // Spawn as a detached process so it survives the Node process
  const child = spawn(cmd[0], cmd.slice(1), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();

  if (child.pid) {
    servers.set(providerId, {
      pid: child.pid,
      providerId,
      requestedModelId: modelId ?? null,
      modelId: modelId ?? null,
      startedAt: Date.now(),
    });
  }

  // Wait for readiness
  const ready = await waitForReady(spec.port, spec.apiPath);
  if (!ready) {
    servers.delete(providerId);
    throw new Error(
      `Server for ${spec.name} did not become ready within ${READINESS_TIMEOUT_MS / 1000}s. ` +
        `Check that \`${cmd.join(" ")}\` starts correctly.`,
    );
  }

  // For server-then-load (LM Studio), load the model after the server is up
  if (spec.serveStrategy === "server-then-load" && spec.loadCommand && modelId) {
    try {
      await execFileAsync(spec.loadCommand[0], [...spec.loadCommand.slice(1), modelId], {
        timeout: LOAD_TIMEOUT_MS,
      });
    } catch (e) {
      console.warn(`[local] load command failed for ${providerId}/${modelId}:`, e);
    }
  }

  // Query the server for the actual model name
  let servedModel = await getServedModelName(spec.port, spec.apiPath);
  if (!servedModel) {
    await sleep(1_000);
    servedModel = await getServedModelName(spec.port, spec.apiPath);
  }

  // Update the tracked model with the actual server-side name
  const entry = servers.get(providerId);
  if (entry) {
    entry.modelId = servedModel ?? modelId ?? null;
  }

  return {
    endpoint: `http://localhost:${spec.port}${spec.apiPath}`,
    alreadyRunning: false,
    servedModel: servedModel ?? modelId ?? null,
  };
}

/** Ensure a provider's server is up and able to serve `modelId`, starting
 *  it if necessary. Unlike `startServer`, this takes the fast path when a
 *  server is already running:
 *
 *  - single-server providers (Ollama) accept any installed model per
 *    request, so a running server is reused without a restart;
 *  - per-model / server-then-load providers are reused when they're already
 *    serving the requested model (matched by alias, served name, or hfRepo),
 *    and LM Studio just loads the new model into the running server;
 *  - anything else falls through to a full `startServer` (which waits for
 *    readiness before returning).
 *
 *  Safe to call before every chat request — it returns quickly when the
 *  server is already serving the model, and otherwise blocks until the
 *  server is ready, so callers never send a request to a dead endpoint.
 *
 *  Returns the endpoint and the model name the server's API expects in
 *  requests (`servedModel`), which may differ from the alias used to start
 *  the server (e.g. "mlx-community/Qwen3.5-4B-MLX-4bit" vs "qwen3.5-4b-4bit"). */
export async function ensureServing(
  providerId: string,
  modelId: string,
  hfRepo?: string,
  singleModel: boolean = true,
): Promise<{ endpoint: string; servedModel: string | null; started: boolean }> {
  const spec = getProviderSpec(providerId);
  if (!spec) throw new Error(`Unknown provider: ${providerId}`);

  const endpoint = `http://localhost:${spec.port}${spec.apiPath}`;

  if (await isPortOpen(spec.port)) {
    const tracked = servers.get(providerId);

    if (spec.serveStrategy === "single-server") {
      // Any installed model can be requested per-request — no restart needed.
      if (singleModel) await stopAllServersExcept(providerId);
      if (tracked) {
        tracked.requestedModelId = modelId;
        tracked.modelId = modelId;
      } else {
        servers.set(providerId, {
          pid: 0,
          providerId,
          requestedModelId: modelId,
          modelId,
          startedAt: Date.now(),
        });
      }
      return { endpoint, servedModel: modelId, started: false };
    }

    // Per-model / server-then-load: check whether the running server is
    // already serving the requested model.
    const served = await getServedModelName(spec.port, spec.apiPath);
    const wanted = [modelId, hfRepo]
      .filter((s): s is string => Boolean(s))
      .map((s) => s.toLowerCase());
    const matches =
      (served !== null && wanted.includes(served.toLowerCase())) ||
      (tracked !== undefined &&
        (tracked.requestedModelId === modelId ||
          (tracked.modelId !== null && wanted.includes(tracked.modelId.toLowerCase()))));

    if (matches) {
      if (singleModel) await stopAllServersExcept(providerId);
      return { endpoint, servedModel: served ?? tracked?.modelId ?? modelId, started: false };
    }

    if (spec.serveStrategy === "server-then-load" && spec.loadCommand) {
      // Server is up but a different model is loaded — load the new one
      // instead of restarting the whole server.
      if (singleModel) await stopAllServersExcept(providerId);
      try {
        await execFileAsync(spec.loadCommand[0], [...spec.loadCommand.slice(1), modelId], {
          timeout: LOAD_TIMEOUT_MS,
        });
      } catch (e) {
        console.warn(`[local] load command failed for ${providerId}/${modelId}:`, e);
      }
      const nowServed = await getServedModelName(spec.port, spec.apiPath);
      if (tracked) {
        tracked.requestedModelId = modelId;
        tracked.modelId = nowServed ?? modelId;
      }
      return { endpoint, servedModel: nowServed ?? modelId, started: false };
    }

    // per-model serving a different model → fall through to a full restart.
  }

  const result = await startServer(providerId, modelId, singleModel);
  return { endpoint: result.endpoint, servedModel: result.servedModel, started: true };
}

/** Stop a local model server. */
export async function stopServer(providerId: string): Promise<void> {
  await stopProviderServer(providerId);
  servers.delete(providerId);
}

/** Get the status of all managed servers. */
export function getServerStatus(): Record<string, { running: boolean; modelId: string | null; pid: number }> {
  const status: Record<string, { running: boolean; modelId: string | null; pid: number }> = {};
  for (const [id, srv] of servers) {
    status[id] = { running: true, modelId: srv.modelId, pid: srv.pid };
  }
  return status;
}

/** Check if a specific provider's server is running (by probing the port). */
export async function isServerRunning(providerId: string): Promise<boolean> {
  const spec = getProviderSpec(providerId);
  if (!spec) return false;
  return probeServer(spec.port, spec.apiPath);
}
