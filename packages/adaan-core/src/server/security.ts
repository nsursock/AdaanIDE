import path from "node:path";

export type PathZone = "normal" | "sensitive" | "protected";

/**
 * Default protected directories for dependency, VCS, build, and cache artifacts.
 * Agents CANNOT read, write, list, or search inside these directories.
 */
export const PROTECTED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svelte-kit",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "target",
  "vendor",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".adaan-trash",
  ".adaan",
  ".DS_Store",
]);

/**
 * Backward compatibility alias for PROTECTED_DIRS.
 */
export const DEFAULT_IGNORE_DIRS = PROTECTED_DIRS;

/**
 * Sensitive file extensions and name patterns (Secrets / Credentials / Private Keys).
 * Agents CANNOT read content, write, or search inside these files.
 */
const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".pkcs12",
  ".keystore",
]);

const SENSITIVE_FILENAME_PATTERNS = [
  /credentials/i,
  /secrets/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /^id_dsa/i,
];

const SAFE_ENV_EXAMPLES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.schema",
  ".env.dist",
  ".env.defaults",
]);

/**
 * Classify a relative workspace path into one of three security zones:
 * - "protected": VCS internals (.git), dependencies (node_modules, .venv), build/cache dirs.
 * - "sensitive": Secrets, private keys, .env, credentials.
 * - "normal": Standard source code, tests, docs, configs, and lockfiles.
 */
export function classifyPath(relPath: string): PathZone {
  const normalized = path.normalize(relPath).replace(/^(\.\/)+/, "");
  if (!normalized || normalized === ".") return "normal";

  const segments = normalized.split(path.sep);

  // Check if any path segment matches a protected directory
  for (const seg of segments) {
    if (PROTECTED_DIRS.has(seg)) {
      return "protected";
    }
  }

  const filename = segments[segments.length - 1];
  const lowerFilename = filename.toLowerCase();

  // Check .env patterns
  if (lowerFilename === ".env" || lowerFilename.startsWith(".env.")) {
    if (SAFE_ENV_EXAMPLES.has(lowerFilename)) {
      return "normal";
    }
    return "sensitive";
  }

  // Check sensitive file extensions (.pem, .key, etc.)
  const ext = path.extname(filename).toLowerCase();
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return "sensitive";
  }

  // Check sensitive filename patterns (credentials.*, secrets.*, private keys)
  for (const pattern of SENSITIVE_FILENAME_PATTERNS) {
    if (pattern.test(filename)) {
      return "sensitive";
    }
  }

  return "normal";
}

/**
 * Assert that an agent is allowed to access a path for a given operation.
 * Throws PathAccessDeniedError if access is forbidden by policy.
 */
export function assertAgentPathAccess(
  relPath: string,
  op: "read" | "write" | "delete" | "patch" | "create" | "search" | "list"
): void {
  const zone = classifyPath(relPath);

  if (zone === "protected") {
    throw new PathAccessDeniedError(
      `Access denied: cannot ${op} protected path: ${relPath} (VCS, dependency, build, or cache zone)`
    );
  }

  if (zone === "sensitive") {
    if (op === "read") {
      throw new PathAccessDeniedError(
        `Access denied: cannot read sensitive/secret file: ${relPath}. For security, secret contents are protected from agent inspection.`
      );
    }
    if (op === "write" || op === "delete" || op === "patch" || op === "create") {
      throw new PathAccessDeniedError(
        `Access denied: cannot modify sensitive/secret file: ${relPath}. Secrets must be managed manually.`
      );
    }
    if (op === "search") {
      throw new PathAccessDeniedError(
        `Access denied: cannot search inside sensitive/secret file: ${relPath}.`
      );
    }
  }
}

/**
 * Commands that are always denied in execute_command.
 * These are catastrophic and should never be run by an agent.
 */
export const COMMAND_DENY_LIST: RegExp[] = [
  /\brm\s+-rf\s+\/(\s|$)/, // rm -rf /
  /\brm\s+-rf\s+~(\s|$)/, // rm -rf ~
  /\brm\s+-rf\s+\*(\s|$)/, // rm -rf *
  /:\(\)\{\s*:\|\s*:&\s*\};?/, // fork bomb
  /\bmkfs\b/, // format filesystem
  /\bdd\s+.*of=\/dev\//, // dd to device
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bkillall\b/,
  /\bkill\s+-9\s+1\b/,
  /\bchmod\s+-R\s+777\s+\/(\s|$)/,
  /\bcurl\s+.*\|\s*(ba)?sh/, // curl pipe to shell
  /\bwget\s+.*\|\s*(ba)?sh/, // wget pipe to shell
];

export interface SecurityOptions {
  ignoreDirs: Set<string>;
  commandDenyList: RegExp[];
  shellTimeoutMs: number;
  maxFileSize: number; // bytes — refuse to read files larger than this
  maxTreeDepth: number;
}

export const DEFAULT_SECURITY: SecurityOptions = {
  ignoreDirs: DEFAULT_IGNORE_DIRS,
  commandDenyList: COMMAND_DENY_LIST,
  shellTimeoutMs: 30_000,
  maxFileSize: 5 * 1024 * 1024, // 5 MB
  maxTreeDepth: 15,
};

/**
 * Resolve a user-supplied path relative to rootPath and verify it stays
 * within the root. Uses path.resolve + prefix check with trailing separator
 * to prevent /workspace-evil matching /workspace.
 *
 * Also rejects symlinks that resolve outside the root.
 */
export function safeResolve(rootPath: string, input: string): string {
  const resolvedRoot = path.resolve(rootPath);
  // Decode any URL-encoded traversal attempts
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // not encoded, use as-is
  }

  // Reject absolute paths (they should always be relative to root)
  if (path.isAbsolute(decoded)) {
    throw new PathSecurityError(`Absolute paths are not allowed: ${input}`);
  }

  const resolved = path.resolve(resolvedRoot, decoded);

  // Prefix check with trailing separator to avoid /workspace-evil matching /workspace
  const rootWithSep = resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) {
    throw new PathSecurityError(`Path escapes workspace root: ${input} -> ${resolved}`);
  }

  return resolved;
}

/**
 * Check that a resolved path is still within root after symlink resolution.
 * Call this on the real path if you need to detect symlink escapes.
 */
export function checkSymlinkEscape(rootPath: string, realPath: string): void {
  const resolvedRoot = path.resolve(rootPath);
  const rootWithSep = resolvedRoot + path.sep;
  if (realPath !== resolvedRoot && !realPath.startsWith(rootWithSep)) {
    throw new PathSecurityError(`Symlink escapes workspace root: ${realPath}`);
  }
}

/**
 * Check if a command is allowed (not in the deny list).
 */
export function isCommandAllowed(command: string, denyList: RegExp[] = COMMAND_DENY_LIST): boolean {
  return !denyList.some((re) => re.test(command));
}

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export class PathAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathAccessDeniedError";
  }
}

export class CommandDeniedError extends Error {
  constructor(command: string) {
    super(`Command denied by security policy: ${command}`);
    this.name = "CommandDeniedError";
  }
}
