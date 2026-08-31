// Minimal type stub for route handlers — apps provide their own SvelteKit types
export interface RequestHandler<T = unknown> {
  (event: unknown): T | Promise<T>;
}
