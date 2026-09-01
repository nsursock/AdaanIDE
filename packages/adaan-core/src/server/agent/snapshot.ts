import type { Workspace } from "../workspace.js";

const MAX_FILES = 200;

/**
 * Build a compact workspace snapshot (~≤1500 tokens) for injection into the
 * first LLM request of a session. This kills the common "exploration" request
 * where the model calls list_files / search_files just to orient itself.
 *
 * The snapshot includes:
 * - A flat file tree (capped at MAX_FILES entries, agent-filtered)
 * - Stack hints (package.json, pyproject.toml, Cargo.toml, etc.)
 * - A git status one-liner (branch + dirty count), best-effort
 */
export async function buildWorkspaceSnapshot(workspace: Workspace): Promise<string> {
  const lines: string[] = [];

  // --- File tree (flat, capped) ---
  try {
    const tree = await workspace.listTree("", 0, { showHidden: false, filterForAgent: true });
    const flat: string[] = [];
    const walk = (nodes: any[], prefix: string) => {
      for (const n of nodes) {
        if (flat.length >= MAX_FILES) return;
        const p = prefix ? `${prefix}/${n.name}` : n.name;
        flat.push(n.type === "dir" ? `${p}/` : p);
        if (n.type === "dir" && n.children) walk(n.children, p);
      }
    };
    walk(tree, "");
    const truncated = flat.length >= MAX_FILES ? " (truncated)" : "";
    lines.push(`Files (${flat.length}${truncated}):`);
    lines.push(flat.join("\n"));
  } catch {
    lines.push("Files: (unable to list)");
  }

  // --- Stack hints ---
  const stackHints: string[] = [];
  const checks: Record<string, string> = {
    "package.json": "Node.js / npm",
    "pyproject.toml": "Python (pyproject)",
    "setup.py": "Python (setup.py)",
    "requirements.txt": "Python (pip)",
    "Cargo.toml": "Rust",
    "go.mod": "Go",
    "pom.xml": "Java (Maven)",
    "build.gradle": "Java (Gradle)",
    "CMakeLists.txt": "C/C++ (CMake)",
    "Makefile": "Make",
    "Dockerfile": "Docker",
    ".env.example": "Env config",
  };
  for (const [file, label] of Object.entries(checks)) {
    if (await workspace.exists(file)) {
      stackHints.push(label);
    }
  }
  if (stackHints.length > 0) {
    lines.push(`Stack: ${stackHints.join(", ")}`);
  }

  // --- Git status (best-effort) ---
  try {
    const status = await workspace.gitStatus();
    if (status && status.trim()) {
      const dirtyCount = status.trim().split("\n").length;
      lines.push(`Git: ${dirtyCount} changed file(s)`);
    } else {
      lines.push("Git: clean");
    }
  } catch {
    // git may not be installed or the workspace may not be a repo — skip.
  }

  return lines.join("\n");
}
