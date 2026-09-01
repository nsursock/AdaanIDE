import type { ProviderTool } from "../../../types.js";

export const TOOL_SCHEMAS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in the workspace (or a subdirectory). Returns a flat list of relative paths. Use search_files to find specific content instead of listing everything.",
      parameters: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description: "Subdirectory to list (relative to workspace root). Defaults to root.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns content + hash. Use the hash for apply_patch/write_file. Optionally read a line range or a specific symbol.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root." },
          startLine: { type: "number", description: "Start line (1-indexed) for range reads." },
          endLine: { type: "number", description: "End line (1-indexed) for range reads." },
          symbol: { type: "string", description: "Symbol name (function/class) to read instead of full file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_symbols",
      description: "List all functions, classes, and methods in a file with their line ranges. Use before read_file to find what to read.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a text pattern across the workspace. Returns matching lines with file paths and line numbers. Supports regex.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search pattern (regex supported)." },
          glob: { type: "string", description: "File glob filter, e.g. '*.py' or '*.ts'." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a SEARCH/REPLACE patch to a file. Requires expectedHash from a prior read_file. Format: blocks of 'SEARCH\\n<original lines>\\nREPLACE\\n<new lines>' separated by '---'. Every SEARCH block MUST have a REPLACE section — to delete lines, use 'REPLACE' with nothing after it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root." },
          patch: { type: "string", description: "SEARCH/REPLACE patch blocks. Each block must have both SEARCH and REPLACE sections." },
          expectedHash: { type: "string", description: "Hash from the last read_file of this file." },
        },
        required: ["path", "patch", "expectedHash"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write full content to a file. For existing files, requires expectedHash. For new files, omit expectedHash.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root." },
          content: { type: "string", description: "Full file content." },
          expectedHash: { type: "string", description: "Hash from the last read_file (required for existing files)." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new file with the given content. Fails if the file already exists. Use this instead of write_file when creating new files — it does not require a hash.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root." },
          content: { type: "string", description: "Full file content to write. Defaults to empty string." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file. REQUIRES USER APPROVAL — the user will be prompted before deletion occurs.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Execute a shell command in the workspace root. Subject to a deny-list and 30s timeout. Returns stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          timeoutMs: { type: "number", description: "Timeout in milliseconds (default 30000)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run the project's test suite. Auto-detects the framework (pytest, npm test, etc.). Returns test output.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Optional test name filter to run specific tests." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Get git status (porcelain format) for the workspace.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Get git diff. Optionally specify a file path.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "File to diff (optional)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_checkpoint",
      description: "Create a git checkpoint commit of all current changes. Useful before making risky edits.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message." },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_rollback",
      description: "Rollback to a previous git state. Defaults to undoing the last commit.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Git ref to reset to (optional, defaults to HEAD~1)." },
        },
      },
    },
  },
];

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.function.name);
