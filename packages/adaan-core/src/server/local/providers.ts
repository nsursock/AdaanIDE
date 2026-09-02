import type { ProviderSpec } from "./types.js";

/**
 * Known local model providers. Each spec describes how to detect, list
 * models for, and serve models from that provider. The discovery module
 * checks which binaries are in PATH and uses the spec to drive the rest.
 */
export const PROVIDER_SPECS: ProviderSpec[] = [
  {
    id: "ollama",
    name: "Ollama",
    binary: "ollama",
    port: 11434,
    apiPath: "/v1",
    serveStrategy: "single-server",
    listCommand: ["ollama", "list"],
    serveCommand: ["ollama", "serve"],
    loadCommand: null,
    stopCommand: null,
    killPattern: "ollama serve",
    modelsDir: "~/.ollama/models/manifests",
  },
  {
    id: "rapid-mlx",
    name: "Rapid-MLX",
    binary: "rapid-mlx",
    port: 8000,
    apiPath: "/v1",
    serveStrategy: "per-model",
    listCommand: ["rapid-mlx", "ls"],
    serveCommand: ["rapid-mlx", "serve"],
    loadCommand: null,
    stopCommand: null,
    killPattern: "rapid-mlx serve",
    modelsDir: null, // rapid-mlx ls works without a server
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    binary: "lms",
    port: 1234,
    apiPath: "/v1",
    serveStrategy: "server-then-load",
    listCommand: null, // lms ls hangs when daemon is down — scan filesystem
    serveCommand: ["lms", "server", "start"],
    loadCommand: ["lms", "load"],
    stopCommand: ["lms", "server", "stop"],
    killPattern: "lms server",
    modelsDir: "~/.lmstudio/models",
  },
];

export function getProviderSpec(id: string): ProviderSpec | undefined {
  return PROVIDER_SPECS.find((p) => p.id === id);
}
