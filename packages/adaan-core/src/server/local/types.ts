// ============================================================================
// Local model provider types
// ============================================================================

export type ServeStrategy =
  /** One server handles any model — the model is specified per-request.
   *  e.g. Ollama: `ollama serve` then request with `model: "qwen3:14b"`. */
  | "single-server"
  /** One server per model — the serve command takes the model as an arg.
   *  e.g. Rapid-MLX: `rapid-mlx serve qwen3.5-9b-4bit`. */
  | "per-model"
  /** Server starts without a model, then a separate command loads it.
   *  e.g. LM Studio: `lms server start` then `lms load <model>`. */
  | "server-then-load";

export interface ProviderSpec {
  id: string;
  name: string;
  /** Binary name to look up in PATH */
  binary: string;
  /** Default port the server listens on */
  port: number;
  /** API path appended to http://localhost:PORT (always "/v1") */
  apiPath: string;
  /** How the server is started */
  serveStrategy: ServeStrategy;
  /** Command to list installed/cached models (run via exec, output parsed).
   *  If null, models are discovered via filesystem scanning. */
  listCommand: string[] | null;
  /** Command to start the server. For "per-model", the model id is appended.
   *  For "server-then-load", this starts the server only. */
  serveCommand: string[];
  /** For "server-then-load" only: command to load a model after the server
   *  is up. The model id is appended. */
  loadCommand: string[] | null;
  /** Command to stop the server (if the provider has a clean stop command).
   *  If null, the process is killed by PID. */
  stopCommand: string[] | null;
  /** Pattern for `pkill -f` to kill the server process when stopCommand
   *  is null or fails. This is more reliable than killing by PID because
   *  CLI tools (rapid-mlx, etc.) fork child processes that hold the port
   *  and survive a SIGTERM to the parent. */
  killPattern: string;
  /** Directory to scan for models when listCommand fails or is null.
   *  "~" is expanded to the home directory. */
  modelsDir: string | null;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  size?: string;
  /** The full model name as reported by the server's /v1/models endpoint.
   *  May differ from `id` (e.g. id="qwen3.5-4b-4bit", hfRepo="mlx-community/Qwen3.5-4B-MLX-4bit").
   *  Used to match which model is actually being served. */
  hfRepo?: string;
}

export interface DiscoveredProvider {
  id: string;
  name: string;
  installed: boolean;
  binary: string;
  models: DiscoveredModel[];
  serverRunning: boolean;
  endpoint: string;
  port: number;
  /** The model currently being served (for per-model / server-then-load) */
  servedModel: string | null;
}
