import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { PROVIDER_SPECS } from "./providers.js";
import type { ProviderSpec, DiscoveredModel, DiscoveredProvider } from "./types.js";

const execFileAsync = promisify(execFile);

/** Timeout for list/CLI commands — must not hang the request if a daemon
 *  is slow to wake up (LM Studio's lms ls can take 10+ s). */
const CLI_TIMEOUT_MS = 8_000;

/** Timeout for probing a server's /v1/models endpoint. */
const PROBE_TIMEOUT_MS = 2_000;

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Check if a binary is available in PATH. */
async function isBinaryInstalled(binary: string): Promise<boolean> {
  try {
    await execFileAsync("which", [binary], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** Probe http://localhost:PORT/v1/models to check if a server is running. */
export async function probeServer(
  port: number,
  apiPath: string = "/v1",
): Promise<boolean> {
  const url = `http://localhost:${port}${apiPath}/models`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Query a running server's /v1/models endpoint and return the first
 *  model id it reports. This identifies which specific model is being
 *  served (e.g. "mlx-community/Qwen3.5-4B-MLX-4bit"), which may differ
 *  from the alias used to start the server. Returns null if the server
 *  isn't running or reports no models. */
export async function getServedModelName(
  port: number,
  apiPath: string = "/v1",
): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}${apiPath}/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    if (data.data && data.data.length > 0) {
      return data.data[0].id;
    }
  } catch {
    // server not running or unexpected response
  }
  return null;
}

// --- Model listing per provider ---------------------------------------------

/** Parse `ollama list` output:
 *    NAME            ID              SIZE      MODIFIED
 *    qwen3:14b       bdbd181c33f2    9.3 GB    4 weeks ago
 *  First column is the model id. */
function parseOllamaList(stdout: string): DiscoveredModel[] {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return [];
  // Skip header line
  const models: DiscoveredModel[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length >= 2) {
      const id = parts[0];
      // Size is "N.N UNIT" spanning columns 3-4 (e.g. "9.3 GB")
      const size = parts.length >= 4 ? `${parts[2]} ${parts[3]}` : undefined;
      models.push({ id, name: id, size });
    }
  }
  return models;
}

/** Parse `rapid-mlx ls` output:
 *    Alias                   HF repo                                Size        Modified
 *    qwen3.5-9b-4bit         mlx-community/Qwen3.5-9B-4bit          5.6 GiB     9d ago
 *  First column is the alias (model id). */
function parseRapidMlxList(stdout: string): DiscoveredModel[] {
  const lines = stdout.trim().split("\n");
  const models: DiscoveredModel[] = [];
  for (const line of lines) {
    // Skip separator lines (───) and header-ish lines
    if (line.includes("───") || line.includes("Cached models") || line.includes("Total:")) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const id = parts[0];
      // Skip lines that aren't model entries (e.g. "Tip:" lines)
      if (id === "Tip:" || id === "Alias") continue;
      // Column 2 is the HF repo (e.g. "mlx-community/Qwen3.5-4B-MLX-4bit")
      const hfRepo = parts[1];
      // Size is "N.N UNIT" spanning columns 3-4 (e.g. "5.6 GiB")
      const size = parts.length >= 5 ? `${parts[2]} ${parts[3]}` : undefined;
      models.push({ id, name: id, size, hfRepo });
    }
  }
  return models;
}

/** Scan filesystem for Ollama models when `ollama list` fails (server down).
 *  Models live at ~/.ollama/models/manifests/<registry>/<publisher>/<model>/<tag> */
function scanOllamaModels(modelsDir: string): DiscoveredModel[] {
  const root = expandHome(modelsDir);
  const models: DiscoveredModel[] = [];
  try {
    // Walk: registry / publisher / model / tag
    for (const registry of readdirSync(root)) {
      const regPath = join(root, registry);
      if (!statSync(regPath).isDirectory()) continue;
      for (const publisher of readdirSync(regPath)) {
        const pubPath = join(regPath, publisher);
        if (!statSync(pubPath).isDirectory()) continue;
        for (const model of readdirSync(pubPath)) {
          const modelPath = join(pubPath, model);
          if (!statSync(modelPath).isDirectory()) continue;
          for (const tag of readdirSync(modelPath)) {
            const tagPath = join(modelPath, tag);
            if (statSync(tagPath).isFile()) {
              // Model id is "publisher/model:tag" or just "model:tag"
              const id = publisher === "library" ? `${model}:${tag}` : `${publisher}/${model}:${tag}`;
              models.push({ id, name: id });
            }
          }
        }
      }
    }
  } catch {
    // dir doesn't exist or not readable
  }
  return models;
}

/** Scan filesystem for LM Studio models.
 *  Models live at ~/.lmstudio/models/<publisher>/<model-name>/ with a
 *  config.json inside each model dir. */
function scanLmstudioModels(modelsDir: string): DiscoveredModel[] {
  const root = expandHome(modelsDir);
  const models: DiscoveredModel[] = [];
  try {
    for (const publisher of readdirSync(root)) {
      const pubPath = join(root, publisher);
      if (!statSync(pubPath).isDirectory()) continue;
      for (const modelName of readdirSync(pubPath)) {
        const modelPath = join(pubPath, modelName);
        if (!statSync(modelPath).isDirectory()) continue;
        // Verify it's a model dir (has config.json or any model file)
        const hasConfig = existsSync(join(modelPath, "config.json"));
        if (hasConfig) {
          const id = `${publisher}/${modelName}`;
          models.push({ id, name: modelName });
        }
      }
    }
  } catch {
    // dir doesn't exist
  }
  return models;
}

/** List models for a provider, trying the CLI first then filesystem fallback. */
async function listModels(spec: ProviderSpec): Promise<DiscoveredModel[]> {
  // Try CLI list command first
  if (spec.listCommand) {
    try {
      const { stdout } = await execFileAsync(spec.listCommand[0], spec.listCommand.slice(1), {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      if (spec.id === "ollama") return parseOllamaList(stdout);
      if (spec.id === "rapid-mlx") return parseRapidMlxList(stdout);
      // Generic: first-column parse
      return stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim() && !l.includes("──"))
        .slice(1) // skip header
        .map((l) => {
          const parts = l.trim().split(/\s+/);
          return { id: parts[0], name: parts[0] };
        });
    } catch {
      // CLI failed (server down, daemon not running, etc.) — fall through
    }
  }

  // Filesystem fallback
  if (spec.modelsDir) {
    if (spec.id === "ollama") return scanOllamaModels(spec.modelsDir);
    if (spec.id === "lmstudio") return scanLmstudioModels(spec.modelsDir);
  }

  return [];
}

// --- Public API -------------------------------------------------------------

/** Discover all known local providers: check installation, list models,
 *  probe server status. Returns only providers that are installed. */
export async function discoverProviders(): Promise<DiscoveredProvider[]> {
  const results: DiscoveredProvider[] = [];

  for (const spec of PROVIDER_SPECS) {
    const installed = await isBinaryInstalled(spec.binary);
    if (!installed) {
      results.push({
        id: spec.id,
        name: spec.name,
        installed: false,
        binary: spec.binary,
        models: [],
        serverRunning: false,
        endpoint: `http://localhost:${spec.port}${spec.apiPath}`,
        port: spec.port,
        servedModel: null,
      });
      continue;
    }

    const models = await listModels(spec);
    const running = await probeServer(spec.port, spec.apiPath);
    const servedModel = running ? await getServedModelName(spec.port, spec.apiPath) : null;

    results.push({
      id: spec.id,
      name: spec.name,
      installed: true,
      binary: spec.binary,
      models,
      serverRunning: running,
      endpoint: `http://localhost:${spec.port}${spec.apiPath}`,
      port: spec.port,
      servedModel,
    });
  }

  return results;
}

/** Discover a single provider by id. */
export async function discoverProvider(id: string): Promise<DiscoveredProvider | null> {
  const spec = PROVIDER_SPECS.find((p) => p.id === id);
  if (!spec) return null;
  const installed = await isBinaryInstalled(spec.binary);
  if (!installed) {
    return {
      id: spec.id,
      name: spec.name,
      installed: false,
      binary: spec.binary,
      models: [],
      serverRunning: false,
      endpoint: `http://localhost:${spec.port}${spec.apiPath}`,
      port: spec.port,
      servedModel: null,
    };
  }
  const models = await listModels(spec);
  const running = await probeServer(spec.port, spec.apiPath);
  const servedModel = running ? await getServedModelName(spec.port, spec.apiPath) : null;
  return {
    id: spec.id,
    name: spec.name,
    installed: true,
    binary: spec.binary,
    models,
    serverRunning: running,
    endpoint: `http://localhost:${spec.port}${spec.apiPath}`,
    port: spec.port,
    servedModel,
  };
}
